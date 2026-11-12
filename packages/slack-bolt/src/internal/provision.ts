import fs from "node:fs";
import path from "node:path";
import type { PreviewParams, PreviewResult } from "../preview";
import { log, registerSecret } from "./logger";
import { createNewManifest } from "./manifest";
import { parseManifest, stringifyManifest } from "./manifest/parse";
import type { Manifest } from "./manifest/types";
import { installApp, removeSlackApp, upsertSlackApp } from "./slack";
import type { InstallResult } from "./slack/types";
import { addEnvironmentVariables, updateProtectionBypass } from "./vercel";
import type { CreateProjectEnv } from "./vercel/types";

/** The variables saved as Sensitive in Vercel. */
const SENSITIVE_KEYS = new Set([
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_LEVEL_TOKEN",
  "SLACK_USER_TOKEN",
]);

export type ProvisionOptions = {
  /** Print progress, as the `vercel-slack` CLI does. */
  cli?: boolean;
  /**
   * The environment the branch's current deployment was built with. A token
   * it already has isn't saved again, and `changedEnv` lists what it lacks.
   */
  currentEnv?: Record<string, string | undefined>;
};

export type Provisioned = PreviewResult & {
  /**
   * The variables saved for the branch with values `currentEnv` doesn't
   * have: what a deployment built with `currentEnv` is missing.
   */
  changedEnv: string[];
};

const MANIFEST_DOCS = "https://docs.slack.dev/reference/manifests";
const SERVICE_TOKEN_DOCS =
  "https://docs.slack.dev/authentication/tokens/#service";

/** The error for a manifest that isn't where it's expected. */
export const noManifest = (manifestPath: string) =>
  `No manifest at ${manifestPath}\nCreate one, or set MANIFEST_PATH to where yours is: ${MANIFEST_DOCS}`;

/** Reads and parses the manifest, with errors that name the file. */
function readManifest(manifestPath: string): Manifest {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(process.cwd(), manifestPath), "utf8");
  } catch (error) {
    throw new Error(noManifest(manifestPath), { cause: error });
  }

  let manifest: Manifest | null;
  try {
    manifest = parseManifest(raw, manifestPath);
  } catch (error) {
    throw new Error(`Couldn't parse ${manifestPath}`, { cause: error });
  }

  // The app's name is the one field the rewrite needs.
  const name = manifest?.display_information?.name;
  if (typeof name !== "string" || name === "") {
    throw new Error(
      `${manifestPath} has no display_information.name\nSlack requires one: ${MANIFEST_DOCS}`,
    );
  }
  return manifest as Manifest;
}

const NEW_SERVICE_TOKEN = `Generate a new SLACK_SERVICE_TOKEN: ${SERVICE_TOKEN_DOCS}`;

/** What to do about an install Slack refused, by its error code. */
const INSTALL_HINTS: Record<string, string> = {
  service_limits_exceeded:
    "The workspace is at its app limit (10 on Slack's free plan). Remove an app or upgrade, then redeploy.",
  invalid_auth: NEW_SERVICE_TOKEN,
  not_authed: NEW_SERVICE_TOKEN,
  token_expired: NEW_SERVICE_TOKEN,
  token_revoked: NEW_SERVICE_TOKEN,
  account_inactive: NEW_SERVICE_TOKEN,
};

/**
 * Why this build didn't install the app, and what to do about it. `install`
 * is the line that says where to install it by hand, when that would help.
 */
