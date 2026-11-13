import type { Installation, PreviewApp } from "../preview";
import type { PreviewContext } from "./context";
import { replaceDeployment } from "./deploy";
import {
  isAppUnreachable,
  isTokenRefused,
  isTransient,
  messageOf,
  problem,
  RETRY,
  SlackError,
} from "./errors";
import type { Log } from "./log";
import { loadManifest, previewManifest } from "./manifest";
import {
  APP_ID,
  appIdOf,
  listVariables,
  TOKEN_KEYS,
  variable,
  variablesOf,
} from "./records";
import {
  type AppTokens,
  type CreatedApp,
  createSlack,
  type Slack,
} from "./slack";
import { usableConfigToken } from "./tokens";
import { createVercel } from "./vercel";

const SETTINGS = "https://api.slack.com/apps";
const SERVICE_TOKEN_DOCS =
  "https://docs.slack.dev/authentication/tokens/#service";

type NotInstalled = Extract<Installation, { installed: false }>;

/** Slack's codes for an app that waits on a workspace admin. */
const APPROVAL: Record<
  string,
  { reason: NotInstalled["reason"]; why: string; next?: string }
> = {
  app_approval_request_eligible: {
    reason: "approval_required",
    why: "a workspace admin has to approve it first",
    next: "Ask an admin to approve it, then redeploy.",
  },
  app_approval_request_pending: {
    reason: "approval_pending",
    why: "it's waiting for a workspace admin's approval",
    next: "Redeploy once it's approved.",
  },
  app_approval_request_denied: {
    reason: "approval_denied",
    why: "a workspace admin denied its approval request",
  },
};

/** An error for a manifest call Slack refused, saying what to do about it. */
function appFailure(error: unknown, action: string, from: string): Error {
  if (error instanceof SlackError && error.code === "invalid_manifest") {
    const found = error.problems
      .map(({ pointer, message }) =>
        [pointer, message].filter(Boolean).join(": "),
      )
      .filter(Boolean)
      .map((line) => `\n- ${line}`)
      .join("");
    return problem(
      `Slack rejected ${from}${found}`,
      "Fix the manifest, then redeploy.",
      error,
    );
  }
  return problem(
    `Couldn't ${action}: ${messageOf(error)}`,
    error instanceof SlackError && !isTransient(error)
      ? `Slack describes its error codes at https://docs.slack.dev/reference/methods/${error.method}`
      : RETRY,
    error,
  );
}

/**
 * Installs the app in the service token's workspace, and says how it went.
 * Never throws: an app that couldn't be installed still exists, and can be
 * installed by hand.
 */
async function install(
  slack: Slack,
  log: Log,
  app: {
    id: string;
    created: boolean;
    installUrl: string;
    botScopes: string[];
  },
  serviceToken: string | undefined,
): Promise<{ installation: Installation; tokens: AppTokens }> {
  const failed = (installation: NotInstalled) => ({ installation, tokens: {} });

  if (!serviceToken) {
    // Said once, when the app is new: later builds can't tell whether
    // someone has installed it since.
    if (app.created) {
      log.warn("The app isn't installed: SLACK_SERVICE_TOKEN is not set");
      log.note(`Install it: ${app.installUrl}`);
      log.note(
        `To have builds install it, add a service token: ${SERVICE_TOKEN_DOCS}`,
      );
    }
    return failed({ installed: false, reason: "no_service_token" });
  }

  let error: unknown;
  try {
    const tokens = await slack.install(serviceToken, app.id, app.botScopes);
    log.ok("Installed the app in the workspace");
    return { installation: { installed: true }, tokens };
  } catch (caught) {
    error = caught;
  }

  if (!(error instanceof SlackError) || isTransient(error)) {
    log.warn(`Couldn't install the app: ${messageOf(error)}`);
    log.note(RETRY);
    return failed({ installed: false, reason: "unavailable" });
  }

  const waiting = APPROVAL[error.code];
  if (waiting) {
    log.warn(`The app isn't installed: ${waiting.why}`);
    if (waiting.next) log.note(waiting.next);
    return failed({ installed: false, reason: waiting.reason });
  }

  // The app was just created or updated, so it exists. Slack answers
  // `invalid_app_id` for an app the service token's user can't see.
  if (
    error.code === "invalid_app_id" &&
    !(await slack.appExists(serviceToken, app.id).catch(() => false))
  ) {
    log.warn(
      `The app isn't installed: SLACK_SERVICE_TOKEN's user can't see app ${app.id}`,
    );
    log.note(
      `Create the service token and the configuration token as the same Slack user: ${SERVICE_TOKEN_DOCS}`,
    );
    return failed({ installed: false, reason: "no_access" });
  }

  log.warn(`Couldn't install the app: ${messageOf(error)}`);
  log.note(
    isTokenRefused(error)
      ? `Generate a new SLACK_SERVICE_TOKEN: ${SERVICE_TOKEN_DOCS}`
      : `Install it yourself: ${app.installUrl}`,
  );
  return failed({ installed: false, reason: "refused", code: error.code });
}

