import crypto from "node:crypto";

// =============================================================================
// Vercel Webhook Payload Types
// =============================================================================

/** Base payload structure shared by deployment webhook events */
interface DeploymentPayloadBase {
  /** The ID of the webhook delivery */
  id: string;
  /** The date and time the webhook event was generated */
  createdAt: number;
  /** The region the event occurred in (possibly null) */
  region: string | null;
  /** The payload of the webhook */
  payload: {
    /** Team information */
    team: {
      /** The ID of the event's team (possibly null) */
      id: string | null;
    };
    /** User information */
    user: {
      /** The ID of the event's user */
      id: string;
    };
    /** Deployment information */
    deployment: {
      /** The ID of the deployment */
      id: string;
      /** A Map of deployment metadata (includes git info like githubCommitSha, githubCommitRepo, githubCommitRef) */
      meta: Record<string, string>;
      /** The URL of the deployment */
      url: string;
      /** The project name used in the deployment URL */
      name: string;
    };
    /** Links to Vercel Dashboard */
    links: {
      /** The URL on the Vercel Dashboard to inspect the deployment */
      deployment: string;
      /** The URL on the Vercel Dashboard to the project */
      project: string;
    };
    /** A String that indicates the target. Possible values are `production`, `staging` or `null` */
    target: "production" | "staging" | null;
    /** Project information */
    project: {
      /** The ID of the project */
      id: string;
    };
    /** The plan type of the deployment */
    plan: string;
    /** An array of the supported regions for the deployment */
    regions: string[];
  };
}

/** Payload for deployment.succeeded webhook event */
export interface DeploymentSucceededPayload extends DeploymentPayloadBase {
  /** The event type */
  type: "deployment.succeeded";
}

/** Payload for deployment.ready webhook event (deployment is accessible) */
export interface DeploymentReadyPayload extends DeploymentPayloadBase {
  /** The event type */
  type: "deployment.ready";
}

/** Payload for deployment.cleanup webhook event (deployment is being removed) */
export interface DeploymentCleanupPayload {
  /** The event type */
  type: "deployment.cleanup";
  /** The ID of the webhook delivery */
  id: string;
  /** The date and time the webhook event was generated */
  createdAt: number;
  /** The region the event occurred in (possibly null) */
  region: string | null;
  /** The payload of the webhook */
  payload: {
    /** Team information */
    team: {
      /** The ID of the event's team (possibly null) */
      id: string | null;
    };
    /** User information */
    user: {
      /** The ID of the event's user */
      id: string;
    };
    /** Deployment information */
    deployment: {
      /** The ID of the deployment */
      id: string;
      /** A Map of deployment metadata */
      meta: Record<string, string>;
      /** The URL of the deployment */
      url: string;
      /** The project name used in the deployment URL */
      name: string;
      /** An array of aliases assigned to the deployment */
      alias: string[];
      /** The deployment target */
      target: "production" | "staging" | null;
      /** The ID of the custom environment, if used */
      customEnvironmentId?: string;
      /** An array of the supported regions for the deployment */
      regions: string[];
    };
    /** Project information */
    project: {
      /** The ID of the project */
      id: string;
    };
  };
}

// =============================================================================
// Slack App Manifest Types
// =============================================================================

