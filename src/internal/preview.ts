import fs from "node:fs/promises";
import path from "node:path";
import { WebClient } from "@slack/web-api";
import type { Manifest } from "@slack/web-api/dist/types/request/manifest";
import { Vercel } from "@vercel/sdk";
import { c, log, redact } from "../logger";

/** Result from creating a Slack app via the manifest API. */
export interface CreateAppResult {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  installUrl: string | null;
}

/**
 * Abstraction over Slack platform operations.
 * Implementations hold the auth tokens as instance state.
 */
export interface SlackOps {
  createApp(manifest: Manifest): Promise<CreateAppResult>;
  updateApp(appId: string, manifest: Manifest): Promise<void>;
  deleteApp(appId: string): Promise<void>;
  /** Installs the app and returns the bot token (xoxb-...). */
  installApp(appId: string, manifest: Manifest): Promise<string>;
}

/**
 * Abstraction over Vercel platform operations.
 * Implementations hold projectId, token, and teamId as instance state.
 */
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

/** Thrown when a Slack app no longer exists (deleted externally). */
export class SlackAppNotFoundError extends Error {
  constructor(public readonly appId: string) {
    super(`Slack app ${appId} not found`);
    this.name = "SlackAppNotFoundError";
  }
}

/** Thrown when a Slack app requires admin approval before installation. */
export class SlackAppApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackAppApprovalError";
  }
}

/** Thrown when a Vercel API call fails. Carries the HTTP status code. */
export class VercelApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "VercelApiError";
  }
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

/** Result from upsertSlackApp. */
interface UpsertResult {
  appId: string;
  installUrl: string | null;
  isNew: boolean;
}

