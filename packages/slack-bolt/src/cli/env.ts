export const ENV_KEYS = [
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

export function envKeyToFlag(key: string): string {
  return key.toLowerCase().replace(/_/g, "-");
}

function flagToCamelCase(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function resolveEnv(
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