/** Slack App Manifest structure for apps.manifest.create API */
export interface SlackAppManifest {
  /** Display information for the app */
  display_information: {
    /** The name of the app (max 35 characters) */
    name: string;
    /** A short description of the app */
    description?: string;
    /** A longer description of the app */
    long_description?: string;
    /** The background color of the app (hex color code) */
    background_color?: string;
  };
  /** App features configuration */
  features?: {
    /** Bot user configuration */
    bot_user?: {
      /** The display name of the bot */
      display_name: string;
      /** Whether the bot should always appear online */
      always_online?: boolean;
    };
    /** Slash commands configuration */
    slash_commands?: Array<{
      /** The command name (e.g., "/weather") */
      command: string;
      /** The URL to send the command payload to */
      url?: string;
      /** A short description of the command */
      description: string;
      /** Hint text for the command */
      usage_hint?: string;
      /** Whether to escape special characters */
      should_escape?: boolean;
    }>;
  };
  /** OAuth configuration */
  oauth_config?: {
    /** OAuth scopes */
    scopes?: {
      /** Bot token scopes */
      bot?: string[];
      /** User token scopes */
      user?: string[];
    };
    /** Redirect URLs for OAuth */
    redirect_urls?: string[];
  };
  /** App settings */
  settings?: {
    /** Event subscriptions configuration */
    event_subscriptions?: {
      /** The URL to send events to */
      request_url?: string;
      /** Bot events to subscribe to */
      bot_events?: string[];
      /** User events to subscribe to */
      user_events?: string[];
    };
    /** Interactivity configuration */
    interactivity?: {
      /** Whether interactivity is enabled */
      is_enabled?: boolean;
      /** The URL to send interactive payloads to */
      request_url?: string;
      /** The URL for message menu options */
      message_menu_options_url?: string;
    };
    /** Whether socket mode is enabled */
    socket_mode_enabled?: boolean;
    /** Whether token rotation is enabled */
    token_rotation_enabled?: boolean;
  };
}

/** Response from Slack's apps.manifest.create API */
export interface SlackManifestCreateResponse {
  /** Whether the request was successful */
  ok: boolean;
  /** The ID of the created app */
  app_id?: string;
  /** App credentials */
  credentials?: {
    /** The client ID for OAuth */
    client_id: string;
    /** The client secret for OAuth */
    client_secret: string;
    /** The verification token (deprecated, use signing secret) */
    verification_token: string;
    /** The signing secret for request verification */
    signing_secret: string;
  };
  /** The URL to authorize/install the app */
  oauth_authorize_url?: string;
  /** Error code if the request failed */
  error?: string;
  /** Detailed errors for invalid manifest */
  errors?: Array<{
    message: string;
    pointer: string;
  }>;
}

/** Response from Slack's apps.manifest.delete API */
export interface SlackManifestDeleteResponse {
  /** Whether the request was successful */
  ok: boolean;
  /** Error code if the request failed */
  error?: string;
}

/** Response from Slack's apps.manifest.validate API */
export interface SlackManifestValidateResponse {
  /** Whether the request was successful */
  ok: boolean;
  /** Error code if the request failed */
  error?: string;
  /** Detailed errors for invalid manifest */
  errors?: Array<{
    message: string;
    pointer: string;
  }>;
}

/** Options for createSlackAppFromDeployment function */
export interface CreateSlackAppOptions {
  /**
   * Path to the manifest file in the repository
   * @default "manifest.json"
   */
  manifestPath?: string;
  /**
   * Override the repository to fetch the manifest from.
   * Format: "owner/repo" (e.g., "vercel/slack-bolt")
   * @default Uses Vercel deployment metadata (githubCommitRepo)
   */
  repository?: string;
  /**
   * Override the git ref (branch/tag/commit) to fetch the manifest from.
   * @default Uses Vercel deployment metadata (githubCommitSha)
   */
  gitRef?: string;
  /**
   * Slack configuration token for creating apps
   * @default process.env.SLACK_CONFIGURATION_TOKEN
   */
  slackConfigToken?: string;
  /**
   * GitHub token for accessing private repositories
   * @default process.env.GITHUB_TOKEN
   */
  githubToken?: string;
}

// =============================================================================
// Webhook Handler Options
// =============================================================================

export interface VercelWebhookHandlerOptions {
  /**
   * The secret used to verify webhook signatures.
   * For integrations, use the Integration Secret (Client Secret).
   * For account webhooks, use the secret displayed when creating the webhook.
   * @default process.env.VERCEL_WEBHOOK_SECRET
   */
  secret?: string;
  /**
   * If true, verifies the webhook signature.
   * @default true
   */
  signatureVerification?: boolean;
  /**
   * Callback function invoked when a deployment.succeeded event is received.
   * This fires after all blocking checks have passed.
   */
  onDeploymentSucceeded?: (
    payload: DeploymentSucceededPayload,
  ) => Promise<void> | void;
  /**
   * Callback function invoked when a deployment.cleanup event is received.
   * This fires when a deployment is fully removed (due to explicit removal or retention rules).
   * Use this to clean up associated resources like Slack apps.
   */
  onDeploymentCleanup?: (
    payload: DeploymentCleanupPayload,
  ) => Promise<void> | void;
}