/** Result from tryInstallApp. */
interface InstallResult {
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

/** Validated build environment required for preview setup. */
interface VercelPreviewEnv {
  branch: string;
  projectId: string;
  branchUrl: string;
  teamId: string | null;
  slackConfigToken: string;
  vercelToken: string;
}

/**
 * Reads and validates the environment needed for preview setup.
 * Logs a debug snapshot when `debug` is true.
 * Returns a skip reason string when setup should be skipped,
 * or the validated environment when everything is present.
 */
function validateBuildEnvironment(
  debug: boolean,
  options: {
    slackConfigToken?: string;
    vercelToken?: string;
  } = {},
): VercelPreviewEnv | string {
  const branch = process.env.VERCEL_GIT_COMMIT_REF;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const branchUrl = process.env.VERCEL_BRANCH_URL;
  const teamId = process.env.VERCEL_TEAM_ID || null;
  const slackConfigToken =
    options.slackConfigToken ?? process.env.SLACK_CONFIGURATION_TOKEN;
  const vercelToken = options.vercelToken ?? process.env.VERCEL_API_TOKEN;

  log.header();

  if (debug) {
    console.log(`${c.dim}[debug] Debug mode enabled${c.reset}`);
    log.debug(`Current environment snapshot:`);
    log.debug(`  SLACK_APP_ID = ${redact(process.env.SLACK_APP_ID)}`);
    log.debug(`  SLACK_CLIENT_ID = ${redact(process.env.SLACK_CLIENT_ID)}`);
    log.debug(
      `  SLACK_CLIENT_SECRET = ${redact(process.env.SLACK_CLIENT_SECRET)}`,
    );
    log.debug(
      `  SLACK_SIGNING_SECRET = ${redact(process.env.SLACK_SIGNING_SECRET)}`,
    );
    log.debug(`  SLACK_BOT_TOKEN = ${redact(process.env.SLACK_BOT_TOKEN)}`);
    log.debug(`  SLACK_CONFIGURATION_TOKEN = ${redact(slackConfigToken)}`);
    log.debug(
      `  SLACK_SERVICE_TOKEN = ${redact(process.env.SLACK_SERVICE_TOKEN)}`,
    );
    log.debug(`  VERCEL_GIT_COMMIT_REF = ${branch ?? "<not set>"}`);
    log.debug(`  VERCEL_PROJECT_ID = ${projectId ?? "<not set>"}`);
    log.debug(`  VERCEL_BRANCH_URL = ${branchUrl ?? "<not set>"}`);
    log.debug(`  VERCEL_TEAM_ID = ${teamId ?? "<not set>"}`);
    log.debug(`  VERCEL_ENV = ${process.env.VERCEL_ENV ?? "<not set>"}`);
    log.debug(
      `  VERCEL_AUTOMATION_BYPASS_SECRET = ${redact(
        process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      )}`,
    );
    log.debug(`  VERCEL_API_TOKEN = ${redact(vercelToken)}`);
  }

  if (process.env.VERCEL_ENV === "production") {
    return "Production deployment";
  }
  if (!branch) {
    return "Missing VERCEL_GIT_COMMIT_REF";
  }
  if (!projectId) {
    return "Missing VERCEL_PROJECT_ID";
  }
  if (!branchUrl) {
    return "Missing VERCEL_BRANCH_URL";
  }
  if (!slackConfigToken) {
    return "Missing SLACK_CONFIGURATION_TOKEN";
  }
  if (!vercelToken) {
    return "Missing VERCEL_API_TOKEN";
  }

  return {
    branch,
    projectId,
    branchUrl,
    teamId,
    slackConfigToken,
    vercelToken,
  };
}

/**
 * Pre-build setup script for Slack preview deployments.
 *
 * Call this before your framework build command to:
 * - Create a Slack app on the first deployment for a branch
 * - Sync manifest changes on subsequent deployments
 * - Set branch-scoped environment variables in Vercel
 *
 * @example
 * ```typescript
 * // scripts/setup-slack.ts
 * import { setupSlackPreview } from '@vercel/slack-bolt/preview';
 *
 * // Uses manifest.json in the repo root by default
 * await setupSlackPreview();
 *
 * // Or specify a custom path
 * await setupSlackPreview({ manifestPath: 'config/manifest.json' });
 * ```
 *
 * Build command: `tsx scripts/setup-slack.ts && next build`
 */
export async function setupSlackPreview(
  options: SetupSlackPreviewOptions = {},
): Promise<SetupResult> {
  const {
    manifestPath = "manifest.json",
    slackConfigToken: slackConfigTokenOpt = process.env
      .SLACK_CONFIGURATION_TOKEN,
    vercelToken: vercelTokenOpt = process.env.VERCEL_API_TOKEN,
    slackServiceToken = process.env.SLACK_SERVICE_TOKEN,
    debug = false,
  } = options;

  log._debug = debug;

  const env = validateBuildEnvironment(debug, {
    slackConfigToken: slackConfigTokenOpt,
    vercelToken: vercelTokenOpt,
  });
  if (typeof env === "string") {
    return { status: "skipped", reason: env, warnings: [] };
  }

  const {
    branch,
    projectId,
    branchUrl,
    teamId,
    slackConfigToken,
    vercelToken,
  } = env;

  const warnings: string[] = [];

  const slack = createSlackOps(slackConfigToken, slackServiceToken);
  const vercel = createVercelOps(projectId, vercelToken, teamId);

  log.info("Branch", branch);
  log.info("Manifest", manifestPath);
  console.log();

  log.debug(`Loading manifest from: ${manifestPath}`);
  const manifest = await loadManifest(manifestPath);

  let bypassSecret: string | null = null;
  log.debug("Ensuring deployment protection bypass...");
  try {
    bypassSecret = await vercel.ensureProtectionBypass();
    log.debug(
      bypassSecret === process.env.VERCEL_AUTOMATION_BYPASS_SECRET
        ? "Using existing VERCEL_AUTOMATION_BYPASS_SECRET"
        : `Generated new bypass secret: ${redact(bypassSecret)}`,
    );
  } catch (error) {
    warnings.push(
      `Failed to configure deployment protection bypass: ${error instanceof Error ? error.message : error}`,
    );
    warnings.push(
      "Slack webhooks may be blocked by Vercel Authentication on preview deployments",
    );
  }

  prepareManifest(manifest, {
    branch,
    branchUrl,
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
    commitMsg: process.env.VERCEL_GIT_COMMIT_MESSAGE ?? "",
    commitAuthor: process.env.VERCEL_GIT_COMMIT_AUTHOR_LOGIN ?? "unknown",
    bypassSecret,
  });

  let result: UpsertResult;
  try {
    result = await upsertSlackApp(manifest, branch, slack, vercel);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { status: "failed", error: msg, warnings };
  }

  const { appId, isNew } = result;

  if (slackServiceToken) {
    const installResult = await tryInstallApp(
      appId,
      manifest,
      slack,
      vercel,
      branch,
    );
    if (installResult.installed) {
      log.debug(`Slack app ${appId} installed for preview branch: ${branch}`);
    } else if (installResult.error) {
      warnings.push(`Failed to auto-install app: ${installResult.error}`);
      if (!isNew) {
        warnings.push(
          "Check that SLACK_SERVICE_TOKEN has the correct permissions, or install manually via the URL below.",
        );
      }
    }
  } else {
    log.debug(
      "Skipping auto-install (SLACK_SERVICE_TOKEN not set). App must be installed manually.",
    );
  }

  if (isNew) {
    try {
      await vercel.triggerRedeploy();
      log.debug("Redeploy triggered successfully.");
    } catch (error) {
      warnings.push(
        `Failed to trigger redeploy: ${error instanceof Error ? error.message : error}`,
      );
      warnings.push(
        "Push a new commit or redeploy manually from the Vercel dashboard.",
      );
    }

    const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
    if (deploymentId) {
      try {
        await vercel.cancelDeployment(deploymentId);
        log.debug(`Canceled current deployment: ${deploymentId}`);
      } catch {}
    }

    return { status: "created", appId, warnings };
  }

  log.debug("Running orphan cleanup...");
  try {
    await cleanupOrphanedApps(
      projectId,
      branch,
      vercelToken,
      teamId,
      slackConfigToken,
    );
    log.debug("Orphan cleanup completed");
  } catch (error) {
    warnings.push(
      `Orphan cleanup failed: ${error instanceof Error ? error.message : error}`,
    );
  }

  if (debug) {
    console.log();
    log.debug("--- Build summary ---");
    log.debug(`App ID: ${appId}`);
    log.debug(
      `SLACK_SIGNING_SECRET in process.env: ${redact(process.env.SLACK_SIGNING_SECRET)}`,
    );
    log.debug("--- End build summary ---");
  }

  return { status: "updated", appId, warnings };
}

/**
 * Prepares a manifest for a preview deployment.
 *
 * Mutates `manifest` in place:
 * 1. Formats display name and bot_user name with the branch suffix
 * 2. Appends deployment context to `long_description` (truncated to 4000 chars)
 * 3. Injects the branch URL (and optional bypass secret) into all URL fields
 *
 * This is a pure, synchronous function with no I/O.
 * @internal Exported for testing.
 */
export function prepareManifest(
  manifest: Manifest,
  context: DeploymentContext,
): void {
  const {
    branch,
    branchUrl,
    commitSha,
    commitMsg,
    commitAuthor,
    bypassSecret,
  } = context;
  const baseUrl = `https://${branchUrl}`;
  const shortSha = commitSha.slice(0, 7);

  manifest.display_information.name = formatPreviewName(
    manifest.display_information.name,
    branch,
  );

  if (manifest.features?.bot_user?.display_name) {
    manifest.features.bot_user.display_name = formatPreviewName(
      manifest.features.bot_user.display_name,
      branch,
    );
  }

  const deploymentInfo = [
    `\n`,
    `:globe_with_meridians: *Deployment URL:* ${branchUrl}`,
    `:seedling: *Branch:* ${branch}`,
    `:technologist: *Commit:* ${shortSha} ${commitMsg}`,
    `:bust_in_silhouette: *Last updated by:* ${commitAuthor}`,
    `\n`,
    `_Automatically created by ▲ Vercel_`,
    ``,
  ].join("\n");

  const maxLongDesc = 4000;
  const existingDesc = manifest.display_information.long_description ?? "";
  const combined = existingDesc + deploymentInfo;

  if (combined.length > maxLongDesc) {
    const available = Math.max(0, maxLongDesc - deploymentInfo.length);
    manifest.display_information.long_description = (
      existingDesc.slice(0, available) + deploymentInfo
    ).slice(0, maxLongDesc);
  } else {
    manifest.display_information.long_description = combined;
  }

  injectUrls(manifest, baseUrl, bypassSecret);
}

/**
 * Ensures a Slack app exists for the given branch (create or update).
 *
 * - If an app already exists: updates its manifest.
 * - If the app was deleted externally: cleans up stale env vars and recreates.
 * - If no app exists: creates a new one and sets env vars.
 *
 * @returns The resolved app ID, install URL, and whether a new app was created.
 * @internal Exported for testing.
 */
export async function upsertSlackApp(
  manifest: Manifest,
  branch: string,
  slack: SlackOps,
  vercel: VercelOps,
): Promise<UpsertResult> {
  let existingAppId = await vercel.getSlackAppId(branch);

  if (existingAppId) {
    try {
      await slack.updateApp(existingAppId, manifest);
      return { appId: existingAppId, installUrl: null, isNew: false };
    } catch (error) {
      if (error instanceof SlackAppNotFoundError) {
        try {
          await vercel.deleteSlackEnvVars(branch);
        } catch {}
        existingAppId = null;
      } else {
        throw error;
      }
    }
  }

  const result = await slack.createApp(manifest);

  await vercel.setEnvVars(branch, [
    { key: "SLACK_APP_ID", value: result.appId },
    { key: "SLACK_CLIENT_ID", value: result.clientId },
    { key: "SLACK_CLIENT_SECRET", value: result.clientSecret },
    { key: "SLACK_SIGNING_SECRET", value: result.signingSecret },
  ]);

  return {
    appId: result.appId,
    installUrl: result.installUrl,
    isNew: true,
  };
}

/**
 * Attempts to install a Slack app and persist the bot token.
 *
 * Never throws -- returns a structured result indicating success or failure.
 * The caller decides how to log warnings.
 *
 * @returns `{ installed: true }` on success, `{ installed: false, error }` on failure.
 * @internal Exported for testing.
 */
export async function tryInstallApp(
  appId: string,
  manifest: Manifest,
  slack: SlackOps,
  vercel: VercelOps,
  branch: string,
): Promise<InstallResult> {
  try {
    const botToken = await slack.installApp(appId, manifest);
    await vercel.setEnvVars(branch, [
      { key: "SLACK_BOT_TOKEN", value: botToken },
    ]);
    return { installed: true };
  } catch (error) {
    if (error instanceof SlackAppApprovalError) {
      return { installed: false, error: error.message };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { installed: false, error: msg };
  }
}

/**
 * Creates a real SlackOps implementation backed by the Slack Web API.
 *
 * @param configToken - Slack configuration token for app CRUD
 * @param serviceToken - Optional Slack CLI service token for app installation
 */
function createSlackOps(configToken: string, serviceToken?: string): SlackOps {
  return {
    async createApp(manifest: Manifest): Promise<CreateAppResult> {
      const result = await createSlackAppFromManifest(manifest, configToken);
      const appId = result.app_id;
      const clientId = result.credentials?.client_id;
      const clientSecret = result.credentials?.client_secret;
      const signingSecret = result.credentials?.signing_secret;

      if (!appId || !clientId || !clientSecret || !signingSecret) {
        throw new Error(
          `Slack app creation succeeded but missing app_id or credentials. Response: ${JSON.stringify(result)}`,
        );
      }

      return {
        appId,
        clientId,
        clientSecret,
        signingSecret,
        installUrl: result.oauth_authorize_url ?? null,
      };
    },

    async updateApp(appId: string, manifest: Manifest): Promise<void> {
      try {
        await updateSlackAppManifest(appId, manifest, configToken);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("app_not_found") || msg.includes("internal_error")) {
          throw new SlackAppNotFoundError(appId);
        }
        throw error;
      }
    },

    async deleteApp(appId: string): Promise<void> {
      await deleteSlackApp(appId, configToken);
    },

    async installApp(appId: string, manifest: Manifest): Promise<string> {
      if (!serviceToken) {
        throw new Error(
          "Cannot install app: no service token provided to createSlackOps",
        );
      }
      try {
        return await installSlackApp(appId, manifest, serviceToken);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("app_approval")) {
          throw new SlackAppApprovalError(msg);
        }
        throw error;
      }
    },
  };
}

