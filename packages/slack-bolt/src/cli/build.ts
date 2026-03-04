import { WebClient } from "@slack/web-api";
import {
  cancelDeployment,
  createDeployment,
  getAuthUser,
} from "../internal/vercel";
import { log, logger } from "../logger";
import { type PreviewParams, preview } from "../preview";

export async function executeBuild(
  params: PreviewParams,
  version: string,
): Promise<void> {
  if (!params.slackConfigurationToken) {
    throw new Error(
      "Slack Configuration Token is not set. Generate a configuration token and add it as SLACK_CONFIGURATION_TOKEN in your Vercel project:\nhttps://api.slack.com/apps",
    );
  }

  try {
    await new WebClient(params.slackConfigurationToken).auth.test();
  } catch (error) {
    throw new Error(
      "Slack configuration token is invalid or expired. Generate a new configuration token and add it as SLACK_CONFIGURATION_TOKEN in your Vercel project:\nhttps://api.slack.com/apps",
      { cause: error },
    );
  }

  if (params.slackServiceToken) {
    try {
      await new WebClient(params.slackServiceToken).auth.test();
    } catch (error) {
      log.warning(
        "SLACK_SERVICE_TOKEN is invalid — app must be installed manually",
      );
      log.info("https://docs.slack.dev/authentication/tokens/#service");
      logger.debug(error);
    }
  }

  try {
    await getAuthUser({ token: params.vercelApiToken });
  } catch (error) {
    throw new Error(
      "Vercel API token is invalid or expired. Create a new token and add it as VERCEL_API_TOKEN in your Vercel project:\nhttps://vercel.com/account/settings/tokens",
      { cause: error },
    );
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
