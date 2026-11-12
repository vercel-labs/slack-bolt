import fs from "node:fs";
import path from "node:path";
import { HTTPError } from "../internal/http-error";
import { log } from "../internal/logger";
import { provisionPreview } from "../internal/provision";
import {
  authTest,
  isTransient,
  type RotateTokenResult,
  rotateConfigToken,
} from "../internal/slack";
import {
  addEnvironmentVariables,
  cancelDeployment,
  createDeployment,
  getDeploymentMeta,
  getEnvironmentVariable,
  getEnvironmentVariables,
  getProject,
} from "../internal/vercel";
import type {
  CreateProjectEnv,
  EnvironmentVariable,
} from "../internal/vercel/types";
import { wait } from "../internal/wait";
import type { PreviewParams } from "../preview";
import { cleanupOrphanedApps } from "./cleanup";

const CONFIG_TOKEN = "SLACK_CONFIGURATION_TOKEN";
const REFRESH_TOKEN = "SLACK_CONFIG_REFRESH_TOKEN";

/**
 * Metadata on a deployment `vercel-slack build` started, naming the
 * deployment it replaces.
 */
export const REDEPLOY_META = "vercelSlackRedeployOf";

/** How often, and how far apart, to look for a token another build rotated. */
const SAVED_TOKEN_ATTEMPTS = 5;
const SAVED_TOKEN_WAIT_MS = 1500;

/** How often, and how far apart, to try saving rotated tokens. */
const SAVE_ATTEMPTS = 3;
const SAVE_WAIT_MS = 1000;

type VercelAccess = Pick<PreviewParams, "projectId" | "vercelApiToken"> & {
  teamId?: string;
};

const vercelAccess = (params: PreviewParams) => ({
  projectId: params.projectId,
  token: params.vercelApiToken,
  teamId: params.teamId,
});

/**
 * The configuration token another build saved after rotating it: one in the
 * Vercel project that isn't the token this build started with, and that Slack
 * accepts. A build gets its variables when its deployment is created, so one
 * that waited in the queue, like the last of a batch of Dependabot pull
 * requests, still has the expired token after an earlier build replaced it.
 */
async function savedConfigToken(
  params: PreviewParams,
  attempts: number,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await wait(SAVED_TOKEN_WAIT_MS);
    try {
      const envs = await getEnvironmentVariables(vercelAccess(params));
      for (const env of envs) {
        if (env.key !== CONFIG_TOKEN || env.gitBranch) continue;
        if (env.target && !env.target.includes("preview")) continue;
        const value = await getEnvironmentVariable({
          ...vercelAccess(params),
          envId: env.id,
        });
        if (!value || value === params.slackConfigurationToken) continue;
        await authTest({ token: value });
        return value;
      }
    } catch {
      // Not saved yet, or not a token Slack accepts: look again.
    }
  }
  return undefined;
}

/**
 * Saves rotated tokens where the old ones were stored. Slack stops accepting
 * the stored refresh token soon after it's used, so without the new one the
 * project is left with tokens that don't work: try a few times.
 */
async function saveRotatedTokens(
  params: PreviewParams,
  rotated: RotateTokenResult,
): Promise<void> {
  // Keep each variable's environments and type: rotating shouldn't copy a
  // token kept to Preview into Production, or make a Sensitive one readable.
  let stored: EnvironmentVariable[] = [];
  try {
    stored = await getEnvironmentVariables(vercelAccess(params));
  } catch {
    // Save them for every environment, as before.
  }
  const values: [string, string][] = [
    [CONFIG_TOKEN, rotated.token],
    [REFRESH_TOKEN, rotated.refreshToken],
  ];
  const envs = values.flatMap(([key, value]): CreateProjectEnv[] => {
    const existing = stored.filter(
      (env) => env.key === key && !env.gitBranch && env.target?.length,
    );
    if (existing.length === 0) {
      return [
        {
          key,
          value,
          type: "encrypted",
          target: ["production", "preview", "development"],
        },
      ];
    }
    return existing.map((env) => ({
      key,
      value,
      type: env.type === "sensitive" ? "sensitive" : "encrypted",
      target: env.target,
    }));
  });

  let failure: unknown;
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    if (attempt > 0) await wait(SAVE_WAIT_MS);
    try {
      await addEnvironmentVariables({ ...vercelAccess(params), envs });
      return;
    } catch (error) {
      failure = error;
      // Vercel refused the request itself, so asking again won't help.
      if (
        error instanceof HTTPError &&
        error.status < 500 &&
        error.status !== 429
      ) {
        break;
      }
    }
  }
  // Slack has issued new tokens by now, so say that saving them failed, not
  // that the refresh token was bad.
  throw new Error(
    "Rotated the Slack configuration token, but couldn't save the new tokens to your Vercel project, so the stored SLACK_CONFIG_REFRESH_TOKEN may no longer work. Check that VERCEL_API_TOKEN can write environment variables, then generate new tokens and update SLACK_CONFIGURATION_TOKEN and SLACK_CONFIG_REFRESH_TOKEN:\nhttps://api.slack.com/apps",
    { cause: failure },
  );
}