/**
 * Creates a real VercelOps implementation backed by the Vercel API.
 *
 * @param projectId - Vercel project ID
 * @param token - Vercel API token
 * @param teamId - Vercel team ID (or null for personal accounts)
 */
function createVercelOps(
  projectId: string,
  token: string,
  teamId: string | null,
): VercelOps {
  return {
    async getSlackAppId(branch: string): Promise<string | null> {
      return getSlackAppIdForBranch(projectId, branch, token, teamId);
    },

    async setEnvVars(
      branch: string,
      vars: { key: string; value: string }[],
    ): Promise<void> {
      return setVercelEnvVars(projectId, branch, token, vars, teamId);
    },

    async deleteSlackEnvVars(branch: string): Promise<void> {
      return deleteVercelEnvVars(projectId, branch, token, teamId);
    },

    async ensureProtectionBypass(): Promise<string> {
      return ensureProtectionBypass(projectId, token, teamId);
    },

    triggerRedeploy(): Promise<void> {
      return triggerRedeploy(projectId, token, teamId);
    },

    async cancelDeployment(deploymentId: string): Promise<void> {
      const vercelClient = new Vercel({ bearerToken: token });
      await vercelClient.deployments.cancelDeployment({
        id: deploymentId,
        ...(teamId ? { teamId } : {}),
      });
    },

    getActiveBranches(): Promise<Set<string>> {
      return getActiveBranches(projectId, token, teamId);
    },
  };
}