/**
 * Computes HMAC SHA1 signature for webhook verification.
 */
function computeSignature(body: string, secret: string): string {
  return crypto.createHmac("sha1", secret).update(body).digest("hex");
}

/**
 * Verifies the webhook signature using constant-time comparison.
 */
function verifySignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const expectedSignature = computeSignature(body, secret);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    );
  } catch {
    return false;
  }
}

/**
 * Creates a Vercel webhook handler for deployment events.
 *
 * @example
 * ```typescript
 * import { createVercelWebhookHandler } from '@vercel/slack-bolt/preview';
 *
 * const handler = createVercelWebhookHandler({
 *   secret: process.env.VERCEL_WEBHOOK_SECRET,
 *   onDeploymentSucceeded: async (event) => {
 *     console.log(`Deployment ${event.payload.deployment.id} succeeded!`);
 *     console.log(`URL: https://${event.payload.deployment.url}`);
 *   },
 * });
 *
 * export const POST = handler;
 * ```
 */
export function createVercelWebhookHandler(
  options: VercelWebhookHandlerOptions = {},
): (req: Request) => Promise<Response> {
  const {
    secret = process.env.VERCEL_WEBHOOK_SECRET,
    signatureVerification = true,
    onDeploymentSucceeded,
    onDeploymentCleanup,
  } = options;

  return async (req: Request): Promise<Response> => {
    try {
      const rawBody = await req.text();

      // Verify webhook signature
      if (signatureVerification) {
        if (!secret) {
          console.error(
            "VERCEL_WEBHOOK_SECRET is not set. Set it or disable signature verification.",
          );
          return new Response(
            JSON.stringify({
              error: "Webhook secret not configured",
              code: "missing_secret",
            }),
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        const signature = req.headers.get("x-vercel-signature");

        if (!signature) {
          return new Response(
            JSON.stringify({
              error: "Missing x-vercel-signature header",
              code: "missing_signature",
            }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (!verifySignature(rawBody, signature, secret)) {
          return new Response(
            JSON.stringify({
              error: "Invalid signature",
              code: "invalid_signature",
            }),
            {
              status: 403,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      }

      // Parse the webhook payload
      const event = JSON.parse(rawBody) as
        | DeploymentSucceededPayload
        | DeploymentCleanupPayload;

      console.log(`[slack-bolt] Received Vercel webhook: ${event.type}`);
      console.log(`[slack-bolt] Deployment ID: ${event.payload?.deployment?.id}`);
      // @ts-expect-error - target only exists on some event types
      console.log(`[slack-bolt] Target: ${event.payload?.target ?? "N/A"}`);

      switch (event.type) {
        case "deployment.succeeded":
          if (onDeploymentSucceeded) {
            console.log("[slack-bolt] Calling onDeploymentSucceeded handler");
            await onDeploymentSucceeded(event);
          }
          break;

        case "deployment.cleanup":
          if (onDeploymentCleanup) {
            console.log("[slack-bolt] Calling onDeploymentCleanup handler");
            await onDeploymentCleanup(event);
          }
          break;

        default:
          console.log(`[slack-bolt] No handler for event type: ${(event as { type: string }).type}`);
      }

      return new Response(JSON.stringify({ received: true, type: event.type }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Error processing Vercel webhook:", error);
      return new Response(
        JSON.stringify({
          error: "Internal server error",
          code: "internal_error",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  };
}

// =============================================================================
// Slack App Creation Functions
// =============================================================================

/**
 * Fetches a Slack app manifest from a GitHub repository at a specific commit.
 *
 * @param owner - The GitHub repository owner
 * @param repo - The GitHub repository name
 * @param commitSha - The commit SHA to fetch the manifest from
 * @param manifestPath - The path to the manifest file in the repository
 * @param githubToken - Optional GitHub token for private repositories
 * @returns The parsed Slack app manifest
 * @throws Error if the fetch fails or the manifest is invalid
 */
async function fetchManifestFromGitHub(
  owner: string,
  repo: string,
  commitSha: string,
  manifestPath: string,
  githubToken?: string,
): Promise<SlackAppManifest> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${manifestPath}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (githubToken) {
    headers.Authorization = `token ${githubToken}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Manifest file not found at ${manifestPath} in ${owner}/${repo}@${commitSha.slice(0, 7)}`,
      );
    }
    throw new Error(
      `Failed to fetch manifest from GitHub: ${response.status} ${response.statusText}`,
    );
  }

  const text = await response.text();

  try {
    return JSON.parse(text) as SlackAppManifest;
  } catch {
    throw new Error(
      `Failed to parse manifest as JSON from ${manifestPath}. Ensure it's valid JSON.`,
    );
  }
}

/**
 * Updates URLs in a Slack app manifest with the deployment URL.
 * Updates: event_subscriptions.request_url, interactivity.request_url, slash_commands[].url
 *
 * @param manifest - The original manifest
 * @param deploymentUrl - The Vercel deployment URL (without protocol)
 * @returns A new manifest with updated URLs
 */
function updateManifestUrls(
  manifest: SlackAppManifest,
  deploymentUrl: string,
): SlackAppManifest {
  const baseUrl = `https://${deploymentUrl}`;
  const updated = structuredClone(manifest);

  // Update event subscriptions request URL
  if (updated.settings?.event_subscriptions?.request_url) {
    const path = extractPath(updated.settings.event_subscriptions.request_url);
    updated.settings.event_subscriptions.request_url = `${baseUrl}${path}`;
  }

  // Update interactivity request URL
  if (updated.settings?.interactivity?.request_url) {
    const path = extractPath(updated.settings.interactivity.request_url);
    updated.settings.interactivity.request_url = `${baseUrl}${path}`;
  }

  // Update slash commands URLs
  if (updated.features?.slash_commands) {
    for (const command of updated.features.slash_commands) {
      if (command.url) {
        const path = extractPath(command.url);
        command.url = `${baseUrl}${path}`;
      }
    }
  }

  return updated;
}

/**
 * Extracts the path portion from a URL or returns the original string if it's just a path.
 */
function extractPath(urlOrPath: string): string {
  try {
    const url = new URL(urlOrPath);
    return url.pathname + url.search;
  } catch {
    // If it's not a valid URL, assume it's already a path
    return urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`;
  }
}

/**
 * Updates the app name in the manifest to include the branch name.
 * Format: "AppName (branch-name)"
 * Truncates to 35 characters (Slack's limit).
 *
 * @param manifest - The original manifest
 * @param branchName - The git branch name
 * @returns A new manifest with the updated name
 */
function updateManifestName(
  manifest: SlackAppManifest,
  branchName: string,
): SlackAppManifest {
  const updated = structuredClone(manifest);

  // Clean up branch name (remove refs/heads/ prefix if present)
  const cleanBranch = branchName.replace(/^refs\/heads\//, "");

  // Update display_information.name
  const maxLength = 35;
  updated.display_information.name = formatNameWithBranch(
    updated.display_information.name,
    cleanBranch,
    maxLength,
  );

  // Update bot_user.display_name if present
  if (updated.features?.bot_user?.display_name) {
    updated.features.bot_user.display_name = formatNameWithBranch(
      updated.features.bot_user.display_name,
      cleanBranch,
      maxLength,
    );
  }

  return updated;
}

/**
 * Formats a name with a branch suffix, truncating if necessary.
 */
function formatNameWithBranch(
  originalName: string,
  branch: string,
  maxLength: number,
): string {
  const suffix = ` (${branch})`;

  if (originalName.length + suffix.length <= maxLength) {
    return `${originalName}${suffix}`;
  }

  // Truncate the name to fit (use .. instead of ellipsis which Slack doesn't allow)
  const availableForName = maxLength - suffix.length - 2; // -2 for ".."
  if (availableForName > 3) {
    const truncatedName = `${originalName.slice(0, availableForName)}..`;
    return `${truncatedName}${suffix}`;
  }

  // Branch name is very long, just truncate everything
  return `${originalName} (${branch})`.slice(0, maxLength);
}

/**
 * Creates a new Slack app using the apps.manifest.create API.
 *
 * @param manifest - The Slack app manifest
 * @param token - The Slack configuration token
 * @returns The API response with app details and credentials
 * @throws Error if the API call fails
 */
/**
 * Validates a Slack app manifest using the apps.manifest.validate API.
 */
async function validateSlackManifest(
  manifest: SlackAppManifest,
  token: string,
): Promise<void> {
  console.log("[slack-bolt] Validating Slack app manifest...");

  const response = await fetch("https://slack.com/api/apps.manifest.validate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ manifest: JSON.stringify(manifest) }),
  });

  if (!response.ok) {
    throw new Error(
      `Slack API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const result = (await response.json()) as SlackManifestValidateResponse;

  if (!result.ok) {
    const errorDetails = result.errors
      ? result.errors.map((e) => `${e.pointer}: ${e.message}`).join("; ")
      : result.error;
    throw new Error(`Invalid Slack app manifest: ${errorDetails}`);
  }

  console.log("[slack-bolt] Manifest validation passed");
}

async function createSlackAppFromManifest(
  manifest: SlackAppManifest,
  token: string,
): Promise<SlackManifestCreateResponse> {
  // Validate manifest before creating
  await validateSlackManifest(manifest, token);

  console.log("[slack-bolt] Creating Slack app...");

  const response = await fetch("https://slack.com/api/apps.manifest.create", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ manifest: JSON.stringify(manifest) }),
  });

  if (!response.ok) {
    throw new Error(
      `Slack API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const result = (await response.json()) as SlackManifestCreateResponse;

  if (!result.ok) {
    const errorDetails = result.errors
      ? result.errors.map((e) => `${e.pointer}: ${e.message}`).join("; ")
      : result.error;
    throw new Error(`Failed to create Slack app: ${errorDetails}`);
  }

  return result;
}

/**
 * Creates a new Slack app from a Vercel deployment event.
 *
 * This function:
 * 1. Extracts GitHub metadata from the deployment
 * 2. Fetches the app manifest from the repository at the deployed commit
 * 3. Updates manifest URLs to point to the deployment
 * 4. Appends the branch name to the app name
 * 5. Creates the Slack app via the API
 *
 * @param event - The Vercel deployment.ready webhook payload
 * @param options - Configuration options
 * @returns The created Slack app details including app_id and credentials
 * @throws Error if GitHub metadata is missing or any step fails
 *
 * @example
 * ```typescript
 * const handler = createVercelWebhookHandler({
 *   onDeploymentSucceeded: async (event) => {
 *     if (event.payload.target !== 'production') {
 *       const result = await createSlackAppFromDeployment(event, {
 *         manifestPath: 'slack-manifest.json',
 *       });
 *       console.log(`Created Slack app: ${result.app_id}`);
 *     }
 *   },
 * });
 * ```
 */
export async function createSlackAppFromDeployment(
  event: DeploymentSucceededPayload,
  options: CreateSlackAppOptions = {},
): Promise<SlackManifestCreateResponse> {
  const {
    manifestPath = "manifest.json",
    repository,
    gitRef,
    slackConfigToken = process.env.SLACK_CONFIGURATION_TOKEN,
    githubToken = process.env.GITHUB_TOKEN,
  } = options;

  // Validate Slack token
  if (!slackConfigToken) {
    throw new Error(
      "SLACK_CONFIGURATION_TOKEN is required. Set it in environment variables or pass via options.",
    );
  }

  // Extract GitHub metadata from deployment
  const { meta } = event.payload.deployment;
  console.log("[slack-bolt] Deployment metadata:", JSON.stringify(meta, null, 2));

  let owner: string | undefined;
  let repo: string | undefined;
  let ref: string | undefined;

  // Use override repository if provided
  if (repository) {
    const parts = repository.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `Invalid repository format: ${repository}. Expected "owner/repo".`,
      );
    }
    [owner, repo] = parts;
    console.log(`[slack-bolt] Using override repository: ${owner}/${repo}`);
  } else {
    // Try to get owner and repo from Vercel deployment metadata
    const githubCommitRepo = meta.githubCommitRepo;
    if (githubCommitRepo?.includes("/")) {
      [owner, repo] = githubCommitRepo.split("/");
    } else {
      // Try to get owner from separate field (githubOrg or githubRepoOwner)
      owner = meta.githubOrg || meta.githubRepoOwner || meta.githubCommitOrg;
      repo = githubCommitRepo;
    }
  }

  // Use override gitRef or fall back to deployment metadata
  ref = gitRef || meta.githubCommitSha;
  const branchRef = meta.githubCommitRef;

  // Validate we have all required info
  if (!ref || !owner || !repo) {
    throw new Error(
      "GitHub metadata not found in deployment. Either provide 'repository' and 'gitRef' options, " +
        "or ensure this is a GitHub-connected Vercel project. " +
        `Available meta keys: ${Object.keys(meta).join(", ")}. ` +
        `Found: ref=${ref}, owner=${owner}, repo=${repo}`,
    );
  }

  console.log(`[slack-bolt] Fetching manifest from ${owner}/${repo}@${ref}/${manifestPath}`);

  // Fetch manifest from GitHub
  const manifest = await fetchManifestFromGitHub(
    owner,
    repo,
    ref,
    manifestPath,
    githubToken,
  );

  // Update manifest URLs with deployment URL
  let updatedManifest = updateManifestUrls(
    manifest,
    event.payload.deployment.url,
  );

  // Update app name with branch name if available
  if (branchRef) {
    updatedManifest = updateManifestName(updatedManifest, branchRef);
  }

  // Create the Slack app
  return createSlackAppFromManifest(updatedManifest, slackConfigToken);
}

/**
 * Deletes a Slack app using the apps.manifest.delete API.
 *
 * Note: You must track the mapping of deployment ID to Slack app ID yourself
 * (e.g., in a database or KV store) when creating apps, then use this function
 * to delete them when the deployment is cleaned up.
 *
 * @param appId - The Slack app ID to delete
 * @param options - Configuration options
 * @returns The API response
 * @throws Error if the API call fails
 *
 * @example
 * ```typescript
 * const handler = createVercelWebhookHandler({
 *   onDeploymentSucceeded: async (event) => {
 *     const result = await createSlackAppFromDeployment(event);
 *     // Store mapping: event.payload.deployment.id -> result.app_id
 *     await db.set(`slack-app:${event.payload.deployment.id}`, result.app_id);
 *   },
 *   onDeploymentCleanup: async (event) => {
 *     // Retrieve the app ID for this deployment
 *     const appId = await db.get(`slack-app:${event.payload.deployment.id}`);
 *     if (appId) {
 *       await deleteSlackApp(appId);
 *       await db.delete(`slack-app:${event.payload.deployment.id}`);
 *     }
 *   },
 * });
 * ```
 */
export async function deleteSlackApp(
  appId: string,
  options: {
    /**
     * Slack configuration token for deleting apps
     * @default process.env.SLACK_CONFIGURATION_TOKEN
     */
    slackConfigToken?: string;
  } = {},
): Promise<SlackManifestDeleteResponse> {
  const { slackConfigToken = process.env.SLACK_CONFIGURATION_TOKEN } = options;

  if (!slackConfigToken) {
    throw new Error(
      "SLACK_CONFIGURATION_TOKEN is required. Set it in environment variables or pass via options.",
    );
  }

  const response = await fetch("https://slack.com/api/apps.manifest.delete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${slackConfigToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ app_id: appId }),
  });

  if (!response.ok) {
    throw new Error(
      `Slack API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const result = (await response.json()) as SlackManifestDeleteResponse;

  if (!result.ok) {
    throw new Error(`Failed to delete Slack app: ${result.error}`);
  }

  return result;
}

// =============================================================================
// Simple Preview Handler
// =============================================================================

/**
 * Interface for storing deployment ID to Slack app ID mappings.
 */
export interface DeploymentStore {
  /** Get the Slack app ID for a deployment */
  get(deploymentId: string): Promise<string | null | undefined>;
  /** Store the Slack app ID for a deployment */
  set(deploymentId: string, appId: string): Promise<void>;
  /** Delete the mapping for a deployment */
  delete(deploymentId: string): Promise<void>;
}

/**
 * Options for createPreviewHandler.
 */
export interface CreatePreviewHandlerOptions {
  /**
   * Store for mapping deployment IDs to Slack app IDs.
   * Required for automatic cleanup when deployments are deleted.
   */
  deployments: DeploymentStore;

  /**
   * Path to the manifest file in the repository.
   * @default "manifest.json"
   */
  manifestPath?: string;

  /**
   * Override the repository to fetch the manifest from.
   * Format: "owner/repo" (e.g., "vercel/slack-bolt")
   * @default Uses Vercel deployment metadata
   */
  repository?: string;
}

/**
 * Creates a Vercel webhook handler that automatically creates and deletes
 * Slack apps for preview deployments.
 *
 * Required environment variables:
 * - SLACK_CONFIGURATION_TOKEN - Slack app configuration token
 * - VERCEL_WEBHOOK_SECRET - Vercel webhook secret for signature verification
 *
 * Optional environment variables:
 * - GITHUB_TOKEN - For private repositories
 *
 * @example
 * ```typescript
 * // app/api/webhooks/vercel/route.ts
 * import { createPreviewHandler } from '@vercel/slack-bolt/preview';
 * import { kv } from '@vercel/kv';
 *
 * export const POST = createPreviewHandler({
 *   deployments: {
 *     get: (id) => kv.get(`slack:${id}`),
 *     set: (id, appId) => kv.set(`slack:${id}`, appId),
 *     delete: (id) => kv.del(`slack:${id}`),
 *   },
 * });
 * ```
 */
export function createPreviewHandler(
  options: CreatePreviewHandlerOptions,
): (req: Request) => Promise<Response> {
  const { deployments, manifestPath = "manifest.json", repository } = options;

  return createVercelWebhookHandler({
    onDeploymentSucceeded: async (event) => {
      // Only create apps for non-production deployments
      if (event.payload.target === "production") {
        console.log("[slack-bolt] Skipping production deployment");
        return;
      }

      console.log("[slack-bolt] Creating Slack app for preview deployment...");
      const result = await createSlackAppFromDeployment(event, {
        manifestPath,
        repository,
      });

      if (result.app_id) {
        await deployments.set(event.payload.deployment.id, result.app_id);
      }

      console.log(`[slack-bolt] Created Slack app for preview deployment`);
      console.log(`[slack-bolt]   App ID: ${result.app_id}`);
      console.log(
        `[slack-bolt]   URL: https://${event.payload.deployment.url}`,
      );
      console.log(`[slack-bolt]   Install: ${result.oauth_authorize_url}`);
    },

    onDeploymentCleanup: async (event) => {
      const appId = await deployments.get(event.payload.deployment.id);

      if (!appId) {
        return;
      }

      await deleteSlackApp(appId);
      await deployments.delete(event.payload.deployment.id);

      console.log(`[slack-bolt] Deleted Slack app for deployment cleanup`);
      console.log(`[slack-bolt]   App ID: ${appId}`);
    },
  });
}

// =============================================================================
// Default Exports
// =============================================================================

/**
 * Default preview deployment webhook handler.
 * Override the behavior by using `createVercelWebhookHandler` with custom options.
 */
export const previewHandler = createVercelWebhookHandler();