export function installAdvice(
  status: Exclude<InstallResult["status"], "installed">,
  reason: string | undefined,
  appId: string,
  install: string | undefined,
): { headline: string; details: (string | undefined)[] } {
  switch (status) {
    case "missing_service_token":
      return {
        headline: "Skipped installing the app: SLACK_SERVICE_TOKEN is not set",
        details: [
          install,
          `To have builds install it, add a service token: ${SERVICE_TOKEN_DOCS}`,
        ],
      };
    case "app_approval_request_eligible":
      return {
        headline:
          "Couldn't install the app: a workspace admin has to approve it first",
        details: ["Ask an admin to approve it, then redeploy."],
      };
    case "app_approval_request_pending":
      return {
        headline:
          "Couldn't install the app: it's waiting for a workspace admin's approval",
        details: ["Redeploy once it's approved."],
      };
    case "app_approval_request_denied":
      return {
        headline:
          "Couldn't install the app: a workspace admin denied its approval request",
        details: [],
      };
    case "no_access":
      return {
        headline: `Couldn't install the app: SLACK_SERVICE_TOKEN can't access app ${appId}`,
        details: [
          `Create the service token and the configuration token as the same Slack user: ${SERVICE_TOKEN_DOCS}`,
        ],
      };
    case "invalid_app_id":
      return {
        headline: `Couldn't install the app: Slack doesn't recognize app ${appId}`,
        details: [
          "This is likely a bug in @vercel/slack-bolt. Please report it: https://github.com/vercel-labs/slack-bolt/issues",
        ],
      };
    // Slack answered with an HTTP error, which says nothing about the app.
    case "slack_api_error":
      return {
        headline: `Couldn't install the app: Slack answered ${reason ?? "with an error"}`,
        details: ["Redeploy to try again."],
      };
    case "unknown_error":
      // Say what Slack answered, so the cause can be fixed.
      return {
        headline: `Couldn't install the app: Slack answered ${reason ?? "with an unknown error"}`,
        details: [(reason && INSTALL_HINTS[reason]) || install],
      };
  }
}

/**
 * Creates or updates the branch's Slack app, saves what the branch's
 * deployments need as environment variables, and installs the app. `preview`
 * and the `vercel-slack` CLI both run this.
 */
