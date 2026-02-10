import type { Manifest } from "@slack/web-api/dist/types/request/manifest";

export interface CreateAppResult {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  installUrl: string | null;
}

export interface SlackOps {
  createApp(manifest: Manifest): Promise<CreateAppResult>;
  updateApp(appId: string, manifest: Manifest): Promise<void>;
  deleteApp(appId: string): Promise<void>;
  /** Installs the app and returns the bot token (xoxb-...). */
  installApp(appId: string, manifest: Manifest): Promise<string>;
}

export interface VercelOps {
  getSlackAppId(branch: string): Promise<string | null>;
  setEnvVars(
    branch: string | null,
    vars: { key: string; value: string }[],
  ): Promise<void>;
  deleteSlackEnvVars(branch: string): Promise<void>;
  ensureProtectionBypass(): Promise<string>;
  triggerRedeploy(): Promise<void>;
  cancelDeployment(deploymentId: string): Promise<void>;
  getActiveBranches(): Promise<Set<string>>;
}

/** Deployment context passed to prepareManifest. */
export interface DeploymentContext {
  branch: string;
  branchUrl: string;
  commitSha: string;
  commitMsg: string;
  commitAuthor: string;
  bypassSecret: string | null;
}

export interface UpsertResult {
  appId: string;
  installUrl: string | null;
  isNew: boolean;
}

export interface InstallResult {
  installed: boolean;
  error?: string;
}

/** Result from setupSlackPreview indicating what action was taken. */
export type SetupResult =
  | { status: "skipped"; reason: string; warnings: string[] }
  | { status: "failed"; error: string; warnings: string[] }
  | { status: "created"; appId: string; warnings: string[] }
  | { status: "updated"; appId: string; warnings: string[] };

/** Options for setupSlackPreview */
export interface SetupSlackPreviewOptions {
  /**
   * Path to the manifest.json file (relative to repo root)
   * @default "manifest.json"
   */
  manifestPath?: string;
  /**
   * Slack configuration token for creating/updating apps
   * @default process.env.SLACK_CONFIGURATION_TOKEN
   */
  slackConfigToken?: string;
  /**
   * Vercel API token for setting/querying environment variables
   * @default process.env.VERCEL_API_TOKEN
   */
  vercelToken?: string;
  /**
   * Slack CLI service token (xoxp-...) for automatic app installation.
   * When provided, the app is installed to the workspace automatically via
   * the `apps.developerInstall` API and the `SLACK_BOT_TOKEN` is set as a
   * branch-scoped Vercel environment variable.
   *
   * Obtain a service token by running `slack auth token` in the Slack CLI.
   * @see {@link https://docs.slack.dev/tools/slack-cli/guides/authorizing-the-slack-cli#ci-cd CI/CD authorization}
   * @default process.env.SLACK_SERVICE_TOKEN
   */
  slackServiceToken?: string;
  /**
   * Slack configuration refresh token for automatic token rotation.
   * When provided, expired configuration tokens are automatically refreshed
   * via `tooling.tokens.rotate` and the new tokens are persisted as
   * project-level Vercel environment variables.
   *
   * Generate a configuration token (and its refresh token) at the bottom of
   * {@link https://api.slack.com/apps}.
   * @default process.env.SLACK_CONFIG_REFRESH_TOKEN
   */
  slackConfigRefreshToken?: string;
  /**
   * Enable verbose debug logging.
   * Logs detailed information about each step of the build process including
   * environment variable state, API calls, and timing.
   * @default false
   */
  debug?: boolean;
}

export interface DeveloperInstallResponse {
  ok: boolean;
  error?: string;
  app_id?: string;
  api_access_tokens?: {
    bot?: string;
    app_level?: string;
    user?: string;
  };
}

export interface VercelBranchesResponse {
  branches?: Array<{ branch: string }>;
}

/** Result from `tooling.tokens.rotate` Slack API call. */
export interface TokenRotationResponse {
  ok: boolean;
  error?: string;
  token?: string;
  refresh_token?: string;
  team_id?: string;
  user_id?: string;
  iat?: number;
  exp?: number;
}

/** Result from checking/refreshing a Slack configuration token. */
export interface CheckTokenResult {
  /** The valid configuration token to use (may be the original or a refreshed one). */
  token: string;
  /** If the token was rotated, the new refresh token that must be persisted. */
  newRefreshToken?: string;
  /** Whether the token was rotated. */
  rotated: boolean;
}
