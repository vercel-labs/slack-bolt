import { HTTPError } from "../http-error";
import type { Manifest } from "../manifest/types";
import {
  SlackAPIError,
  SlackManifestCreateError,
  SlackManifestExportError,
  SlackManifestUpdateError,
} from "./errors";
import type {
  InstallResponse,
  InstallResult,
  SlackManifestCreateResponse,
  SlackManifestExportResponse,
  SlackManifestUpdateResponse,
} from "./types";

export {
  SlackAPIError,
  SlackManifestCreateError,
  SlackManifestExportError,
  SlackManifestUpdateError,
} from "./errors";
export type {
  InstallResult,
  SlackManifestCreateResponse,
  SlackManifestExportResponse,
  SlackManifestUpdateResponse,
} from "./types";

export async function createSlackApp({
  token,
  manifest,
}: {
  token: string;
  manifest: Manifest;
}): Promise<SlackManifestCreateResponse> {
  const response = await fetch("https://slack.com/api/apps.manifest.create", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ manifest: JSON.stringify(manifest) }),
  });

  if (!response.ok) {
    throw new HTTPError(
      "Failed to create Slack app",
      response.status,
      response.statusText,
    );
  }

  const data = (await response.json()) as SlackManifestCreateResponse;

  if (!data.ok) {
    throw new SlackManifestCreateError(
      data?.error ?? "Unknown error",
      data?.errors,
    );
  }

  return data;
}

export async function updateSlackApp({
  token,
  appId,
  manifest,
}: {
  token: string;
  appId: string;
  manifest: Manifest;
}): Promise<SlackManifestUpdateResponse> {
  const response = await fetch("https://slack.com/api/apps.manifest.update", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      app_id: appId,
      manifest: JSON.stringify(manifest),
    }),
  });

  if (!response.ok) {
    throw new HTTPError(
      "Failed to update Slack app",
      response.status,
      response.statusText,
    );
  }

  const data = (await response.json()) as SlackManifestUpdateResponse;

  if (!data.ok) {
    throw new SlackManifestUpdateError(
      data?.error ?? "Unknown error",
      data?.errors,
    );
  }

  return data;
}

export async function exportSlackApp({
  token,
  appId,
}: {
  token: string;
  appId: string;
}): Promise<SlackManifestExportResponse> {
  const response = await fetch("https://slack.com/api/apps.manifest.export", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ app_id: appId }),
  });

  if (!response.ok) {
    throw new HTTPError(
      "Failed to export Slack app",
      response.status,
      response.statusText,
    );
  }

  const data = (await response.json()) as SlackManifestExportResponse;

  if (!data.ok) {
    throw new SlackManifestExportError(data?.error ?? "Unknown error");
  }

  return data;
}

/** Slack error codes for a failure on Slack's side, not a verdict on the app. */
const TRANSIENT_SLACK_ERRORS = new Set([
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);

/**
 * Whether a failed call says nothing about the app or the token: Slack was
 * unreachable, overloaded or rate limiting.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof HTTPError) {
    return error.status === 429 || error.status >= 500;
  }
  // fetch rejects with a TypeError when the request never got an answer.
  if (error instanceof TypeError) return true;
  return (
    error instanceof SlackAPIError && TRANSIENT_SLACK_ERRORS.has(error.code)
  );
}

/**
 * What Slack answers for an app that doesn't exist. A deleted app is
 * `app_not_found`, and an ID Slack never issued is `invalid_app_id`.
 */
const APP_GONE_ERRORS = new Set(["app_not_found", "invalid_app_id"]);

/** Whether Slack said the app doesn't exist. */
export function isAppGone(error: unknown): boolean {
  return error instanceof SlackAPIError && APP_GONE_ERRORS.has(error.code);
}

/** Slack error codes for a token Slack won't accept, whatever the call. */
const TOKEN_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_expired",
  "token_revoked",
  "account_inactive",
]);

/** Whether Slack refused the token itself. */
export function isTokenError(error: unknown): boolean {
  return error instanceof SlackAPIError && TOKEN_ERRORS.has(error.code);
}

export async function upsertSlackApp({
  token,
  appId,
  manifest,
}: {
  token: string;
  appId?: string;
  manifest: Manifest;
}): Promise<
  | { isNew: true; app: SlackManifestCreateResponse }
  | { isNew: false; app: SlackManifestUpdateResponse }
> {
  if (appId) {
    // Creating a second app orphans the branch's existing one: its
    // SLACK_APP_ID gets overwritten, so cleanup never finds it again. So only
    // create one when Slack says this token can't reach the stored app.
    let exists = false;
    try {
      await exportSlackApp({ token, appId });
      exists = true;
    } catch (error) {
      // An outage says nothing about the app, and a token Slack refuses
      // can't create one either. Fail the build; the next one retries.
      if (isTransient(error) || isTokenError(error)) throw error;
      // The app is gone, or belongs to someone else: fall through to create.
    }
    if (exists) {
      try {
        const app = await updateSlackApp({ token, appId, manifest });
        return { isNew: false, app };
      } catch (error) {
        // The app is there, so whatever stopped the update, like a manifest
        // Slack rejects, isn't fixed by a second app. Only one deleted since
        // the export is replaced.
        if (!isAppGone(error)) throw error;
      }
    }
  }

  const app = await createSlackApp({ token, manifest });
  return { isNew: true, app };
}