/** Checks the configuration token, and rotates it when Slack refuses it. */
async function ensureConfigToken(params: PreviewParams): Promise<void> {
  try {
    await authTest({ token: params.slackConfigurationToken });
    return;
  } catch (error) {
    // An outage says nothing about the token, and rotating spends the
    // refresh token, so don't rotate a token that may be fine.
    if (isTransient(error)) {
      throw new Error(
        "Couldn't reach Slack to check SLACK_CONFIGURATION_TOKEN. Redeploy to try again.",
        { cause: error },
      );
    }
    // Each rotation revokes older tokens, and Slack keeps a used refresh
    // token working only for a short grace period. So use a token another
    // build already rotated before rotating again.
    const saved = await savedConfigToken(params, 1);
    if (saved) {
      params.slackConfigurationToken = saved;
      log.success("Using the configuration token another build rotated");
      return;
    }
    if (!params.slackConfigRefreshToken) {
      throw new Error(
        "Slack configuration token is invalid or expired. Provide SLACK_CONFIG_REFRESH_TOKEN for automatic rotation, or generate a new token:\nhttps://api.slack.com/apps",
        { cause: error },
      );
    }
  }

  log.step("Refreshing SLACK_CONFIGURATION_TOKEN");
  let rotated: RotateTokenResult;
  try {
    rotated = await rotateConfigToken({
      refreshToken: params.slackConfigRefreshToken,
    });
  } catch (rotateError) {
    if (isTransient(rotateError)) {
      throw new Error(
        "Couldn't reach Slack to rotate SLACK_CONFIGURATION_TOKEN. Redeploy to try again.",
        { cause: rotateError },
      );
    }
    // Slack refused the refresh token, as it does once another build has
    // used it and the grace period is over. That build saves its new token
    // right after rotating, so give it a moment.
    const saved = await savedConfigToken(params, SAVED_TOKEN_ATTEMPTS);
    if (!saved) {
      throw new Error(
        "Failed to rotate configuration token — refresh token may be invalid. Generate new tokens:\nhttps://api.slack.com/apps",
        { cause: rotateError },
      );
    }
    params.slackConfigurationToken = saved;
    log.success("Using the configuration token another build rotated");
    return;
  }
  params.slackConfigurationToken = rotated.token;
  params.slackConfigRefreshToken = rotated.refreshToken;

  await saveRotatedTokens(params, rotated);
  log.success("Configuration token rotated and persisted");
}

/**
 * Whether `vercel-slack build` started this deployment. A redeploy copies its
 * source's metadata, our mark included, so the mark only counts when it names
 * the deployment this one was made from.
 */
async function startedByBuild(
  access: VercelAccess,
  deploymentId: string,
): Promise<boolean> {
  try {
    const meta = await getDeploymentMeta({
      deploymentId,
      token: access.vercelApiToken,
      teamId: access.teamId,
    });
    const source = meta[REDEPLOY_META];
    return (
      !!source &&
      (!meta.originalDeploymentId || meta.originalDeploymentId === source)
    );
  } catch {
    // Can't tell, so deploy again as usual.
    return false;
  }
}