export async function provisionPreview(
  params: PreviewParams,
  { cli = false, currentEnv }: ProvisionOptions = {},
): Promise<Provisioned> {
  const {
    branch,
    projectId,
    deploymentUrl,
    teamId,
    commitAuthor,
    commitMessage: commitMsg,
    commitSha,
    slackAppId,
    slackConfigurationToken,
    slackServiceToken,
    manifestPath,
    vercelApiToken,
  } = params;

  const branchUrl = params.branchUrl ?? deploymentUrl;

  // Read the manifest first, so one that can't be used fails before anything
  // is created.
  // Keep every secret this run handles out of what it prints and throws.
  registerSecret(
    params.automationBypassSecret,
    slackConfigurationToken,
    slackServiceToken,
    vercelApiToken,
  );

  if (cli) log.step(`Reading manifest from ${manifestPath}`);
  const manifest = readManifest(manifestPath);

  let bypassSecret = params.automationBypassSecret;
  if (!bypassSecret) {
    if (cli) log.step("Generating automation bypass secret");
    bypassSecret = await updateProtectionBypass({
      projectId,
      token: vercelApiToken,
      teamId,
    });
    if (cli) log.success("Automation bypass secret generated");
  }
  registerSecret(bypassSecret);

  const newManifest = createNewManifest({
    originalManifest: manifest,
    branchUrl,
    bypassSecret,
    branch,
    commitSha,
    commitMessage: commitMsg,
    commitAuthor,
  });

  // write new manifest so user-land imports of manifest.json see the updated version
  fs.writeFileSync(
    path.join(process.cwd(), manifestPath),
    stringifyManifest(newManifest, manifestPath),
    "utf8",
  );
  if (cli) log.success(`Rewrote ${manifestPath} for ${branchUrl}`);

  if (cli) {
    log.step(
      slackAppId ? `Updating Slack app ${slackAppId}` : "Creating Slack app",
    );
  }
  const { isNew, app } = await upsertSlackApp({
    token: slackConfigurationToken,
    appId: slackAppId,
    manifest: newManifest,
  });
  if (isNew) {
    registerSecret(
      app.credentials?.client_secret,
      app.credentials?.signing_secret,
      app.credentials?.verification_token,
    );
  }

  const branchEnv = (key: string, value: string): CreateProjectEnv => ({
    key,
    value,
    // Sensitive variables can't be read back from Vercel, in the dashboard or
    // through the API. Nothing here reads the app's secrets or tokens again,
    // so they are stored that way. SLACK_APP_ID stays readable: cleanup needs
    // it to find the app.
    type: SENSITIVE_KEYS.has(key) ? "sensitive" : "encrypted",
    target: ["preview"],
    gitBranch: branch,
    comment: `Created by @vercel/slack-bolt for app ${app.app_id} on branch ${branch}`,
  });

  const changedEnv: string[] = [];
  const save = async (envs: CreateProjectEnv[]) => {
    if (envs.length === 0) return;
    await addEnvironmentVariables({
      projectId,
      token: vercelApiToken,
      teamId,
      envs,
    });
    for (const env of envs) {
      if (currentEnv?.[env.key] !== env.value) changedEnv.push(env.key);
    }
  };

  if (isNew) {
    const credentials: [string, string | undefined][] = [
      ["SLACK_APP_ID", app.app_id],
      ["SLACK_CLIENT_ID", app.credentials?.client_id],
      ["SLACK_CLIENT_SECRET", app.credentials?.client_secret],
      ["SLACK_SIGNING_SECRET", app.credentials?.signing_secret],
    ];
    try {
      await save(
        credentials.flatMap(([key, value]) =>
          value ? [branchEnv(key, value)] : [],
        ),
      );
    } catch (error) {
      // Without SLACK_APP_ID the branch's next build can't find this app and
      // creates another, and Slack only shows an app's secrets when it's
      // created. So take the app back out; the next build starts over.
      const removed = await removeSlackApp({
        token: slackConfigurationToken,
        appId: app.app_id,
      });
      throw new Error(
        removed.status === "failed"
          ? `Created Slack app ${app.app_id}, but couldn't save its credentials to Vercel or delete it again\nDelete it yourself, or it's left behind when the branch's next build creates another: https://api.slack.com/apps/${app.app_id}`
          : `Created Slack app ${app.app_id}, but couldn't save its credentials to Vercel, so deleted it again\nThe branch's next build creates a new one.`,
        { cause: error },
      );
    }
  }

  if (cli) {
    if (isNew && slackAppId) {
      log.info(
        `Slack has no app ${slackAppId} for this configuration token, so the branch gets a new one`,
      );
    }
    log.success(`${isNew ? "Created" : "Updated"} Slack app ${app.app_id}`);
  }

  if (cli) log.step("Installing Slack app");
  const {
    status,
    error: installError,
    botToken,
    appLevelToken,
    userToken,
  } = await installApp({
    serviceToken: slackServiceToken,
    appId: app.app_id,
    botScopes: manifest.oauth_config?.scopes?.bot ?? [],
  });
  registerSecret(botToken, appLevelToken, userToken);

  // Save the tokens on later builds too: a branch whose first install didn't
  // go through, like one waiting for approval, gets them once it does. Skip
  // the ones the branch's deployment already has.
  const tokens: [string, string | undefined][] = [
    ["SLACK_BOT_TOKEN", botToken],
    ["SLACK_APP_LEVEL_TOKEN", appLevelToken],
    ["SLACK_USER_TOKEN", userToken],
  ];
  await save(
    tokens.flatMap(([key, value]) =>
      value && (isNew || currentEnv?.[key] !== value)
        ? [branchEnv(key, value)]
        : [],
    ),
  );

  if (cli) {
    const appUrl = `https://api.slack.com/apps/${app.app_id}`;
    if (status === "installed") {
      log.success(`Installed Slack app ${app.app_id}`);
      log.info(`View app: ${appUrl}`);
    } else {
      // Slack only gives a new app's install link. A build that has a bot
      // token belongs to an app that was installed before, so it gets none.
      // Without one there's no telling: the app may be installed by hand.
      const installUrl = (isNew && app.oauth_authorize_url) || appUrl;
      const install = currentEnv?.SLACK_BOT_TOKEN
        ? undefined
        : `Install it yourself if you haven't: ${installUrl}`;
      const { headline, details } = installAdvice(
        status,
        installError,
        app.app_id,
        install,
      );
      log.warning(headline);
      for (const detail of details) if (detail) log.info(detail);
      if (!details.some((detail) => detail?.endsWith(`: ${appUrl}`))) {
        log.info(`View app: ${appUrl}`);
      }
    }
  }

  return {
    isNew,
    installStatus: status,
    ...(installError && { installError }),
    app,
    changedEnv,
  };
}