export async function deleteSlackApp({
  token,
  appId,
}: {
  token: string;
  appId: string;
}): Promise<void> {
  const response = await fetch("https://slack.com/api/apps.manifest.delete", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ app_id: appId }),
  });

  if (!response.ok) {
    throw new HTTPError(
      "Failed to delete Slack app",
      response.status,
      response.statusText,
    );
  }

  const data = (await response.json()) as { ok: boolean; error?: string };

  if (!data.ok) {
    throw new SlackAPIError(
      "apps.manifest.delete",
      data.error ?? "Unknown error",
    );
  }
}

/** How deleting a Slack app went. */
export type DeleteOutcome =
  /** Slack deleted it. */
  | { status: "deleted" }
  /** It was already gone. */
  | { status: "gone" }
  /** It's still there, or Slack couldn't say: `error` is why. */
  | { status: "failed"; error: unknown };

/**
 * Deletes a Slack app, and says whether it's gone afterwards. Slack answers
 * the delete of an app that was already deleted with `no_permission`, the
 * same as for an app the token may not delete, so ask for the app to tell
 * them apart.
 */
export async function removeSlackApp({
  token,
  appId,
}: {
  token: string;
  appId: string;
}): Promise<DeleteOutcome> {
  try {
    await deleteSlackApp({ token, appId });
    return { status: "deleted" };
  } catch (error) {
    if (isAppGone(error)) return { status: "gone" };
    if (isTransient(error) || isTokenError(error)) {
      return { status: "failed", error };
    }
    try {
      await exportSlackApp({ token, appId });
    } catch (exportError) {
      if (isAppGone(exportError)) return { status: "gone" };
    }
    return { status: "failed", error };
  }
}

export type RotateTokenResult = {
  token: string;
  refreshToken: string;
  exp: number;
};

export async function rotateConfigToken({
  refreshToken,
}: {
  refreshToken: string;
}): Promise<RotateTokenResult> {
  const response = await fetch("https://slack.com/api/tooling.tokens.rotate", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refreshToken }),
  });

  if (!response.ok) {
    throw new HTTPError(
      "Failed to rotate configuration token",
      response.status,
      response.statusText,
    );
  }

  const data = (await response.json()) as {
    ok: boolean;
    error?: string;
    token?: string;
    refresh_token?: string;
    exp?: number;
  };

  if (!data.ok || !data.token || !data.refresh_token) {
    throw new SlackAPIError(
      "tooling.tokens.rotate",
      data.error ?? "Unknown error rotating token",
    );
  }

  return {
    token: data.token,
    refreshToken: data.refresh_token,
    exp: data.exp ?? 0,
  };
}

export type AuthTestResult = {
  userId: string;
  teamId: string;
};

export async function authTest({
  token,
}: {
  token: string;
}): Promise<AuthTestResult> {
  const response = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });

  if (!response.ok) {
    throw new HTTPError(
      "Auth test failed",
      response.status,
      response.statusText,
    );
  }

  const data = (await response.json()) as {
    ok: boolean;
    error?: string;
    user_id?: string;
    team_id?: string;
  };

  if (!data.ok) {
    throw new SlackAPIError("auth.test", data.error ?? "Unknown error");
  }

  return {
    userId: data.user_id ?? "",
    teamId: data.team_id ?? "",
  };
}

export async function verifyServiceTokenAccess(params: {
  serviceToken: string;
  appId: string;
}): Promise<{ hasAccess: boolean }> {
  try {
    await exportSlackApp({ token: params.serviceToken, appId: params.appId });
    return { hasAccess: true };
  } catch {
    return { hasAccess: false };
  }
}

export async function installApp(params: {
  serviceToken?: string;
  appId: string;
  botScopes: string[];
  outgoingDomains?: string[];
}): Promise<InstallResult> {
  const { serviceToken, appId, botScopes, outgoingDomains } = params;

  if (!serviceToken) {
    return {
      status: "missing_service_token",
    };
  }

  const response = await fetch("https://slack.com/api/apps.developerInstall", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      app_id: appId,
      bot_scopes: botScopes,
      outgoing_domains: outgoingDomains ?? [],
    }),
  });

  if (!response.ok) {
    return {
      status: "slack_api_error",
      error: `${response.status} ${response.statusText}`.trim(),
    };
  }

  const data = (await response.json()) as InstallResponse;

  if (data.error || !data.ok) {
    switch (data.error) {
      case "app_approval_request_eligible":
        return {
          status: "app_approval_request_eligible",
        };
      case "app_approval_request_pending":
        return {
          status: "app_approval_request_pending",
        };
      case "app_approval_request_denied":
        return {
          status: "app_approval_request_denied",
        };
      case "invalid_app_id": {
        if (serviceToken) {
          const { hasAccess } = await verifyServiceTokenAccess({
            serviceToken,
            appId,
          });
          if (!hasAccess) {
            return { status: "no_access" };
          }
        }
        return { status: "invalid_app_id" };
      }
      default:
        // Keep Slack's code, like `service_limits_exceeded` for a workspace
        // that has reached its app limit, so the caller can say why.
        return {
          status: "unknown_error",
          error: data.error ?? "Unknown error",
        };
    }
  }

  return {
    status: "installed",
    botToken: data.api_access_tokens?.bot,
    appLevelToken: data.api_access_tokens?.app_level,
    userToken: data.api_access_tokens?.user,
  };
}
