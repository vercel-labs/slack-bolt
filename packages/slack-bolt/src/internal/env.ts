import { z } from "zod";

const previewEnvSchema = z
  .object({
    VERCEL_ENV: z
      .enum(["production", "preview", "development"])
      .default("development"),
    VERCEL_GIT_COMMIT_REF: z.string(),
    VERCEL_PROJECT_ID: z.string(),
    VERCEL_BRANCH_URL: z.string(),
    VERCEL_TEAM_ID: z.string().optional(),
    VERCEL_GIT_COMMIT_SHA: z.string().optional(),
    VERCEL_GIT_COMMIT_MESSAGE: z.string().optional(),
    VERCEL_GIT_COMMIT_AUTHOR_LOGIN: z.string().optional(),
    VERCEL_DEPLOYMENT_ID: z.string().optional(),
    VERCEL_AUTOMATION_BYPASS_SECRET: z.string().optional(),
    SLACK_APP_ID: z.string().optional(),
    SLACK_CONFIGURATION_TOKEN: z.string().optional(),
    SLACK_SERVICE_TOKEN: z.string().optional(),
    SLACK_CONFIG_REFRESH_TOKEN: z.string().optional(),
    MANIFEST_PATH: z.string().default("manifest.json"),
    VERCEL_API_TOKEN: z.string(),
  })
  .transform((data) => ({
    env: data.VERCEL_ENV,
    branch: data.VERCEL_GIT_COMMIT_REF,
    projectId: data.VERCEL_PROJECT_ID,
    branchUrl: data.VERCEL_BRANCH_URL,
    teamId: data.VERCEL_TEAM_ID,
    commitSha: data.VERCEL_GIT_COMMIT_SHA,
    commitMsg: data.VERCEL_GIT_COMMIT_MESSAGE,
    commitAuthor: data.VERCEL_GIT_COMMIT_AUTHOR_LOGIN,
    deploymentId: data.VERCEL_DEPLOYMENT_ID,
    bypassSecret: data.VERCEL_AUTOMATION_BYPASS_SECRET,
    slackAppId: data.SLACK_APP_ID,
    slackConfigurationToken: data.SLACK_CONFIGURATION_TOKEN,
    slackServiceToken: data.SLACK_SERVICE_TOKEN,
    slackConfigRefreshToken: data.SLACK_CONFIG_REFRESH_TOKEN,
    manifestPath: data.MANIFEST_PATH,
    vercelApiToken: data.VERCEL_API_TOKEN,
  }));

export type PreviewEnv = z.infer<typeof previewEnvSchema>;

export type ValidateEnvResult =
  | { success: true; env: PreviewEnv }
  | { success: false; missingVars: string[] };

export function validateEnv(env: unknown): ValidateEnvResult {
  const result = previewEnvSchema.safeParse(env);
  if (!result.success) {
    const missingVars = result.error.issues.map((issue) =>
      issue.path.join("."),
    );
    return { success: false, missingVars };
  }
  return { success: true, env: result.data };
}
