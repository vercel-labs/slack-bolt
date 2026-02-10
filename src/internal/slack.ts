import { WebClient } from "@slack/web-api";
import type { Manifest } from "@slack/web-api/dist/types/request/manifest";
import { SlackAppApprovalError, SlackAppNotFoundError } from "./errors";
import { log, redact } from "./logger";
import type {
  CheckTokenResult,
  CreateAppResult,
  DeveloperInstallResponse,
  SlackOps,
  TokenRotationResponse,
} from "./types";

/**
 * Creates a real SlackOps implementation backed by the Slack Web API.
 *
 * @param configToken - Slack configuration token for app CRUD
 * @param serviceToken - Optional Slack CLI service token for app installation
 */
export function createSlackOps(
  configToken: string,
  serviceToken?: string,
): SlackOps {
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

export async function deleteSlackApp(
  appId: string,
  token: string,
): Promise<void> {
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

export function extractSlackApiError(error: unknown): {
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

const AUTH_ERROR_CODES = new Set([
  "invalid_auth",
  "token_expired",
  "token_revoked",
  "not_authed",
]);

export async function checkSlackConfigToken(
  configToken: string,
  refreshToken?: string,
): Promise<CheckTokenResult> {
  log.debug("Checking Slack configuration token validity...");
  const client = new WebClient(configToken);

  try {
    await client.auth.test();
    log.debug("Configuration token is valid");
    return { token: configToken, rotated: false };
  } catch (error) {
    const apiError = extractSlackApiError(error);
    const code = apiError?.code ?? "";

    if (!AUTH_ERROR_CODES.has(code)) {
      // Not an auth error — something else went wrong
      throw error;
    }

    log.debug(`Configuration token is expired or invalid (${code})`);

    if (!refreshToken) {
      throw new Error(
        `Slack configuration token is expired (${code}). ` +
          "Set SLACK_CONFIG_REFRESH_TOKEN to enable automatic token refresh.",
      );
    }

    log.debug("Rotating configuration token via tooling.tokens.rotate...");
    return rotateSlackConfigToken(refreshToken);
  }
}

export async function rotateSlackConfigToken(
  refreshToken: string,
): Promise<CheckTokenResult> {
  const response = await fetch("https://slack.com/api/tooling.tokens.rotate", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ refresh_token: refreshToken }),
  });

  const data = (await response.json()) as TokenRotationResponse;

  log.debug("tooling.tokens.rotate response:");
  log.debug(`  ok = ${data.ok}`);
  log.debug(`  error = ${data.error ?? "<none>"}`);
  log.debug(`  token = ${redact(data.token)}`);
  log.debug(`  refresh_token = ${redact(data.refresh_token)}`);
  if (data.exp) {
    log.debug(`  expires = ${new Date(data.exp * 1000).toISOString()}`);
  }

  if (!data.ok || !data.token || !data.refresh_token) {
    throw new Error(
      `Failed to rotate Slack configuration token: ${data.error ?? "missing token in response"}`,
    );
  }

  log.debug("Configuration token rotated successfully");
  return {
    token: data.token,
    newRefreshToken: data.refresh_token,
    rotated: true,
  };
}
