import { z } from "zod";
import { assertToken } from "../internal/tokens";
import type { PreviewParams } from "../preview";

function formatMissingKeys(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join(".")).join(", ");
}

const systemEnvSchema = z.object({
  VERCEL_ENV: z.enum(["production", "preview", "development"]),
  VERCEL_GIT_COMMIT_REF: z.string(),
  VERCEL_PROJECT_ID: z.string(),
  VERCEL_URL: z.string(),
  VERCEL_BRANCH_URL: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  VERCEL_GIT_COMMIT_MESSAGE: z.string().optional(),
  VERCEL_GIT_COMMIT_AUTHOR_LOGIN: z.string().optional(),
  VERCEL_DEPLOYMENT_ID: z.string().optional(),
  VERCEL_AUTOMATION_BYPASS_SECRET: z.string().optional(),
});

const slackEnvSchema = z.object({
  SLACK_APP_ID: z.string().optional(),
  SLACK_CONFIGURATION_TOKEN: z.string(),
  SLACK_SERVICE_TOKEN: z.string().optional(),
  SLACK_CONFIG_REFRESH_TOKEN: z.string().optional(),
  MANIFEST_PATH: z.string().default("manifest.json"),
});

const vercelEnvSchema = z.object({
  VERCEL_API_TOKEN: z.string(),
});

/**
 * A token as it was meant: without the space or line break a paste can leave
 * around it, and refused when it has one inside.
 */
function token<T extends string | undefined>(name: string, value: T): T {
  assertToken(name, value);
  return value?.trim() as T;
}

export function validateAndBuildParams(
  env: Record<string, string | undefined>,
): PreviewParams {
  const systemResult = systemEnvSchema.safeParse(env);
  if (!systemResult.success) {
    const missing = formatMissingKeys(systemResult.error);
    throw new Error(
      `Missing system environment variables: ${missing}\nTurn on "Automatically expose System Environment Variables" in your Vercel project: https://vercel.com/docs/projects/environment-variables/system-environment-variables`,
    );
  }

  const slackResult = slackEnvSchema.safeParse(env);
  if (!slackResult.success) {
    const missing = formatMissingKeys(slackResult.error);
    throw new Error(
      `Missing ${missing}\nGenerate a configuration token and add it to your Vercel project: https://api.slack.com/apps`,
    );
  }

  const vercelResult = vercelEnvSchema.safeParse(env);
  if (!vercelResult.success) {
    const missing = formatMissingKeys(vercelResult.error);
    throw new Error(
      `Missing ${missing}\nCreate a token and add it to your Vercel project: https://vercel.com/account/settings/tokens`,
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
    slackConfigurationToken: token(
      "SLACK_CONFIGURATION_TOKEN",
      slackResult.data.SLACK_CONFIGURATION_TOKEN,
    ),
    slackConfigRefreshToken: token(
      "SLACK_CONFIG_REFRESH_TOKEN",
      slackResult.data.SLACK_CONFIG_REFRESH_TOKEN,
    ),
    slackServiceToken: token(
      "SLACK_SERVICE_TOKEN",
      slackResult.data.SLACK_SERVICE_TOKEN,
    ),
    // An empty MANIFEST_PATH, like one left blank in the project's settings,
    // would name the working directory itself.
    manifestPath: slackResult.data.MANIFEST_PATH || "manifest.json",
    vercelApiToken: token(
      "VERCEL_API_TOKEN",
      vercelResult.data.VERCEL_API_TOKEN,
    ),
  };
}