async function loadManifest(manifestPath: string): Promise<Manifest> {
  const resolved = path.resolve(process.cwd(), manifestPath);
  const content = await fs.readFile(resolved, "utf-8");
  try {
    return JSON.parse(content) as Manifest;
  } catch {
    throw new Error(
      `Failed to parse manifest as JSON from ${manifestPath}. Ensure it's valid JSON.`,
    );
  }
}

/**
 * Injects a base URL into all URL fields in a manifest.
 * Preserves the path portion of existing URLs.
 * When a bypass secret is provided, appends it as a query parameter
 * so Slack's webhook requests can reach protected preview deployments.
 * @internal Exported for testing.
 */
export function injectUrls(
  manifest: Manifest,
  baseUrl: string,
  bypassSecret?: string | null,
): void {
  function buildUrl(originalUrl: string): string {
    const p = extractPath(originalUrl);
    const url = `${baseUrl}${p}`;
    if (!bypassSecret) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}x-vercel-protection-bypass=${bypassSecret}`;
  }

  if (manifest.settings?.event_subscriptions?.request_url) {
    manifest.settings.event_subscriptions.request_url = buildUrl(
      manifest.settings.event_subscriptions.request_url,
    );
  }
  if (manifest.settings?.interactivity?.request_url) {
    manifest.settings.interactivity.request_url = buildUrl(
      manifest.settings.interactivity.request_url,
    );
  }
  if (manifest.features?.slash_commands) {
    for (const cmd of manifest.features.slash_commands) {
      if (cmd.url) {
        cmd.url = buildUrl(cmd.url);
      }
    }
  }
}

/**
 * Extracts the path portion from a URL, or returns the string as-is if it's already a path.
 * @internal Exported for testing.
 */
export function extractPath(urlOrPath: string): string {
  const protocolMatch = urlOrPath.match(/^https?:\/\/[^/]+(\/.*)?$/);
  if (protocolMatch) {
    return protocolMatch[1] || "/";
  }

  try {
    const url = new URL(urlOrPath);
    return url.pathname + url.search;
  } catch {
    return urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`;
  }
}

