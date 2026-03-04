import { WebClient } from "@slack/web-api";
import { Vercel } from "@vercel/sdk";
import type { Command } from "commander";
import {
  formatMissingKeys,
  slackEnvSchema,
  systemEnvSchema,
  vercelEnvSchema,
} from "../internal/schemas";
import { endMessage, logger, startMessage } from "../logger";
import { type PreviewParams, preview } from "../preview";

const ENV_KEYS = [
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_REF",
  "VERCEL_PROJECT_ID",
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_TEAM_ID",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_MESSAGE",
  "VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
  "SLACK_APP_ID",
  "SLACK_CONFIGURATION_TOKEN",
  "SLACK_SERVICE_TOKEN",
  "SLACK_CONFIG_REFRESH_TOKEN",
  "MANIFEST_PATH",
  "VERCEL_API_TOKEN",
] as const;

function envKeyToFlag(key: string): string {
  return key.toLowerCase().replace(/_/g, "-");
}

function flagToCamelCase(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function resolveEnv(
  options: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const overrides: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const camelKey = flagToCamelCase(envKeyToFlag(key));
    const value = options[camelKey];
    if (typeof value === "string") {
      overrides[key] = value;
    }
  }
  return { ...process.env, ...overrides };
}

function validateAndBuildParams(
  env: Record<string, string | undefined>,
): PreviewParams {
  const systemResult = systemEnvSchema.safeParse(env);
  if (!systemResult.success) {
    const missing = formatMissingKeys(systemResult.error);
    throw new Error(
      `Missing Vercel system environment variables: ${missing}\nEnable 'Automatically expose System Environment Variables' in your Vercel project settings:\nhttps://vercel.com/docs/projects/environment-variables/system-environment-variables`,
    );
  }

  const slackResult = slackEnvSchema.safeParse(env);
  if (!slackResult.success) {
    const missing = formatMissingKeys(slackResult.error);
    throw new Error(
      `Missing Slack environment variables: ${missing}\nAdd them as environment variables in your Vercel project.`,
    );
  }

  const vercelResult = vercelEnvSchema.safeParse(env);
  if (!vercelResult.success) {
    const missing = formatMissingKeys(vercelResult.error);
    throw new Error(
      `Missing Vercel environment variables: ${missing}\nCreate a new token and add it as VERCEL_API_TOKEN in your Vercel project:\nhttps://vercel.com/account/settings/tokens`,
    );
  }

  return {
    branch: systemResult.data.VERCEL_GIT_COMMIT_REF,
    projectId: systemResult.data.VERCEL_PROJECT_ID,
    deploymentUrl: systemResult.data.VERCEL_URL,
    branchUrl: systemResult.data.VERCEL_BRANCH_URL,
    teamId: systemResult.data.VERCEL_TEAM_ID,
    commitSha: systemResult.data.VERCEL_GIT_COMMIT_SHA,
    commitMessage: systemResult.data.VERCEL_GIT_COMMIT_MESSAGE,
    commitAuthor: systemResult.data.VERCEL_GIT_COMMIT_AUTHOR_LOGIN,
    deploymentId: systemResult.data.VERCEL_DEPLOYMENT_ID,
    automationBypassSecret: systemResult.data.VERCEL_AUTOMATION_BYPASS_SECRET,
    slackAppId: slackResult.data.SLACK_APP_ID,
    slackConfigurationToken: slackResult.data.SLACK_CONFIGURATION_TOKEN,
    slackServiceToken: slackResult.data.SLACK_SERVICE_TOKEN,
    slackConfigRefreshToken: slackResult.data.SLACK_CONFIG_REFRESH_TOKEN,
    manifestPath: slackResult.data.MANIFEST_PATH,
    vercelApiToken: vercelResult.data.VERCEL_API_TOKEN,
  };
}

export function registerBuildCommand(program: Command, version: string): void {
  const cmd = program
    .command("build")
    .description(
      "Build and configure the Slack app for a Vercel preview deployment",
    );

  for (const key of ENV_KEYS) {
    cmd.option(`--${envKeyToFlag(key)} <value>`, `Override ${key}`);
  }

  cmd.action(async (options: Record<string, string | undefined>) => {
    const env = resolveEnv(options);
    const isLocal = !env.VERCEL_ENV;
    const isDev =
      env.VERCEL_ENV === "development" || env.NODE_ENV === "development";
    const isProd = env.VERCEL_ENV === "production";

    logger.info(
      startMessage(
        version,
        env.VERCEL_GIT_COMMIT_REF,
        env.VERCEL_GIT_COMMIT_SHA,
        env.SLACK_APP_ID,
      ),
    );

    if (isLocal || isDev || isProd) {
      const reason = isLocal ? "local" : isDev ? "development" : "production";
      logger.info(`Environment: ${reason} (skipped)`);
      logger.info(endMessage());
      return;
    }

    const params = validateAndBuildParams(env);

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

    let validServiceToken: string | undefined;
    if (!params.slackServiceToken) {
      logger.warn(
        "SLACK_SERVICE_TOKEN is not set. Create a service token and add it as SLACK_SERVICE_TOKEN in your Vercel project. This app will need to be installed manually.\nhttps://docs.slack.dev/authentication/tokens/#service",
      );
    } else {
      try {
        await new WebClient(params.slackServiceToken).auth.test();
        validServiceToken = params.slackServiceToken;
      } catch (error) {
        logger.warn(
          "SLACK_SERVICE_TOKEN is invalid. Create a new service token and add it as SLACK_SERVICE_TOKEN in your Vercel project. This app will need to be installed manually.\nhttps://docs.slack.dev/authentication/tokens/#service",
        );
        logger.debug(error);
      }
    }

    const vercelClient = new Vercel({ bearerToken: params.vercelApiToken });
    try {
      await vercelClient.user.getAuthUser();
    } catch (error) {
      throw new Error(
        "Vercel API token is invalid or expired. Create a new token and add it as VERCEL_API_TOKEN in your Vercel project:\nhttps://vercel.com/account/settings/tokens",
        {
          cause: error,
        },
      );
    }

    await preview(params);
  });
}
