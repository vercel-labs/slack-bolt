import fs from "node:fs";
import path from "node:path";
import { HTTPError } from "../internal/http-error";
import { log, registerSecret } from "../internal/logger";
import {
  noManifest,
  type Provisioned,
  provisionPreview,
} from "../internal/provision";
import {
  authTest,
  isTransient,
  type RotateTokenResult,
  rotateConfigToken,
  SlackAPIError,
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
        registerSecret(value);
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
 * Saves rotated tokens where the old ones were stored. Rotating revoked the
 * stored configuration token, and Slack may not accept its used refresh
 * token again, so without the new ones the project can be left with tokens
 * that don't work: try a few times.
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
    "Rotated SLACK_CONFIGURATION_TOKEN, but couldn't save the new tokens to Vercel\nThe stored SLACK_CONFIG_REFRESH_TOKEN may no longer work. Check that VERCEL_API_TOKEN can write environment variables, then generate both tokens again and save them: https://api.slack.com/apps",
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
        "Couldn't reach Slack to check SLACK_CONFIGURATION_TOKEN\nRedeploy to try again.",
        { cause: error },
      );
    }
    // Another build may have rotated the token since this one got its
    // variables. Rotating again with this build's refresh token, which that
    // build already used, can fail, and when it works it saves an older
    // refresh token over the newer one. So use the token that build saved.
    const saved = await savedConfigToken(params, 1);
    if (saved) {
      params.slackConfigurationToken = saved;
      log.success("Using the configuration token another build rotated");
      return;
    }
    if (!params.slackConfigRefreshToken) {
      throw new Error(
        "Slack refused SLACK_CONFIGURATION_TOKEN\nConfiguration tokens expire after 12 hours. Generate a new one and save it in Vercel, or set SLACK_CONFIG_REFRESH_TOKEN to have builds rotate it: https://api.slack.com/apps",
        { cause: error },
      );
    }
  }

  log.step("Rotating SLACK_CONFIGURATION_TOKEN");
  let rotated: RotateTokenResult;
  try {
    rotated = await rotateConfigToken({
      refreshToken: params.slackConfigRefreshToken,
    });
  } catch (rotateError) {
    if (isTransient(rotateError)) {
      throw new Error(
        "Couldn't reach Slack to rotate SLACK_CONFIGURATION_TOKEN\nRedeploy to try again.",
        { cause: rotateError },
      );
    }
    // Slack refused the refresh token. If that's because another build just
    // used it, that build saves its new token right after rotating, so give
    // it a moment.
    const saved = await savedConfigToken(params, SAVED_TOKEN_ATTEMPTS);
    if (!saved) {
      throw new Error(
        "Couldn't rotate SLACK_CONFIGURATION_TOKEN: Slack refused SLACK_CONFIG_REFRESH_TOKEN\nGenerate both tokens again and save them in Vercel: https://api.slack.com/apps",
        { cause: rotateError },
      );
    }
    params.slackConfigurationToken = saved;
    log.success("Using the configuration token another build rotated");
    return;
  }
  registerSecret(rotated.token, rotated.refreshToken);
  params.slackConfigurationToken = rotated.token;
  params.slackConfigRefreshToken = rotated.refreshToken;

  await saveRotatedTokens(params, rotated);
  log.success("Rotated SLACK_CONFIGURATION_TOKEN and saved it to Vercel");
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
      "Missing SLACK_CONFIGURATION_TOKEN\nGenerate a configuration token and add it to your Vercel project: https://api.slack.com/apps",
    );
  }

  if (!params.branch) {
    throw new Error(
      "VERCEL_GIT_COMMIT_REF is not set\nConnect a Git repository to your Vercel project: https://vercel.com/docs/git",
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
      "VERCEL_API_TOKEN can't access this project\nCheck that it's valid, hasn't expired, and covers the project's team: https://vercel.com/account/settings/tokens",
      { cause: error },
    );
  }

  const manifestFullPath = path.join(process.cwd(), params.manifestPath);
  if (!fs.existsSync(manifestFullPath)) {
    throw new Error(noManifest(params.manifestPath));
  }

  // Last of the checks: rotating replaces the stored tokens, and the new ones
  // can only be saved with a Vercel token that works.
  await ensureConfigToken(params);

  if (options?.cleanup) {
    log.step("Cleaning up Slack apps of inactive branches");
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
        `Cleanup failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  let result: Provisioned;
  try {
    result = await provisionPreview(params, {
      cli: true,
      currentEnv: options?.env ?? process.env,
    });
  } catch (error) {
    // Slack's own error names the API method. Say which file to fix; the
    // problems Slack found are printed under it.
    if (error instanceof SlackAPIError && error.code === "invalid_manifest") {
      throw new Error(
        `Slack rejected ${params.manifestPath}\nFix the problems below, then redeploy.`,
        { cause: error },
      );
    }
    throw error;
  }

  // This deployment was built without the variables just saved, so it needs
  // replacing: every one for a new app, or a token for an app that only now
  // got installed.
  if (result.changedEnv.length === 0) return;
  const names = result.changedEnv.join(", ");
  const them = result.changedEnv.length === 1 ? "it" : "them";

  if (!params.deploymentId) {
    log.warning(
      `Saved ${names} for ${params.branch}, but this deployment was built without ${them}`,
    );
    log.info(
      `Redeploy the branch to pick ${them} up. vercel-slack can't: VERCEL_DEPLOYMENT_ID is not set.`,
    );
    return;
  }

  // A deployment this command started already has everything saved before
  // it. If it still lacks something, another one wouldn't help, and each
  // would start the next.
  if (await startedByBuild(params, params.deploymentId)) {
    if (result.isNew) {
      throw new Error(
        `Created Slack app ${result.app.app_id}, but not redeploying again: vercel-slack already started this deployment\nThe app's variables are saved. Redeploy the branch to use it, and delete the branch's earlier app if one is left: https://api.slack.com/apps`,
      );
    }
    log.warning(
      `Saved ${names} for ${params.branch}, but this deployment was built without ${them}`,
    );
    log.info(
      `Redeploy the branch to pick ${them} up. vercel-slack already redeployed once, and doesn't again.`,
    );
    return;
  }

  log.step(`Starting a new deployment that has ${names}`);
  const { id, url } = await createDeployment({
    deploymentId: params.deploymentId,
    projectId: params.projectId,
    token: params.vercelApiToken,
    teamId: params.teamId,
    meta: { [REDEPLOY_META]: params.deploymentId },
  });
  log.success(`New deployment: ${url} (${id})`);

  // Vercel shows this one as Canceled, which looks like a failure.
  log.step("Canceling this deployment, which the new one replaces");
  await cancelDeployment({
    deploymentId: params.deploymentId,
    token: params.vercelApiToken,
    teamId: params.teamId,
  });
}
