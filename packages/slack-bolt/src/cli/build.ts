import fs from "node:fs";
import path from "node:path";
import { cleanupOrphanedApps } from "../cleanup";
import { authTest, rotateConfigToken } from "../internal/slack";
import {
  addEnvironmentVariables,
  cancelDeployment,
  createDeployment,
  getProject,
} from "../internal/vercel";
import { log } from "../logger";
import { type PreviewParams, preview } from "../preview";

export async function executeBuild(
  params: PreviewParams,
  options?: { cleanup?: boolean },
): Promise<void> {
  if (!params.slackConfigurationToken) {
    throw new Error(
      "Slack Configuration Token is not set. Generate a configuration token and add it as SLACK_CONFIGURATION_TOKEN in your Vercel project:\nhttps://api.slack.com/apps",
    );
  }

  try {
    await authTest({ token: params.slackConfigurationToken });
  } catch (error) {
    if (!params.slackConfigRefreshToken) {
      throw new Error(
        "Slack configuration token is invalid or expired. Provide SLACK_CONFIG_REFRESH_TOKEN for automatic rotation, or generate a new token:\nhttps://api.slack.com/apps",
        { cause: error },
      );
    }

    log.step("Refreshing SLACK_CONFIGURATION_TOKEN");
    try {
      const rotated = await rotateConfigToken({
        refreshToken: params.slackConfigRefreshToken,
      });
      params.slackConfigurationToken = rotated.token;
      params.slackConfigRefreshToken = rotated.refreshToken;

      await addEnvironmentVariables({
        projectId: params.projectId,
        token: params.vercelApiToken,
        teamId: params.teamId,
        envs: [
          {
            key: "SLACK_CONFIGURATION_TOKEN",
            value: rotated.token,
            type: "encrypted",
            target: ["production", "preview", "development"],
          },
          {
            key: "SLACK_CONFIG_REFRESH_TOKEN",
            value: rotated.refreshToken,
            type: "encrypted",
            target: ["production", "preview", "development"],
          },
        ],
      });
      log.success("Configuration token rotated and persisted");
    } catch (rotateError) {
      throw new Error(
        "Failed to rotate configuration token — refresh token may be invalid. Generate new tokens:\nhttps://api.slack.com/apps",
        { cause: rotateError },
      );
    }
  }

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

  const result = await preview(params, "cli");

  if (result.isNew && params.deploymentId) {
    log.step("Creating new deployment to pick up new environment variables");
    const { id, url } = await createDeployment({
      deploymentId: params.deploymentId,
      projectId: params.projectId,
      token: params.vercelApiToken,
      teamId: params.teamId,
    });
    log.success(`New deployment created: ${url} (${id})`);

    log.step("Cancelling current deployment");
    await cancelDeployment({
      deploymentId: params.deploymentId,
      token: params.vercelApiToken,
      teamId: params.teamId,
    });
  }
}