export async function executeBuild(
  params: PreviewParams,
  options?: {
    cleanup?: boolean;
    /** The build's environment, with the CLI's flags applied. */
    env?: Record<string, string | undefined>;
  },
): Promise<void> {
  if (!params.slackConfigurationToken) {
    throw new Error(
      "Slack Configuration Token is not set. Generate a configuration token and add it as SLACK_CONFIGURATION_TOKEN in your Vercel project:\nhttps://api.slack.com/apps",
    );
  }

  await ensureConfigToken(params);

  if (params.slackServiceToken) {
    try {
      await authTest({ token: params.slackServiceToken });
    } catch (error) {
      log.warning(
        "SLACK_SERVICE_TOKEN is invalid — app must be installed manually",
      );
      log.info("https://docs.slack.dev/authentication/tokens/#service");
      log.debug(error);
    }
  }

  if (!params.branch) {
    throw new Error(
      "VERCEL_GIT_COMMIT_REF is not set — connect your Git repository in your Vercel project settings.\nhttps://vercel.com/docs/git",
    );
  }

  try {
    await getProject({
      projectId: params.projectId,
      token: params.vercelApiToken,
      teamId: params.teamId,
    });
  } catch (error) {
    throw new Error(
      "Vercel API token cannot access this project. Ensure VERCEL_API_TOKEN is valid and has access to this team:\nhttps://vercel.com/account/settings/tokens",
      { cause: error },
    );
  }

  const manifestFullPath = path.join(process.cwd(), params.manifestPath);
  if (!fs.existsSync(manifestFullPath)) {
    throw new Error(
      `No manifest found at ${params.manifestPath}. Create a manifest.json (or manifest.yaml) file with your Slack app configuration:\nhttps://docs.slack.dev/reference/manifests`,
    );
  }

  if (options?.cleanup) {
    log.step("Cleaning up orphaned preview apps");
    try {
      await cleanupOrphanedApps({
        projectId: params.projectId,
        currentBranch: params.branch,
        vercelApiToken: params.vercelApiToken,
        teamId: params.teamId,
        slackConfigurationToken: params.slackConfigurationToken,
      });
    } catch (error) {
      log.warning(
        `Orphan cleanup failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const result = await provisionPreview(params, {
    cli: true,
    currentEnv: options?.env ?? process.env,
  });

  // This deployment was built without the variables just saved, so it needs
  // replacing: every one for a new app, or a token for an app that only now
  // got installed.
  if (result.changedEnv.length === 0) return;
  const saved = `Saved ${result.changedEnv.join(", ")} for ${params.branch}`;

  if (!params.deploymentId) {
    log.warning(
      `${saved}, but VERCEL_DEPLOYMENT_ID isn't set, so this deployment can't be replaced. They apply from the branch's next deployment.`,
    );
    return;
  }

  // A deployment this command started already has everything saved before
  // it. If it still lacks something, another one wouldn't help, and each
  // would start the next.
  if (await startedByBuild(params, params.deploymentId)) {
    if (result.isNew) {
      throw new Error(
        `vercel-slack started this deployment to pick up the branch's Slack app, but it didn't get the app's SLACK_APP_ID, and created another app (${result.app.app_id}). Stopping here instead of deploying again. Check the branch's SLACK_APP_ID in your Vercel project's environment variables, then redeploy.`,
      );
    }
    log.warning(
      `${saved}, but this deployment already replaced one for the same reason. They apply from the branch's next deployment.`,
    );
    return;
  }

  log.step("Creating new deployment to pick up new environment variables");
  const { id, url } = await createDeployment({
    deploymentId: params.deploymentId,
    projectId: params.projectId,
    token: params.vercelApiToken,
    teamId: params.teamId,
    meta: { [REDEPLOY_META]: params.deploymentId },
  });
  log.success(`New deployment created: ${url} (${id})`);

  log.step("Cancelling current deployment");
  await cancelDeployment({
    deploymentId: params.deploymentId,
    token: params.vercelApiToken,
    teamId: params.teamId,
  });
}
