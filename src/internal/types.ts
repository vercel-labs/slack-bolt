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
    branch: string,
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