/**
 * Sets up a branch's preview app: creates it, or updates the one the branch
 * has, saves what its deployments need, installs it, and replaces this
 * deployment when it was built without any of that.
 */
export async function provision(ctx: PreviewContext): Promise<PreviewApp> {
  const { log, branch, env } = ctx;

  // Before any request, so a manifest that can't be used changes nothing.
  const { manifest: source, from } = loadManifest(ctx.manifest, ctx.cwd);

  const slack = createSlack(log);
  const vercel = createVercel({
    token: ctx.vercelToken,
    projectId: ctx.projectId,
    teamId: ctx.teamId,
    log,
  });

  // Vercel first: rotating the configuration token spends its refresh token,
  // and the new pair can only be saved with a Vercel token that works.
  const envs = await listVariables(vercel);
  const stored = variablesOf(envs, branch);
  const configToken = await usableConfigToken({
    slack,
    vercel,
    log,
    envs,
    environment: ctx.environment,
    token: ctx.slackConfigToken,
    refreshToken: ctx.slackConfigRefreshToken,
  });

  const record = stored.find((item) => item.key === APP_ID);
  let appId: string | undefined;
  if (record) {
    let shown: string | null;
    try {
      shown = await appIdOf(vercel, record);
    } catch (error) {
      throw problem(
        `Couldn't read ${branch}'s ${APP_ID} from Vercel: ${messageOf(error)}`,
        RETRY,
        error,
      );
    }
    // A Sensitive value isn't shown, but a deployment created since the
    // variable was saved has it.
    appId = shown ?? (env[APP_ID] || undefined);
    if (!appId) {
      // A second app would leave the first with nothing pointing at it.
      throw problem(
        `Vercel doesn't show the value of ${branch}'s ${APP_ID}, and this deployment was built without it`,
        `Redeploy the branch. If that doesn't help, delete the branch's SLACK_ variables in Vercel and its app (${SETTINGS}) to start over.`,
      );
    }
  }

  let bypassSecret = ctx.bypassSecret;
  if (!bypassSecret) {
    try {
      bypassSecret = await vercel.createBypassSecret();
    } catch (error) {
      throw problem(
        `Couldn't create a Protection Bypass for Automation secret: ${messageOf(error)}`,
        "Create one in the project's Deployment Protection settings, then redeploy.",
        error,
      );
    }
    log.ok(
      "Created a Protection Bypass for Automation secret, so Slack can reach protected previews",
    );
  }

  const manifest = previewManifest(source, {
    host: ctx.host,
    branch,
    bypassSecret,
    commit: ctx.commit,
  });
  const name = manifest.display_information.name;

  /** The names of the variables this run saved. */
  const saved: string[] = [];
  const save = async (
    id: string,
    values: [string, string | undefined][],
  ): Promise<void> => {
    const variables = values.flatMap(([key, value]) =>
      value
        ? [variable(key, value, { id, branch, sensitive: ctx.sensitive })]
        : [],
    );
    await vercel.saveEnv(variables);
    saved.push(...variables.map((item) => item.key));
  };

  // A branch's app is only ever replaced when Slack says this token can't
  // manage it: it was deleted, or belongs to another user. An outage, a
  // refused token, a rejected manifest or an answer this code doesn't know
  // all stop the run instead, and the next one tries again.
  let replaced: string | undefined;
  if (appId) {
    try {
      await slack.updateApp(configToken, appId, manifest);
      log.ok(`Updated Slack app ${appId} (${name})`);
    } catch (error) {
      if (!isAppUnreachable(error)) {
        throw appFailure(error, `update Slack app ${appId}`, from);
      }
      replaced = appId;
      appId = undefined;
    }
  }

  let created: CreatedApp | undefined;
  if (!appId) {
    try {
      created = await slack.createApp(configToken, manifest);
    } catch (error) {
      throw appFailure(error, "create the Slack app", from);
    }
    appId = created.id;

    try {
      await save(appId, [
        [APP_ID, appId],
        ["SLACK_CLIENT_ID", created.clientId],
        ["SLACK_CLIENT_SECRET", created.clientSecret],
        ["SLACK_SIGNING_SECRET", created.signingSecret],
      ]);
    } catch (error) {
      // Slack shows an app's secrets once, when it's created, and
      // SLACK_APP_ID is how the branch's next run finds the app. Unsaved,
      // the app can't be used and nothing points at it, so take it back out.
      const removed = await slack.deleteApp(configToken, appId).then(
        () => true,
        () => false,
      );
      throw problem(
        `Created Slack app ${appId}, but couldn't save its variables to Vercel: ${messageOf(error)}`,
        removed
          ? "Deleted the app again. Check that VERCEL_API_TOKEN can write environment variables, then redeploy."
          : `Couldn't delete the app again either. Delete it yourself: ${SETTINGS}/${appId}`,
        error,
      );
    }
    log.ok(`Created Slack app ${appId} (${name})`);
    if (replaced) {
      log.note(
        `Slack app ${replaced} is deleted or belongs to another Slack user, so the branch has a new one.`,
      );
    }

    // Tokens the branch still has belong to an app it had before.
    const stale = stored.filter((item) => TOKEN_KEYS.includes(item.key));
    try {
      await vercel.deleteEnv(stale.map((item) => item.id));
    } catch (error) {
      log.warn(
        `Couldn't delete the tokens of the branch's earlier app (${stale.map((item) => item.key).join(", ")}): ${messageOf(error)}`,
      );
    }
  }

  const installUrl =
    created?.installUrl ?? `${SETTINGS}/${appId}/install-on-team`;
  const { installation, tokens } = await install(
    slack,
    log,
    {
      id: appId,
      created: created !== undefined,
      installUrl,
      botScopes: manifest.oauth_config?.scopes?.bot ?? [],
    },
    ctx.slackServiceToken,
  );

  // A new app's tokens are always saved. An existing app's are saved when
  // this deployment doesn't have them: its first install may not have gone
  // through, like one that waited for an admin's approval.
  const fresh: [string, string | undefined][] = [
    ["SLACK_BOT_TOKEN", tokens.bot],
    ["SLACK_APP_LEVEL_TOKEN", tokens.appLevel],
    ["SLACK_USER_TOKEN", tokens.user],
  ];
  try {
    await save(
      appId,
      fresh.filter(([key, value]) => created || env[key] !== value),
    );
  } catch (error) {
    throw problem(
      `Installed Slack app ${appId}, but couldn't save its tokens to Vercel: ${messageOf(error)}`,
      RETRY,
      error,
    );
  }
  if (saved.length > 0) log.ok(`Saved ${saved.join(", ")} for ${branch}`);

  const result: PreviewApp = {
    status: "ready",
    branch,
    app: {
      id: appId,
      name,
      created: created !== undefined,
      ...(replaced && { replaced }),
      url: `${SETTINGS}/${appId}`,
      installUrl,
    },
    installation,
    saved,
  };
  if (!ctx.deploymentId) return result;

  // What the branch has that this deployment was built without: everything
  // just saved, and all of an existing app's variables when the deployment
  // is older than they are.
  const missing = new Set(saved);
  if (!created && env[APP_ID] !== appId) {
    for (const item of stored) missing.add(item.key);
  }
  if (missing.size === 0) return result;

  const deployment = await replaceDeployment(
    vercel,
    ctx.deploymentId,
    [...missing],
    log,
  );
  return deployment
    ? { ...result, status: "redeployed", deployment }
    : { ...result, status: "outdated" };
}
