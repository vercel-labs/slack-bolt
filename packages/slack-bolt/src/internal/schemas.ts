import { z } from "zod";

export function formatMissingKeys(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join(".")).join(", ");
}

export const systemEnvSchema = z.object({
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

export const slackEnvSchema = z.object({
  SLACK_APP_ID: z.string().optional(),
  SLACK_CONFIGURATION_TOKEN: z.string().optional(),
  SLACK_SERVICE_TOKEN: z.string().optional(),
  SLACK_CONFIG_REFRESH_TOKEN: z.string().optional(),
  MANIFEST_PATH: z.string().default("manifest.json"),
});

export const vercelEnvSchema = z.object({
  VERCEL_API_TOKEN: z.string(),
});
