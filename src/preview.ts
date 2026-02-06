import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WebClient } from "@slack/web-api";
import type { Manifest } from "@slack/web-api/dist/types/request/manifest";
import { Vercel } from "@vercel/sdk";

// =============================================================================
// Pretty Build Output
// =============================================================================

const useColor = !process.env.NO_COLOR;

const c = {
  reset: useColor ? "\x1b[0m" : "",
  bold: useColor ? "\x1b[1m" : "",
  dim: useColor ? "\x1b[2m" : "",
  green: useColor ? "\x1b[32m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  cyan: useColor ? "\x1b[36m" : "",
};

const log = {
  header() {
    console.log(`${c.bold}▲ Vercel Slack Bolt${c.reset}`);
  },
  info(label: string, value: string) {
    console.log(`${c.dim}-${c.reset} ${label}: ${value}`);
  },
  success(msg: string) {
    console.log(`${c.green}✓${c.reset} ${msg}`);
  },
  warn(msg: string) {
    console.log(`${c.yellow}⚠${c.reset} ${msg}`);
  },
  error(msg: string) {
    console.error(`${c.dim}✖${c.reset} ${msg}`);
  },
  skip(msg: string) {
    console.log(`${c.dim}○ ${msg}${c.reset}`);
  },
  tree(items: { label: string; value: string }[]) {
    const maxLen = Math.max(...items.map((i) => i.label.length));
    for (let i = 0; i < items.length; i++) {
      const prefix = i === 0 ? "┌" : i === items.length - 1 ? "└" : "├";
      const padded = items[i].label.padEnd(maxLen);
      console.log(
        `${c.dim}${prefix}${c.reset} ${padded}  ${c.cyan}${items[i].value}${c.reset}`,
      );
    }
  },
};

// =============================================================================
// Slack App Manifest Types
// =============================================================================

/**
 * Re-export of the Slack SDK's Manifest type.
 * @see {@link https://docs.slack.dev/reference/app-manifest Slack App Manifest reference}
 */
export type SlackAppManifest = Manifest;

// =============================================================================
// Vercel Webhook Payload Types
// =============================================================================

/** Payload for deployment.cleanup webhook event */
export interface DeploymentCleanupPayload {
  type: "deployment.cleanup";
  id: string;
  createdAt: number;
  region: string | null;
  payload: {
    team: { id: string | null };
    user: { id: string };
    deployment: {
      id: string;
      meta: Record<string, string>;
      url: string;
      name: string;
      alias: string[];
      target: "production" | "staging" | null;
      customEnvironmentId?: string;
      regions: string[];
    };
    project: { id: string };
  };
}

// =============================================================================
// Setup Script (pre-build)
// =============================================================================

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
   * Path to the cleanup webhook handler route.
   * Used to automatically register a Vercel webhook for `deployment.cleanup` events
   * so deleted branches trigger Slack app cleanup.
   * @default "/api/webhooks/vercel"
   */
  webhookPath?: string;
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
): Promise<void> {
  const {
    manifestPath = "manifest.json",
    slackConfigToken = process.env.SLACK_CONFIGURATION_TOKEN,
    vercelToken = process.env.VERCEL_API_TOKEN,
    webhookPath = "/api/webhooks/vercel",
    slackServiceToken = process.env.SLACK_SERVICE_TOKEN,
  } = options;

  const branch = process.env.VERCEL_GIT_COMMIT_REF;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const branchUrl = process.env.VERCEL_BRANCH_URL;
  const teamId = process.env.VERCEL_TEAM_ID || null;

  log.header();

  // Skip for production deployments
  if (process.env.VERCEL_ENV === "production") {
    log.skip("Skipped (production deployment)");
    return;
  }

  if (!branch || !projectId || !branchUrl) {
    log.skip(
      "Skipped (missing VERCEL_GIT_COMMIT_REF, VERCEL_PROJECT_ID, or VERCEL_BRANCH_URL)",
    );
    return;
  }

  if (!slackConfigToken) {
    throw new Error(
      "SLACK_CONFIGURATION_TOKEN is required. Set it in environment variables or pass via options.",
    );
  }

  if (!vercelToken) {
    throw new Error(
      "VERCEL_API_TOKEN is required for querying and setting branch-scoped env vars.",
    );
  }

  log.info("Branch", branch);
  log.info("Manifest", manifestPath);
  console.log();

  // Load and prepare manifest
  const manifest = await loadManifest(manifestPath);
  const baseUrl = `https://${branchUrl}`;

  // Read deployment context from Vercel system env vars
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown";
  const shortSha = commitSha.slice(0, 7);
  const commitMsg = process.env.VERCEL_GIT_COMMIT_MESSAGE ?? "";
  const commitAuthor = process.env.VERCEL_GIT_COMMIT_AUTHOR_LOGIN ?? "unknown";

  // Format name as "name (branch)"
  manifest.display_information.name = formatPreviewName(
    manifest.display_information.name,
    branch,
  );

  // Update bot_user display_name if present
  if (manifest.features?.bot_user?.display_name) {
    manifest.features.bot_user.display_name = formatPreviewName(
      manifest.features.bot_user.display_name,
      branch,
    );
  }

  // Append deployment context to long description (preserve user's original)
  const deploymentInfo = [
    `\n`, // ensure a new line after the user's long description
    `:globe_with_meridians: *Deployment URL:* ${branchUrl}`,
    `:seedling: *Branch:* ${branch}`,
    `:technologist: *Commit:* ${shortSha} ${commitMsg}`,
    `:bust_in_silhouette: *Last updated by:* ${commitAuthor}`,
    `\n`,
    `_Automatically created by ▲ Vercel_`,
    ``,
  ].join("\n");

  // Slack limits long_description to 4000 characters
  const maxLongDesc = 4000;
  const existingDesc = manifest.display_information.long_description ?? "";
  const combined = existingDesc + deploymentInfo;

  if (combined.length > maxLongDesc) {
    // Truncate the user's description to make room for deployment info
    const available = maxLongDesc - deploymentInfo.length;
    manifest.display_information.long_description =
      existingDesc.slice(0, available) + deploymentInfo;
  } else {
    manifest.display_information.long_description = combined;
  }

  // ── Ensure deployment protection bypass ──
  // Vercel preview deployments are protected by default. Slack can't set custom
  // headers on its outbound webhook requests, so we append the bypass secret as
  // a query parameter to every URL in the manifest.
  let bypassSecret: string | null = null;
  try {
    bypassSecret = await ensureProtectionBypass(projectId, vercelToken, teamId);
    if (bypassSecret === process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
      log.success("Deployment protection bypass configured");
    } else {
      log.success("Generated deployment protection bypass");
    }
  } catch (error) {
    log.warn(
      `Failed to configure deployment protection bypass: ${error instanceof Error ? error.message : error}`,
    );
    log.warn(
      "Slack webhooks may be blocked by Vercel Authentication on preview deployments",
    );
  }

  // Inject branch URL (and optional bypass secret) into manifest
  injectUrls(manifest, baseUrl, bypassSecret);

  // Check if app already exists for this branch by querying Vercel env vars
  let resolvedAppId: string | null = null;
  let resolvedInstallUrl: string | null = null;
  let existingAppId = await getSlackAppIdForBranch(
    projectId,
    branch,
    vercelToken,
    teamId,
  );

  // If app exists, always update the manifest (safe upsert)
  if (existingAppId) {
    console.log(`  Updating Slack app ${existingAppId} ...`);
    try {
      await updateSlackAppManifest(existingAppId, manifest, slackConfigToken);
      resolvedAppId = existingAppId;
      log.success(`Synced manifest with preview deployment URL: ${branchUrl}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // App was deleted externally -- clean up env vars and recreate below
      if (msg.includes("app_not_found") || msg.includes("internal_error")) {
        log.warn(`App ${existingAppId} no longer exists, recreating`);
        // Clean up stale env vars before recreating
        try {
          await deleteVercelEnvVars(projectId, branch, vercelToken, teamId);
        } catch {
          // Best effort cleanup
        }
        existingAppId = null;
      } else {
        // Real error (e.g. invalid manifest) -- surface it clearly
        throw error;
      }
    }
  }

  // Create a new app for this branch (only if one doesn't already exist)
  if (!existingAppId) {
    console.log(`  Creating Slack app for branch: ${branch} ...`);
    const result = await createSlackAppFromManifest(manifest, slackConfigToken);

    const appId = result.app_id;
    const clientId = result.credentials?.client_id;
    const clientSecret = result.credentials?.client_secret;
    const signingSecret = result.credentials?.signing_secret;

    if (!appId || !clientId || !clientSecret || !signingSecret) {
      throw new Error(
        `Slack app creation succeeded but missing app_id or credentials. Response: ${JSON.stringify(result)}`,
      );
    }

    // Set Vercel environment variables (branch-scoped), including SLACK_APP_ID as our "store"
    await setVercelEnvVars(
      projectId,
      branch,
      vercelToken,
      [
        { key: "SLACK_APP_ID", value: appId },
        { key: "SLACK_CLIENT_ID", value: clientId },
        { key: "SLACK_CLIENT_SECRET", value: clientSecret },
        { key: "SLACK_SIGNING_SECRET", value: signingSecret },
      ],
      teamId,
    );

    resolvedAppId = appId;
    resolvedInstallUrl = result.oauth_authorize_url ?? null;
    log.success(`Created Slack app for branch: ${branch}`);
    log.success("Set environment variables");
    log.info("App ID", appId);
    log.info("URL", baseUrl);
  }

  // ── Install app and set SLACK_BOT_TOKEN ──
  // When a service token is available, install the app to the workspace via
  // the apps.developerInstall API (same API the Slack CLI uses). This returns
  // the bot token directly, bypassing the OAuth flow entirely.
  // Runs on every deploy (idempotent) to keep tokens in sync with scope changes.
  if (resolvedAppId && slackServiceToken) {
    try {
      const botToken = await installSlackApp(
        resolvedAppId,
        manifest,
        slackServiceToken,
      );
      await setVercelEnvVars(
        projectId,
        branch,
        vercelToken,
        [{ key: "SLACK_BOT_TOKEN", value: botToken }],
        teamId,
      );
      log.success("Installed app and set SLACK_BOT_TOKEN");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Surface approval-related errors clearly so the user knows what to do
      if (msg.includes("app_approval")) {
        log.warn(
          `App requires admin approval before it can be installed: ${msg}`,
        );
      } else {
        log.warn(`Failed to auto-install app: ${msg}`);
      }
      log.warn(
        "Set SLACK_SERVICE_TOKEN to enable automatic installation, or install manually via the URL below.",
      );
    }
  }

  // ── Ensure Vercel webhook is registered for cleanup events ──
  // The webhook targets the production deployment so it has a stable URL.
  // Failures here are non-fatal; the webhook can be retried on the next deploy.
  const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!productionUrl) {
    log.warn("Skipping webhook registration (no production URL yet)");
  } else {
    const webhookUrl = `https://${productionUrl}${webhookPath}`;
    try {
      const webhookSecret = await ensureVercelWebhook(
        projectId,
        webhookUrl,
        vercelToken,
        teamId,
      );
      if (webhookSecret) {
        await setWebhookSecretEnvVar(
          projectId,
          webhookSecret,
          vercelToken,
          teamId,
        );
        log.success("Registered cleanup webhook");
      } else {
        log.success("Cleanup webhook already registered");
      }
    } catch (error) {
      log.warn(
        `Failed to register webhook: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ── Best-effort orphan cleanup ──────────────────────────────────────────
  try {
    await cleanupOrphanedApps(
      projectId,
      branch,
      vercelToken,
      teamId,
      slackConfigToken,
    );
  } catch (error) {
    log.warn(
      `Orphan cleanup: ${error instanceof Error ? error.message : error}`,
    );
  }

  if (resolvedInstallUrl || resolvedAppId) {
    console.log();
    // Only show manual install URL if auto-install is not configured
    if (resolvedInstallUrl && !slackServiceToken) {
      console.log(`${c.dim}→ Install app: ${resolvedInstallUrl}${c.reset}`);
    }
    if (resolvedAppId) {
      console.log(
        `${c.dim}→ Manage app: https://api.slack.com/apps/${resolvedAppId}${c.reset}`,
      );
    }
  }

  console.log();
}

// =============================================================================
// Cleanup Webhook Handler
// =============================================================================

/** Options for createCleanupHandler */
export interface CleanupHandlerOptions {
  /**
   * Vercel webhook secret for signature verification
   * @default process.env.VERCEL_WEBHOOK_SECRET
   */
  secret?: string;
  /**
   * Slack configuration token for deleting apps
   * @default process.env.SLACK_CONFIGURATION_TOKEN
   */
  slackConfigToken?: string;
  /**
   * Vercel API token for querying/deleting environment variables
   * @default process.env.VERCEL_API_TOKEN
   */
  vercelToken?: string;
  /**
   * Slack CLI service token for uninstalling apps from the workspace.
   * When provided, the app is uninstalled before deletion.
   * @default process.env.SLACK_SERVICE_TOKEN
   */
  slackServiceToken?: string;
}

/**
 * Creates a Vercel webhook handler for deployment.cleanup events.
 * When a branch is deleted and Vercel removes the preview deployment,
 * this handler queries Vercel env vars for the branch's SLACK_APP_ID,
 * deletes the Slack app, and removes the env vars.
 *
 * No external store required -- Vercel env vars are the source of truth.
 *
 * Register this endpoint in Vercel Webhook settings for `deployment.cleanup` events.
 *
 * @example
 * ```typescript
 * // app/api/webhooks/vercel/route.ts
 * import { createCleanupHandler } from '@vercel/slack-bolt/preview';
 *
 * export const POST = createCleanupHandler();
 * ```
 */
export function createCleanupHandler(
  options: CleanupHandlerOptions = {},
): (req: Request) => Promise<Response> {
  const {
    secret = process.env.VERCEL_WEBHOOK_SECRET,
    slackConfigToken = process.env.SLACK_CONFIGURATION_TOKEN,
    vercelToken = process.env.VERCEL_API_TOKEN,
    slackServiceToken = process.env.SLACK_SERVICE_TOKEN,
  } = options;

  return async (req: Request): Promise<Response> => {
    try {
      const rawBody = await req.text();

      // Verify webhook signature
      if (secret) {
        const signature = req.headers.get("x-vercel-signature");
        if (!signature || !verifySignature(rawBody, signature, secret)) {
          return new Response(JSON.stringify({ error: "Invalid signature" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      const event = JSON.parse(rawBody) as DeploymentCleanupPayload;

      if (event.type !== "deployment.cleanup") {
        return new Response(JSON.stringify({ received: true, skipped: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      const { meta } = event.payload.deployment;
      const projectId = event.payload.project.id;
      const teamId = event.payload.team.id;
      const branch = extractBranchFromMeta(meta);

      if (!branch) {
        console.warn(
          "[slack-bolt] No branch found in cleanup event metadata. Skipping.",
        );
        return new Response(JSON.stringify({ received: true, skipped: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      console.log(`[slack-bolt] Processing cleanup for branch: ${branch}`);

      if (!vercelToken) {
        console.error(
          "[slack-bolt] VERCEL_API_TOKEN not set. Cannot query env vars for cleanup.",
        );
        return new Response(
          JSON.stringify({ error: "VERCEL_API_TOKEN required for cleanup" }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }

      // Query Vercel env vars to find the app ID for this branch
      const appId = await getSlackAppIdForBranch(
        projectId,
        branch,
        vercelToken,
        teamId,
      );

      if (!appId) {
        console.log(
          `[slack-bolt] No SLACK_APP_ID found for branch ${branch}. Nothing to clean up.`,
        );
        return new Response(
          JSON.stringify({ received: true, cleaned: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Uninstall the app from the workspace (if service token is available)
      if (slackServiceToken && teamId) {
        try {
          await uninstallSlackApp(appId, teamId, slackServiceToken);
          console.log(`[slack-bolt] Uninstalled Slack app: ${appId}`);
        } catch (error) {
          console.error("[slack-bolt] Failed to uninstall Slack app:", error);
        }
      }

      // Delete the Slack app -- requires slackConfigToken
      if (!slackConfigToken) {
        console.error(
          "[slack-bolt] SLACK_CONFIGURATION_TOKEN not set. " +
            "Cannot delete Slack app. Skipping cleanup to avoid orphaning the app.",
        );
        return new Response(
          JSON.stringify({ error: "SLACK_CONFIGURATION_TOKEN required" }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }

      try {
        await deleteSlackApp(appId, slackConfigToken);
        console.log(`[slack-bolt] Deleted Slack app: ${appId}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("app_not_found")) {
          console.log(`[slack-bolt] App ${appId} already deleted`);
        } else {
          console.error("[slack-bolt] Failed to delete Slack app:", error);
        }
      }

      // Delete Vercel env vars (including SLACK_APP_ID)
      try {
        await deleteVercelEnvVars(projectId, branch, vercelToken, teamId);
      } catch (error) {
        console.error("[slack-bolt] Failed to delete Vercel env vars:", error);
      }

      console.log(`[slack-bolt] Cleanup complete for branch ${branch}`);

      return new Response(JSON.stringify({ received: true, cleaned: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("[slack-bolt] Error processing cleanup webhook:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
}

// =============================================================================
// Manifest Helpers
// =============================================================================

/**
 * Loads a Slack app manifest from a local file.
 */
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
 */
function injectUrls(
  manifest: Manifest,
  baseUrl: string,
  bypassSecret?: string | null,
): void {
  const bypassParam = bypassSecret
    ? `?x-vercel-protection-bypass=${bypassSecret}`
    : "";

  if (manifest.settings?.event_subscriptions?.request_url) {
    const p = extractPath(manifest.settings.event_subscriptions.request_url);
    manifest.settings.event_subscriptions.request_url = `${baseUrl}${p}${bypassParam}`;
  }
  if (manifest.settings?.interactivity?.request_url) {
    const p = extractPath(manifest.settings.interactivity.request_url);
    manifest.settings.interactivity.request_url = `${baseUrl}${p}${bypassParam}`;
  }
  if (manifest.features?.slash_commands) {
    for (const cmd of manifest.features.slash_commands) {
      if (cmd.url) {
        const p = extractPath(cmd.url);
        cmd.url = `${baseUrl}${p}${bypassParam}`;
      }
    }
  }
}

/**
 * Extracts the path portion from a URL, or returns the string as-is if it's already a path.
 */
function extractPath(urlOrPath: string): string {
  // If it looks like a full URL (http:// or https://), extract the path after the host.
  // We use string manipulation instead of `new URL()` because manifests often contain
  // placeholder domains like `<your-domain>` that are not valid URLs.
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

/**
 * Formats a preview app name as "name (branch @ sha)".
 * Sanitizes branch for Slack (replaces / with -).
 * Truncates branch to fit Slack's 35-char limit.
 */
function formatPreviewName(originalName: string, branch: string): string {
  const maxLength = 35;
  const cleanBranch = branch.replace(/^refs\/heads\//, "").replace(/\//g, "-");

  const full = `${originalName} (${cleanBranch})`;

  if (full.length <= maxLength) {
    return full;
  }

  // Truncate branch to fit
  const prefix = `${originalName} (`;
  const suffix = ")";
  const availableForBranch = maxLength - prefix.length - suffix.length;

  if (availableForBranch <= 0) {
    return full.slice(0, maxLength);
  }

  return `${prefix}${cleanBranch.slice(0, availableForBranch)}${suffix}`;
}

// =============================================================================
// Slack API Functions
// =============================================================================

/**
 * Extracts structured error information from a Slack WebClient platform error.
 */
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

/**
 * Validates a Slack app manifest.
 */
async function validateSlackManifest(
  manifest: Manifest,
  token: string,
): Promise<void> {
  const client = new WebClient(token);
  try {
    await client.apps.manifest.validate({ manifest });
  } catch (error) {
    const apiError = extractSlackApiError(error);
    const details = apiError?.validationErrors
      ? apiError.validationErrors
          .map((e) => `  - ${e.message} (${e.pointer})`)
          .join("\n")
      : (apiError?.code ??
        (error instanceof Error ? error.message : String(error)));
    throw new Error(
      `[slack-bolt] Invalid manifest.json:\n${details}\n\nFix your manifest.json and redeploy.`,
    );
  }
}

/**
 * Creates a new Slack app from a manifest.
 */
async function createSlackAppFromManifest(manifest: Manifest, token: string) {
  await validateSlackManifest(manifest, token);

  const client = new WebClient(token);
  try {
    return await client.apps.manifest.create({ manifest });
  } catch (error) {
    const apiError = extractSlackApiError(error);
    const details = apiError?.validationErrors
      ? apiError.validationErrors
          .map((e) => `${e.pointer}: ${e.message}`)
          .join("; ")
      : (apiError?.code ??
        (error instanceof Error ? error.message : String(error)));
    throw new Error(`Failed to create Slack app: ${details}`);
  }
}

/**
 * Updates an existing Slack app's manifest.
 */
async function updateSlackAppManifest(
  appId: string,
  manifest: Manifest,
  token: string,
): Promise<void> {
  await validateSlackManifest(manifest, token);

  const client = new WebClient(token);
  try {
    await client.apps.manifest.update({ app_id: appId, manifest });
  } catch (error) {
    const apiError = extractSlackApiError(error);
    const details = apiError?.validationErrors
      ? apiError.validationErrors
          .map((e) => `${e.pointer}: ${e.message}`)
          .join("; ")
      : (apiError?.code ??
        (error instanceof Error ? error.message : String(error)));
    throw new Error(`Failed to update Slack app: ${details}`);
  }
}

/**
 * Deletes a Slack app.
 */
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

/** Response shape from the apps.developerInstall Slack API */
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

/**
 * Installs a Slack app to the workspace associated with the service token
 * using the `apps.developerInstall` API (the same API used by the Slack CLI).
 *
 * This bypasses the OAuth flow entirely -- the service token represents an
 * authenticated user who is granting the app access to their workspace.
 *
 * @see {@link https://github.com/slackapi/slack-cli/blob/main/internal/api/app.go Slack CLI source}
 * @returns The bot token (xoxb-...) for the installed app.
 */
async function installSlackApp(
  appId: string,
  manifest: Manifest,
  serviceToken: string,
): Promise<string> {
  const botScopes = manifest.oauth_config?.scopes?.bot ?? [];

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

  const data = (await response.json()) as DeveloperInstallResponse;

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

/**
 * Uninstalls a Slack app from a workspace using the `apps.developerUninstall` API.
 * Used during cleanup when a preview branch is deleted.
 */
async function uninstallSlackApp(
  appId: string,
  teamId: string,
  serviceToken: string,
): Promise<void> {
  const response = await fetch(
    "https://slack.com/api/apps.developerUninstall",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: appId,
        team_id: teamId,
      }),
    },
  );

  const data = (await response.json()) as { ok: boolean; error?: string };

  if (!data.ok && data.error !== "not_installed") {
    throw new Error(
      `Failed to uninstall Slack app: ${data.error ?? "unknown error"}`,
    );
  }
}

// =============================================================================
// Vercel API Functions
// =============================================================================

/** The env var keys we manage in Vercel */
const SLACK_ENV_VAR_KEYS = [
  "SLACK_APP_ID",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
] as const;

/**
 * Queries Vercel env vars for a specific branch and returns the
 * decrypted SLACK_APP_ID if it exists.
 * Uses the per-env-var endpoint to get decrypted values for encrypted vars.
 */
async function getSlackAppIdForBranch(
  projectId: string,
  branch: string,
  token: string,
  teamId?: string | null,
): Promise<string | null> {
  const vercel = new Vercel({ bearerToken: token });

  let envs: Array<{ id?: string; key: string; gitBranch?: string }>;
  try {
    const data = await vercel.projects.filterProjectEnvs({
      idOrName: projectId,
      teamId: teamId ?? undefined,
    });
    envs = "envs" in data ? data.envs : [];
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) {
      const statusCode = (error as { statusCode: number }).statusCode;
      if (statusCode === 401 || statusCode === 403) {
        console.error(
          "[slack-bolt] Vercel API auth failed. Check VERCEL_API_TOKEN has correct permissions.",
        );
      }
    }
    throw new Error(
      `Failed to fetch env vars: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Find the SLACK_APP_ID env var for this branch
  const appIdEnv = envs.find(
    (env) => env.key === "SLACK_APP_ID" && env.gitBranch === branch,
  );

  if (!appIdEnv?.id) {
    return null;
  }

  // Fetch the individual env var to get the decrypted value
  try {
    const decrypted = await vercel.projects.getProjectEnv({
      idOrName: projectId,
      id: appIdEnv.id,
      teamId: teamId ?? undefined,
    });
    return "value" in decrypted ? (decrypted.value ?? null) : null;
  } catch (error) {
    console.error(
      `[slack-bolt] Failed to decrypt SLACK_APP_ID:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Sets branch-scoped environment variables in a Vercel project.
 * Uses upsert to create or update vars in a single call per variable.
 */
async function setVercelEnvVars(
  projectId: string,
  branch: string,
  token: string,
  vars: { key: string; value: string }[],
  teamId?: string | null,
): Promise<void> {
  const vercel = new Vercel({ bearerToken: token });
  const failures: string[] = [];

  for (const { key, value } of vars) {
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
    } catch (error) {
      log.error(
        `Failed to set env var ${key}: ${error instanceof Error ? error.message : error}`,
      );
      failures.push(key);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Failed to set env vars: ${failures.join(", ")}. ` +
        `The Slack app was created but cannot be tracked. ` +
        `Delete it manually in Slack and retry.`,
    );
  }
}

/**
 * Deletes branch-scoped Slack environment variables from a Vercel project.
 */
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

// =============================================================================
// Vercel Branch & Orphan Cleanup
// =============================================================================

/** Response shape from Vercel's branches API */
interface VercelBranchesResponse {
  branches?: Array<{ branch: string }>;
}

/**
 * Fetches the list of active branches for a Vercel project.
 * Uses the Vercel REST API directly (the SDK does not expose this endpoint).
 */
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

  const data = (await response.json()) as VercelBranchesResponse;
  return new Set(data.branches?.map((b) => b.branch) ?? []);
}

/**
 * Scans for orphaned Slack apps from deleted branches and cleans them up.
 *
 * Compares branches that have `SLACK_APP_ID` env vars against the list of
 * active branches in Vercel. Any branch with a Slack app but no active
 * deployment is considered stale -- its app is deleted and env vars removed.
 *
 * This is a best-effort operation; errors are logged but do not throw.
 */
async function cleanupOrphanedApps(
  projectId: string,
  currentBranch: string,
  vercelToken: string,
  teamId: string | null,
  slackConfigToken: string,
): Promise<void> {
  // 1. Get the set of active branches from Vercel
  const activeBranches = await getActiveBranches(
    projectId,
    vercelToken,
    teamId,
  );

  // 2. Get all env vars to find branches with Slack apps
  const vercel = new Vercel({ bearerToken: vercelToken });
  const data = await vercel.projects.filterProjectEnvs({
    idOrName: projectId,
    teamId: teamId ?? undefined,
  });
  const envs: Array<{ id?: string; key: string; gitBranch?: string }> =
    "envs" in data ? data.envs : [];

  // 3. Collect branches that have SLACK_APP_ID but are not active (and not the current branch)
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

  // 4. Clean up each stale branch
  for (const [branch, envId] of staleBranches) {
    // Decrypt the SLACK_APP_ID
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

    // Delete the Slack app
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

    // Delete all branch-scoped env vars
    try {
      await deleteVercelEnvVars(projectId, branch, vercelToken, teamId);
    } catch (error) {
      console.warn(
        `[slack-bolt] Failed to delete env vars for branch ${branch}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

// =============================================================================
// Vercel Deployment Protection Bypass
// =============================================================================

/**
 * Ensures a deployment protection bypass secret exists for the project.
 *
 * Vercel preview deployments are protected by default. Since Slack can't set
 * custom HTTP headers on its outbound webhook requests, we need to append
 * the bypass secret as a query parameter (`?x-vercel-protection-bypass=SECRET`)
 * to all manifest URLs.
 *
 * On first deploy: generates a new bypass secret via the Vercel API and marks
 * it as the `VERCEL_AUTOMATION_BYPASS_SECRET` env var so future builds get it
 * automatically.
 *
 * On subsequent deploys: reads the existing secret from the env var directly.
 *
 * @returns The bypass secret string.
 */
async function ensureProtectionBypass(
  projectId: string,
  token: string,
  teamId?: string | null,
): Promise<string> {
  // Fast path: Vercel auto-injects this env var when a bypass secret exists
  const existing = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (existing) {
    return existing;
  }

  // No bypass secret yet -- generate one via the Vercel API
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
  if (!bypasses || Object.keys(bypasses).length === 0) {
    throw new Error("Vercel API returned empty protectionBypass response");
  }

  // Find the newly generated automation-bypass secret
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
    throw new Error(
      "Could not find automation-bypass secret in Vercel API response",
    );
  }

  // Mark this secret as the VERCEL_AUTOMATION_BYPASS_SECRET env var so
  // future builds get it automatically without an API call
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

  return newSecret;
}

// =============================================================================
// Vercel Webhook Registration
// =============================================================================

/**
 * Ensures a Vercel webhook exists for `deployment.cleanup` events targeting
 * the given URL. If one already exists, this is a no-op. If not, it creates
 * one and returns the webhook secret for signature verification.
 *
 * @returns The webhook secret if a new webhook was created, or `null` if one already exists.
 */
async function ensureVercelWebhook(
  projectId: string,
  webhookUrl: string,
  token: string,
  teamId?: string | null,
): Promise<string | null> {
  const vercel = new Vercel({ bearerToken: token });

  // List existing webhooks and check for a match
  const webhooks = await vercel.webhooks.getWebhooks({
    ...(teamId ? { teamId } : {}),
  });

  const existing = (webhooks as Array<{ url: string; events: string[] }>).find(
    (w) => w.url === webhookUrl && w.events.includes("deployment.cleanup"),
  );

  if (existing) {
    return null;
  }

  // Create a new webhook scoped to this project
  const result = await vercel.webhooks.createWebhook({
    ...(teamId ? { teamId } : {}),
    requestBody: {
      url: webhookUrl,
      events: ["deployment.cleanup"],
      projectIds: [projectId],
    },
  });

  return result.secret;
}

/**
 * Stores VERCEL_WEBHOOK_SECRET as a project-level env var targeting all
 * environments (production, preview, development) so the cleanup handler
 * can verify webhook signatures regardless of which environment serves it.
 */
async function setWebhookSecretEnvVar(
  projectId: string,
  secret: string,
  token: string,
  teamId?: string | null,
): Promise<void> {
  const vercel = new Vercel({ bearerToken: token });

  await vercel.projects.createProjectEnv({
    idOrName: projectId,
    upsert: "true",
    teamId: teamId ?? undefined,
    requestBody: {
      key: "VERCEL_WEBHOOK_SECRET",
      value: secret,
      type: "encrypted",
      target: ["production", "preview", "development"],
    },
  });
}

// =============================================================================
// Webhook Signature Verification
// =============================================================================

function verifySignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const expected = crypto.createHmac("sha1", secret).update(body).digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

/**
 * Extracts and cleans the branch name from deployment metadata.
 */
function extractBranchFromMeta(meta: Record<string, string>): string | null {
  const branchRef = meta.githubCommitRef;
  if (!branchRef) return null;
  return branchRef.replace(/^refs\/heads\//, "");
}
