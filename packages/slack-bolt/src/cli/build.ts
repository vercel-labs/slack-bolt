import { WebClient } from "@slack/web-api";
import { getAuthUser } from "../internal/vercel";
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

  await preview(params, "cli");
}