function formatPreviewName(originalName: string, branch: string): string {
  const maxLength = 35;
  const cleanBranch = branch.replace(/^refs\/heads\//, "").replace(/\//g, "-");

  const full = `${originalName} (${cleanBranch})`;

  if (full.length <= maxLength) {
    return full;
  }

  const prefix = `${originalName} (`;
  const suffix = ")";
  const availableForBranch = maxLength - prefix.length - suffix.length;

  if (availableForBranch <= 0) {
    return full.slice(0, maxLength);
  }

  return `${prefix}${cleanBranch.slice(0, availableForBranch)}${suffix}`;
}

function extractSlackApiError(error: unknown): {
  code: string;
  validationErrors?: Array<{ message: string; pointer: string }>;
} | null {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data: Record<string, unknown> }).data;
    return {
      code: typeof data.error === "string" ? data.error : "unknown_error",
      validationErrors: Array.isArray(data.errors)
        ? (data.errors as Array<{ message: string; pointer: string }>)
        : undefined,
    };
  }
  return null;
}

async function validateSlackManifest(
  manifest: Manifest,
  token: string,
): Promise<void> {
  log.debug("Validating manifest via apps.manifest.validate...");
  const client = new WebClient(token);
  try {
    await client.apps.manifest.validate({ manifest });
    log.debug("Manifest validation passed");
  } catch (error) {
    const apiError = extractSlackApiError(error);
    const details = apiError?.validationErrors
      ? apiError.validationErrors
          .map((e) => `  - ${e.message} (${e.pointer})`)
          .join("\n")
      : (apiError?.code ??
        (error instanceof Error ? error.message : String(error)));
    log.debug(`Manifest validation failed: ${details}`);
    throw new Error(
      `[slack-bolt] Invalid manifest.json:\n${details}\n\nFix your manifest.json and redeploy.`,
    );
  }
}

async function createSlackAppFromManifest(manifest: Manifest, token: string) {
  await validateSlackManifest(manifest, token);

  log.debug("Calling apps.manifest.create...");
  const client = new WebClient(token);
  try {
    const result = await client.apps.manifest.create({ manifest });
    log.debug(`apps.manifest.create response:`);
    log.debug(`  ok = ${result.ok}`);
    log.debug(`  app_id = ${result.app_id ?? "<missing>"}`);
    log.debug(
      `  credentials.client_id = ${redact(result.credentials?.client_id)}`,
    );
    log.debug(
      `  credentials.client_secret = ${redact(result.credentials?.client_secret)}`,
    );
    log.debug(
      `  credentials.signing_secret = ${redact(result.credentials?.signing_secret)}`,
    );
    log.debug(
      `  credentials.verification_token = ${redact(result.credentials?.verification_token)}`,
    );
    log.debug(
      `  oauth_authorize_url = ${result.oauth_authorize_url ?? "<not provided>"}`,
    );
    return result;
  } catch (error) {
    const apiError = extractSlackApiError(error);
    const details = apiError?.validationErrors
      ? apiError.validationErrors
          .map((e) => `${e.pointer}: ${e.message}`)
          .join("; ")
      : (apiError?.code ??
        (error instanceof Error ? error.message : String(error)));
    log.debug(`apps.manifest.create failed: ${details}`);
    throw new Error(`Failed to create Slack app: ${details}`);
  }
}

