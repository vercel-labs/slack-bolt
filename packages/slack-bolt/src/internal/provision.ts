import fs from "node:fs";
import path from "node:path";
import type { PreviewParams, PreviewResult } from "../preview";
import { log } from "./logger";
import { createNewManifest } from "./manifest";
import { parseManifest, stringifyManifest } from "./manifest/parse";
import type { Manifest } from "./manifest/types";
import { installApp, removeSlackApp, upsertSlackApp } from "./slack";
import { addEnvironmentVariables, updateProtectionBypass } from "./vercel";
import type { CreateProjectEnv } from "./vercel/types";

/** The variables saved as Sensitive in Vercel. */
const SENSITIVE_KEYS = new Set(["SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"]);

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

/** Reads and parses the manifest, with errors that name the file. */
function readManifest(manifestPath: string): Manifest {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(process.cwd(), manifestPath), "utf8");
  } catch (error) {
    throw new Error(
      `No manifest found at ${manifestPath}. Create a manifest.json (or manifest.yaml) file with your Slack app configuration:\nhttps://docs.slack.dev/reference/manifests`,
      { cause: error },
    );
  }

  let manifest: Manifest | null;
  try {
    manifest = parseManifest(raw, manifestPath);
  } catch (error) {
    throw new Error(`Couldn't parse the manifest at ${manifestPath}.`, {
      cause: error,
    });
  }

  // The app's name is the one field the rewrite needs.
  const name = manifest?.display_information?.name;
  if (typeof name !== "string" || name === "") {
    throw new Error(
      `The manifest at ${manifestPath} needs a display_information.name:\nhttps://docs.slack.dev/reference/manifests`,
    );
  }
  return manifest as Manifest;
}

/** What to tell the user about an install Slack refused, by its error code. */
const INSTALL_HINTS: Record<string, string> = {
  service_limits_exceeded:
    "The workspace has reached its app limit, which is 10 on Slack's free plan. Remove an app from the workspace or upgrade it, then redeploy.",
  invalid_auth:
    "Slack refused SLACK_SERVICE_TOKEN. Generate a new one:\nhttps://docs.slack.dev/authentication/tokens/#service",
  token_expired:
    "SLACK_SERVICE_TOKEN has expired. Generate a new one:\nhttps://docs.slack.dev/authentication/tokens/#service",
  token_revoked:
    "SLACK_SERVICE_TOKEN was revoked. Generate a new one:\nhttps://docs.slack.dev/authentication/tokens/#service",
};

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
  if (cli) log.success(`Manifest updated for ${branchUrl}`);

  if (cli) log.step("Creating or updating Slack app");
  const { isNew, app } = await upsertSlackApp({
    token: slackConfigurationToken,
    appId: slackAppId,
    manifest: newManifest,
  });

  const branchEnv = (key: string, value: string): CreateProjectEnv => ({
    key,
    value,
    // Sensitive variables can't be read back from Vercel, in the dashboard or
    // through the API. Nothing here reads the app's secrets again, so they
    // are stored that way. SLACK_APP_ID stays readable: cleanup needs it to
    // find the app.
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
          ? `Created Slack app ${app.app_id}, but couldn't save its credentials to Vercel or delete it again. Delete it yourself, or it stays behind when the branch's next build creates another:\nhttps://api.slack.com/apps/${app.app_id}`
          : `Created Slack app ${app.app_id}, but couldn't save its credentials to Vercel, so deleted it again. The branch's next build creates a new one.`,
        { cause: error },
      );
    }
  }

  if (cli)
    log.success(`${isNew ? "Created" : "Updated"} Slack app ${app.app_id}`);

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
    switch (status) {
      case "missing_service_token":
        log.warning(
          "SLACK_SERVICE_TOKEN is not set — app must be installed manually",
        );
        log.info("https://docs.slack.dev/authentication/tokens/#service");
        break;
      case "installed":
        log.success(`Installed Slack app ${app.app_id}`);
        break;
      case "app_approval_request_eligible":
        log.warning("App requires approval before it can be installed");
        break;
      case "app_approval_request_pending":
        log.warning("App is pending approval before it can be installed");
        break;
      case "app_approval_request_denied":
        log.warning("App approval request was denied");
        break;
      case "no_access":
        log.warning(
          `SLACK_SERVICE_TOKEN does not have access to app ${app.app_id}. ` +
            "This usually means the service token and configuration token were created by different users. " +
            "Ensure both tokens are generated by the same Slack user.\n" +
            "https://docs.slack.dev/authentication/tokens/#service",
        );
        break;
      case "invalid_app_id":
        log.warning(
          "Invalid app ID. This is a bug in the @vercel/slack-bolt package. Please open an issue at https://github.com/vercel-labs/slack-bolt/issues",
        );
        break;
      case "slack_api_error":
      case "unknown_error": {
        // Say what Slack answered, so the app can be installed by hand or
        // the cause fixed.
        const reason = installError ?? "unknown error";
        log.warning(
          `Slack didn't install the app: ${reason} — app must be installed manually`,
        );
        const hint = INSTALL_HINTS[reason];
        if (hint) log.info(hint);
        break;
      }
    }
    console.log();
    if (app.app_id) {
      log.info(`View app: https://api.slack.com/apps/${app.app_id}`);
    }
    if (isNew && app.oauth_authorize_url) {
      log.info(`Install URL: ${app.oauth_authorize_url}`);
    }
    console.log();
  }

  return {
    isNew,
    installStatus: status,
    ...(installError && { installError }),
    app,
    changedEnv,
  };
}
