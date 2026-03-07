import type { Manifest } from "../manifest/types";
import { HTTPError } from "../vercel/errors";
import {
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
    try {
      await exportSlackApp({ token, appId });
      const app = await updateSlackApp({ token, appId, manifest });
      return { isNew: false, app };
    } catch {
      // App doesn't exist or isn't accessible — fall through to create
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
    throw new Error(data.error ?? "Unknown error");
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
    throw new Error(data.error ?? "Unknown error rotating token");
  }

  return {
    token: data.token,
    refreshToken: data.refresh_token,
    exp: data.exp ?? 0,
  };
}

export async function authTest({ token }: { token: string }): Promise<void> {
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

  const data = (await response.json()) as { ok: boolean; error?: string };

  if (!data.ok) {
    throw new Error(data.error ?? "Unknown error");
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
      error: response.statusText,
    };
  }

  const data = (await response.json()) as InstallResponse;

  if (data.error) {
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
      default:
        return {
          status: "unknown_error",
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