async function updateSlackAppManifest(
  appId: string,
  manifest: Manifest,
  token: string,
): Promise<void> {
  await validateSlackManifest(manifest, token);

  log.debug(`Calling apps.manifest.update for app ${appId}...`);
  const client = new WebClient(token);
  try {
    const result = await client.apps.manifest.update({
      app_id: appId,
      manifest,
    });
    log.debug(`apps.manifest.update response: ok = ${result.ok}`);
    log.debug(
      "Note: manifest updates do NOT return new credentials; signing_secret is unchanged",
    );
  } catch (error) {
    const apiError = extractSlackApiError(error);
    const details = apiError?.validationErrors
      ? apiError.validationErrors
          .map((e) => `${e.pointer}: ${e.message}`)
          .join("; ")
      : (apiError?.code ??
        (error instanceof Error ? error.message : String(error)));
    log.debug(`apps.manifest.update failed: ${details}`);
    throw new Error(`Failed to update Slack app: ${details}`);
  }
}

async function deleteSlackApp(appId: string, token: string): Promise<void> {
  const client = new WebClient(token);
  try {
    await client.apps.manifest.delete({ app_id: appId });
  } catch (error) {
    const apiError = extractSlackApiError(error);
    throw new Error(
      `Failed to delete Slack app: ${apiError?.code ?? (error instanceof Error ? error.message : String(error))}`,
    );
  }
}

interface DeveloperInstallResponse {
  ok: boolean;
  error?: string;
  app_id?: string;
  api_access_tokens?: {
    bot?: string;
    app_level?: string;
    user?: string;
  };
}

async function installSlackApp(
  appId: string,
  manifest: Manifest,
  serviceToken: string,
): Promise<string> {
  const botScopes = manifest.oauth_config?.scopes?.bot ?? [];

  log.debug(`Calling apps.developerInstall for app ${appId}...`);
  log.debug(
    `  Request: app_id=${appId}, bot_scopes=[${botScopes.join(", ")}], outgoing_domains=[]`,
  );

  const response = await fetch("https://slack.com/api/apps.developerInstall", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      app_id: appId,
      bot_scopes: botScopes,
      outgoing_domains: [],
    }),
  });

  log.debug(`  HTTP status: ${response.status} ${response.statusText}`);
  const data = (await response.json()) as DeveloperInstallResponse;

  log.debug(`apps.developerInstall response:`);
  log.debug(`  ok = ${data.ok}`);
  log.debug(`  error = ${data.error ?? "<none>"}`);
  log.debug(`  app_id = ${data.app_id ?? "<not returned>"}`);
  log.debug(`  api_access_tokens.bot = ${redact(data.api_access_tokens?.bot)}`);
  log.debug(
    `  api_access_tokens.app_level = ${redact(data.api_access_tokens?.app_level)}`,
  );
  log.debug(
    `  api_access_tokens.user = ${redact(data.api_access_tokens?.user)}`,
  );

  if (!data.ok) {
    throw new Error(
      `Failed to install Slack app: ${data.error ?? "unknown error"}`,
    );
  }

  const botToken = data.api_access_tokens?.bot;
  if (!botToken) {
    throw new Error(
      "Slack app was installed but no bot token was returned. " +
        "Ensure the manifest includes bot scopes in oauth_config.scopes.bot.",
    );
  }

  return botToken;
}

async function triggerRedeploy(
  projectId: string,
  token: string,
  teamId?: string | null,
): Promise<void> {
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  if (!deploymentId) {
    throw new Error(
      "VERCEL_DEPLOYMENT_ID is not set. Cannot trigger redeploy.",
    );
  }

  log.debug(`Triggering redeploy based on deployment: ${deploymentId}`);

  const params = new URLSearchParams({ forceNew: "1" });
  if (teamId) params.set("teamId", teamId);

  const response = await fetch(
    `https://api.vercel.com/v13/deployments?${params}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: projectId,
        deploymentId,
        meta: {
          redeployedBy: "@vercel/slack-bolt",
          reason: "First-time Slack app setup — env vars now available",
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new VercelApiError(
      `Vercel API returned ${response.status}: ${body}`,
      response.status,
    );
  }

  const data = (await response.json()) as { id?: string; url?: string };
  log.debug(`Redeploy created: id=${data.id}, url=${data.url}`);
}

const SLACK_ENV_VAR_KEYS = [
  "SLACK_APP_ID",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
] as const;

async function getSlackAppIdForBranch(
  projectId: string,
  branch: string,
  token: string,
  teamId?: string | null,
): Promise<string | null> {
  log.debug(`Querying Vercel env vars for SLACK_APP_ID on branch: ${branch}`);
  const vercel = new Vercel({ bearerToken: token });

  let envs: Array<{ id?: string; key: string; gitBranch?: string }>;
  try {
    const data = await vercel.projects.filterProjectEnvs({
      idOrName: projectId,
      teamId: teamId ?? undefined,
    });
    envs = "envs" in data ? data.envs : [];
    log.debug(`  Found ${envs.length} total env vars in project`);
    const branchEnvs = envs.filter((e) => e.gitBranch === branch);
    log.debug(
      `  Found ${branchEnvs.length} env vars for branch "${branch}": ${branchEnvs.map((e) => e.key).join(", ") || "<none>"}`,
    );
  } catch (error) {
    const statusCode =
      error && typeof error === "object" && "statusCode" in error
        ? (error as { statusCode: number }).statusCode
        : 0;
    throw new VercelApiError(
      `Failed to fetch env vars: ${error instanceof Error ? error.message : String(error)}`,
      statusCode,
    );
  }

  const appIdEnv = envs.find(
    (env) => env.key === "SLACK_APP_ID" && env.gitBranch === branch,
  );

  if (!appIdEnv?.id) {
    log.debug("  No SLACK_APP_ID env var found for this branch");
    return null;
  }

  log.debug(
    `  Found SLACK_APP_ID env var (id: ${appIdEnv.id}), fetching decrypted value...`,
  );
  try {
    const decrypted = await vercel.projects.getProjectEnv({
      idOrName: projectId,
      id: appIdEnv.id,
      teamId: teamId ?? undefined,
    });
    const value = "value" in decrypted ? (decrypted.value ?? null) : null;
    log.debug(`  Decrypted SLACK_APP_ID = ${value ?? "<null>"}`);
    return value;
  } catch (error) {
    console.error(
      `[slack-bolt] Failed to decrypt SLACK_APP_ID:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function setVercelEnvVars(
  projectId: string,
  branch: string,
  token: string,
  vars: { key: string; value: string }[],
  teamId?: string | null,
): Promise<void> {
  log.debug(
    `Setting ${vars.length} env var(s) via Vercel API (branch: ${branch}, target: preview, type: encrypted):`,
  );
  const vercel = new Vercel({ bearerToken: token });
  const failures: string[] = [];

  for (const { key, value } of vars) {
    log.debug(`  Setting ${key} = ${redact(value)} ...`);
    try {
      await vercel.projects.createProjectEnv({
        idOrName: projectId,
        upsert: "true",
        teamId: teamId ?? undefined,
        requestBody: {
          key,
          value,
          type: "encrypted",
          target: ["preview"],
          gitBranch: branch,
        },
      });
      log.debug(`  ${key} set successfully`);
    } catch (error) {
      log.error(
        `Failed to set env var ${key}: ${error instanceof Error ? error.message : error}`,
      );
      log.debug(
        `  ${key} FAILED: ${error instanceof Error ? error.message : error}`,
      );
      failures.push(key);
    }
  }

  if (failures.length > 0) {
    throw new VercelApiError(
      `Failed to set env vars: ${failures.join(", ")}. ` +
        `The Slack app was created but cannot be tracked. ` +
        `Delete it manually in Slack and retry.`,
      0,
    );
  }
}

async function deleteVercelEnvVars(
  projectId: string,
  branch: string,
  token: string,
  teamId?: string | null,
): Promise<void> {
  console.log(
    `[slack-bolt] Deleting env vars for project ${projectId} branch ${branch}`,
  );

  const vercel = new Vercel({ bearerToken: token });

  let envs: Array<{ id?: string; key: string; gitBranch?: string }>;
  try {
    const data = await vercel.projects.filterProjectEnvs({
      idOrName: projectId,
      teamId: teamId ?? undefined,
    });
    envs = "envs" in data ? data.envs : [];
  } catch (error) {
    console.error(
      `[slack-bolt] Failed to fetch env vars for deletion:`,
      error instanceof Error ? error.message : error,
    );
    return;
  }

  for (const env of envs) {
    if (
      env.id &&
      env.gitBranch === branch &&
      (SLACK_ENV_VAR_KEYS as readonly string[]).includes(env.key)
    ) {
      try {
        await vercel.projects.removeProjectEnv({
          idOrName: projectId,
          id: env.id,
          teamId: teamId ?? undefined,
        });
        console.log(`[slack-bolt] Deleted env var: ${env.key}`);
      } catch (error) {
        console.error(
          `[slack-bolt] Failed to delete env var ${env.key}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}

interface VercelBranchesResponse {
  branches?: Array<{ branch: string }>;
}

async function getActiveBranches(
  projectId: string,
  token: string,
  teamId?: string | null,
): Promise<Set<string>> {
  const params = new URLSearchParams({ active: "1", limit: "100" });
  if (teamId) params.set("teamId", teamId);

  const response = await fetch(
    `https://api.vercel.com/v5/projects/${projectId}/branches?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new VercelApiError(
      `Vercel branches API returned ${response.status}: ${body}`,
      response.status,
    );
  }

  const data = (await response.json()) as VercelBranchesResponse;
  return new Set(data.branches?.map((b) => b.branch) ?? []);
}

async function cleanupOrphanedApps(
  projectId: string,
  currentBranch: string,
  vercelToken: string,
  teamId: string | null,
  slackConfigToken: string,
): Promise<void> {
  const activeBranches = await getActiveBranches(
    projectId,
    vercelToken,
    teamId,
  );

  const vercel = new Vercel({ bearerToken: vercelToken });
  const data = await vercel.projects.filterProjectEnvs({
    idOrName: projectId,
    teamId: teamId ?? undefined,
  });
  const envs: Array<{ id?: string; key: string; gitBranch?: string }> =
    "envs" in data ? data.envs : [];

  const staleBranches = new Map<string, string | undefined>();
  for (const env of envs) {
    if (
      env.key === "SLACK_APP_ID" &&
      env.gitBranch &&
      env.gitBranch !== currentBranch &&
      !activeBranches.has(env.gitBranch)
    ) {
      staleBranches.set(env.gitBranch, env.id);
    }
  }

  if (staleBranches.size === 0) {
    return;
  }

  console.log(
    `[slack-bolt] Found ${staleBranches.size} orphaned branch(es): ${[...staleBranches.keys()].join(", ")}`,
  );

  for (const [branch, envId] of staleBranches) {
    let appId: string | null = null;
    if (envId) {
      try {
        const decrypted = await vercel.projects.getProjectEnv({
          idOrName: projectId,
          id: envId,
          teamId: teamId ?? undefined,
        });
        appId = "value" in decrypted ? (decrypted.value ?? null) : null;
      } catch {
        console.warn(
          `[slack-bolt] Failed to decrypt SLACK_APP_ID for branch ${branch}`,
        );
      }
    }

    if (appId) {
      try {
        await deleteSlackApp(appId, slackConfigToken);
        console.log(
          `[slack-bolt] Deleted orphaned Slack app ${appId} (branch: ${branch})`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("app_not_found")) {
          console.log(
            `[slack-bolt] App ${appId} already deleted (branch: ${branch})`,
          );
        } else {
          console.warn(`[slack-bolt] Failed to delete app ${appId}: ${msg}`);
        }
      }
    }

    try {
      await deleteVercelEnvVars(projectId, branch, vercelToken, teamId);
    } catch (error) {
      console.warn(
        `[slack-bolt] Failed to delete env vars for branch ${branch}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

async function ensureProtectionBypass(
  projectId: string,
  token: string,
  teamId?: string | null,
): Promise<string> {
  const existing = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (existing) {
    log.debug(
      `Using existing VERCEL_AUTOMATION_BYPASS_SECRET: ${redact(existing)}`,
    );
    return existing;
  }

  log.debug(
    "No VERCEL_AUTOMATION_BYPASS_SECRET found, generating via Vercel API...",
  );
  const vercel = new Vercel({ bearerToken: token });

  const result = await vercel.projects.updateProjectProtectionBypass({
    idOrName: projectId,
    teamId: teamId ?? undefined,
    requestBody: {
      generate: {
        note: "Slack preview app webhooks (managed by @vercel/slack-bolt)",
      },
    },
  });

  const bypasses = result.protectionBypass;
  log.debug(
    `  Protection bypass entries returned: ${bypasses ? Object.keys(bypasses).length : 0}`,
  );
  if (!bypasses || Object.keys(bypasses).length === 0) {
    throw new VercelApiError(
      "Vercel API returned empty protectionBypass response",
      0,
    );
  }

  let newSecret: string | null = null;
  for (const [secret, meta] of Object.entries(bypasses)) {
    if (
      meta &&
      typeof meta === "object" &&
      "scope" in meta &&
      meta.scope === "automation-bypass"
    ) {
      newSecret = secret;
      break;
    }
  }

  if (!newSecret) {
    throw new VercelApiError(
      "Could not find automation-bypass secret in Vercel API response",
      0,
    );
  }

  log.debug(`  Generated bypass secret: ${redact(newSecret)}`);
  log.debug("  Marking bypass secret as env var for future builds...");

  await vercel.projects.updateProjectProtectionBypass({
    idOrName: projectId,
    teamId: teamId ?? undefined,
    requestBody: {
      update: {
        secret: newSecret,
        isEnvVar: true,
        note: "Slack preview app webhooks (managed by @vercel/slack-bolt)",
      },
    },
  });

  log.debug("  Bypass secret saved as VERCEL_AUTOMATION_BYPASS_SECRET");
  return newSecret;
}
