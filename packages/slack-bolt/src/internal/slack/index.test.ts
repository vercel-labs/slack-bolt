import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPError } from "../vercel/errors";
import {
  SlackManifestCreateError,
  SlackManifestExportError,
  SlackManifestUpdateError,
} from "./errors";
import {
  createSlackApp,
  exportSlackApp,
  installApp,
  rotateConfigToken,
  updateSlackApp,
  upsertSlackApp,
} from "./index";

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockClear();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(
  body: unknown,
  status = 200,
  statusText = "OK",
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

const testManifest = { display_information: { name: "Test App" } };

// ---------------------------------------------------------------------------
// createSlackApp
// ---------------------------------------------------------------------------

describe("createSlackApp", () => {
  const successBody = {
    ok: true,
    app_id: "A123",
    credentials: {
      client_id: "cid",
      client_secret: "csec",
      verification_token: "vt",
      signing_secret: "ss",
    },
    oauth_authorize_url: "https://slack.com/oauth",
  };

  it("sends a POST to apps.manifest.create with correct headers", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(successBody));

    await createSlackApp({ token: "tok", manifest: testManifest });

    const [url, opts] = mockFetch?.mock.lastCall ?? [];
    expect(url).toBe("https://slack.com/api/apps.manifest.create");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok");
    expect(opts.headers["Content-Type"]).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("returns the full response data on success", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(successBody));

    const result = await createSlackApp({
      token: "tok",
      manifest: testManifest,
    });

    expect(result).toEqual(successBody);
  });

  it("double-serializes the manifest in the request body", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(successBody));

    await createSlackApp({ token: "tok", manifest: testManifest });

    const body = JSON.parse(mockFetch?.mock.lastCall?.[1]?.body ?? "");
    expect(body.manifest).toBe(JSON.stringify(testManifest));
  });

  it("throws HTTPError with status and statusText on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({}, 500, "Internal Server Error"),
    );

    try {
      await createSlackApp({ token: "tok", manifest: testManifest });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPError);
      const httpErr = err as HTTPError;
      expect(httpErr.status).toBe(500);
      expect(httpErr.statusText).toBe("Internal Server Error");
    }
  });

  it("throws SlackManifestCreateError with structured errors when API returns ok:false", async () => {
    const apiErrors = [{ message: "bad name", pointer: "/name" }];
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "invalid_manifest", errors: apiErrors }),
    );

    try {
      await createSlackApp({ token: "tok", manifest: testManifest });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SlackManifestCreateError);
      expect((err as SlackManifestCreateError).message).toBe(
        "invalid_manifest",
      );
      expect((err as SlackManifestCreateError).errors).toEqual(apiErrors);
    }
  });

  it("uses 'Unknown error' when API returns ok:false without an error field", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: false }));

    await expect(
      createSlackApp({ token: "tok", manifest: testManifest }),
    ).rejects.toThrow("Unknown error");
  });

  it("propagates network errors from fetch", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      createSlackApp({ token: "tok", manifest: testManifest }),
    ).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// updateSlackApp
// ---------------------------------------------------------------------------

describe("updateSlackApp", () => {
  const successBody = { ok: true, app_id: "A1", permissions_updated: false };
  const args = { token: "tok", appId: "A1", manifest: testManifest };

  it("sends a POST to apps.manifest.update with correct headers and body", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(successBody));

    await updateSlackApp(args);

    const [url, opts] = mockFetch.mock.lastCall;
    expect(url).toBe("https://slack.com/api/apps.manifest.update");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok");
    expect(opts.headers["Content-Type"]).toBe(
      "application/json; charset=utf-8",
    );
    const body = JSON.parse(opts.body);
    expect(body.app_id).toBe("A1");
    expect(body.manifest).toBe(JSON.stringify(testManifest));
  });

  it("returns the response on success", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(successBody));

    const result = await updateSlackApp(args);

    expect(result).toEqual(successBody);
  });

  it("throws HTTPError with interpolated message on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 502, "Bad Gateway"));

    try {
      await updateSlackApp(args);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPError);
      const httpErr = err as HTTPError;
      expect(httpErr.message).toBe(
        "Failed to update Slack app: 502 Bad Gateway",
      );
      expect(httpErr.status).toBe(502);
      expect(httpErr.statusText).toBe("Bad Gateway");
    }
  });

  it("throws SlackManifestUpdateError with structured errors on API failure", async () => {
    const apiErrors = [{ message: "scope invalid", pointer: "/scopes" }];
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "invalid_manifest", errors: apiErrors }),
    );

    try {
      await updateSlackApp(args);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SlackManifestUpdateError);
      expect((err as SlackManifestUpdateError).errors).toEqual(apiErrors);
    }
  });

  it("propagates network errors from fetch", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(updateSlackApp(args)).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// exportSlackApp
// ---------------------------------------------------------------------------

describe("exportSlackApp", () => {
  const successBody = { ok: true, manifest: testManifest };
  const args = { token: "tok", appId: "A1" };

  it("sends a POST to apps.manifest.export with correct headers and body", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(successBody));

    await exportSlackApp(args);

    const [url, opts] = mockFetch.mock.lastCall;
    expect(url).toBe("https://slack.com/api/apps.manifest.export");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok");
    expect(opts.headers["Content-Type"]).toBe(
      "application/json; charset=utf-8",
    );
    const body = JSON.parse(opts.body);
    expect(body.app_id).toBe("A1");
  });

  it("returns the response with manifest on success", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(successBody));

    const result = await exportSlackApp(args);

    expect(result).toEqual(successBody);
  });

  it("throws HTTPError on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 403, "Forbidden"));

    try {
      await exportSlackApp(args);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPError);
      expect((err as HTTPError).status).toBe(403);
    }
  });

  it("throws SlackManifestExportError on API failure", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "app_not_found" }),
    );

    await expect(exportSlackApp(args)).rejects.toThrow(
      SlackManifestExportError,
    );
  });

  it("propagates network errors from fetch", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(exportSlackApp(args)).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// upsertSlackApp
// ---------------------------------------------------------------------------

describe("upsertSlackApp", () => {
  const createResponse = {
    ok: true,
    app_id: "A_NEW",
    credentials: {
      client_id: "c",
      client_secret: "s",
      verification_token: "v",
      signing_secret: "ss",
    },
    oauth_authorize_url: "",
  };
  const updateResponse = { ok: true, app_id: "A1", permissions_updated: false };

  it("creates a new app when no appId is provided", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(createResponse));

    const result = await upsertSlackApp({
      token: "tok",
      manifest: testManifest,
    });

    expect(result).toEqual({ isNew: true, app: createResponse });
    expect(mockFetch.mock.calls[0][0]).toContain("apps.manifest.create");
  });

  it("updates an existing app when appId is provided and app exists", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ ok: true, manifest: testManifest }))
      .mockResolvedValueOnce(jsonResponse(updateResponse));

    const result = await upsertSlackApp({
      token: "tok",
      appId: "A1",
      manifest: testManifest,
    });

    expect(result).toEqual({ isNew: false, app: updateResponse });
    expect(mockFetch.mock.calls[0][0]).toContain("apps.manifest.export");
    expect(mockFetch.mock.calls[1][0]).toContain("apps.manifest.update");
  });

  it("falls back to create when export fails", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({}, 404, "Not Found"))
      .mockResolvedValueOnce(jsonResponse(createResponse));

    const result = await upsertSlackApp({
      token: "tok",
      appId: "A_GONE",
      manifest: testManifest,
    });

    expect(result).toEqual({ isNew: true, app: createResponse });
    expect(mockFetch.mock.calls[0][0]).toContain("apps.manifest.export");
    expect(mockFetch.mock.calls[1][0]).toContain("apps.manifest.create");
  });

  it("falls back to create when update fails after successful export", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ ok: true, manifest: {} }))
      .mockResolvedValueOnce(jsonResponse({}, 500, "Internal Server Error"))
      .mockResolvedValueOnce(jsonResponse(createResponse));

    const result = await upsertSlackApp({
      token: "tok",
      appId: "A_BROKEN",
      manifest: testManifest,
    });

    expect(result).toEqual({ isNew: true, app: createResponse });
    expect(mockFetch.mock.calls[0][0]).toContain("apps.manifest.export");
    expect(mockFetch.mock.calls[1][0]).toContain("apps.manifest.update");
    expect(mockFetch.mock.calls[2][0]).toContain("apps.manifest.create");
  });

  it("propagates the error when fallback create also fails", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({}, 404, "Not Found"))
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error: "token_revoked" }),
      );

    await expect(
      upsertSlackApp({ token: "tok", appId: "A1", manifest: testManifest }),
    ).rejects.toThrow(SlackManifestCreateError);
  });

  it("falls back to create on network error during export (catch-all)", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          app_id: "A_NEW",
          credentials: {
            client_id: "c",
            client_secret: "s",
            verification_token: "v",
            signing_secret: "ss",
          },
          oauth_authorize_url: "",
        }),
      );

    const result = await upsertSlackApp({
      token: "tok",
      appId: "A1",
      manifest: testManifest,
    });

    expect(result.isNew).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to create on SlackManifestExportError (ok:false from export)", async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error: "app_not_found" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          app_id: "A_NEW",
          credentials: {
            client_id: "c",
            client_secret: "s",
            verification_token: "v",
            signing_secret: "ss",
          },
          oauth_authorize_url: "",
        }),
      );

    const result = await upsertSlackApp({
      token: "tok",
      appId: "A1",
      manifest: testManifest,
    });

    expect(result.isNew).toBe(true);
  });

  it("falls back to create on SlackManifestUpdateError (ok:false from update)", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ ok: true, manifest: {} }))
      .mockResolvedValueOnce(
        jsonResponse({ ok: false, error: "invalid_manifest" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          app_id: "A_NEW",
          credentials: {
            client_id: "c",
            client_secret: "s",
            verification_token: "v",
            signing_secret: "ss",
          },
          oauth_authorize_url: "",
        }),
      );

    const result = await upsertSlackApp({
      token: "tok",
      appId: "A1",
      manifest: testManifest,
    });

    expect(result.isNew).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// installApp
// ---------------------------------------------------------------------------

describe("installApp", () => {
  it("sends a POST to apps.developerInstall with correct headers and body", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, api_access_tokens: { bot: "xoxb" } }),
    );

    await installApp({
      serviceToken: "svc_tok",
      appId: "A1",
      botScopes: ["chat:write"],
      outgoingDomains: ["example.com"],
    });

    const [url, opts] = mockFetch?.mock.lastCall ?? [];
    expect(url).toBe("https://slack.com/api/apps.developerInstall");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer svc_tok");
    expect(opts.headers["Content-Type"]).toBe(
      "application/json; charset=utf-8",
    );
    const body = JSON.parse(opts.body);
    expect(body.app_id).toBe("A1");
    expect(body.bot_scopes).toEqual(["chat:write"]);
    expect(body.outgoing_domains).toEqual(["example.com"]);
  });

  it("returns missing_service_token without calling fetch when serviceToken is absent", async () => {
    const result = await installApp({ appId: "A1", botScopes: ["chat:write"] });

    expect(result).toEqual({ status: "missing_service_token" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("defaults outgoing_domains to an empty array when not provided", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, api_access_tokens: {} }),
    );

    await installApp({ serviceToken: "tok", appId: "A1", botScopes: [] });

    const body = JSON.parse(mockFetch?.mock.lastCall?.[1]?.body ?? "");
    expect(body.outgoing_domains).toEqual([]);
  });

  it("returns slack_api_error with statusText on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({}, 503, "Service Unavailable"),
    );

    const result = await installApp({
      serviceToken: "tok",
      appId: "A1",
      botScopes: [],
    });

    expect(result).toEqual({
      status: "slack_api_error",
      error: "Service Unavailable",
    });
  });

  it("returns installed with extracted tokens on success", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        api_access_tokens: {
          bot: "xoxb-bot",
          app_level: "xapp-level",
          user: "xoxp-user",
        },
      }),
    );

    const result = await installApp({
      serviceToken: "tok",
      appId: "A1",
      botScopes: ["chat:write"],
    });

    expect(result).toEqual({
      status: "installed",
      botToken: "xoxb-bot",
      appLevelToken: "xapp-level",
      userToken: "xoxp-user",
    });
  });

  it.each([
    "app_approval_request_eligible",
    "app_approval_request_pending",
    "app_approval_request_denied",
  ] as const)(
    "maps Slack error '%s' to the corresponding status",
    async (errorCode) => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ ok: false, error: errorCode }),
      );

      const result = await installApp({
        serviceToken: "tok",
        appId: "A1",
        botScopes: [],
      });

      expect(result.status).toBe(errorCode);
    },
  );

  it("propagates network errors from fetch", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(
      installApp({ serviceToken: "tok", appId: "A1", botScopes: [] }),
    ).rejects.toThrow(TypeError);
  });

  it("returns unknown_error for unrecognized Slack error codes", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "something_unexpected" }),
    );

    const result = await installApp({
      serviceToken: "tok",
      appId: "A1",
      botScopes: [],
    });

    expect(result.status).toBe("unknown_error");
  });
});

// ---------------------------------------------------------------------------
// rotateConfigToken
// ---------------------------------------------------------------------------

describe("rotateConfigToken", () => {
  it("sends a POST to tooling.tokens.rotate with refresh_token", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        token: "xoxe.xoxp-new-token",
        refresh_token: "xoxe-new-refresh",
        exp: 1633138860,
      }),
    );

    await rotateConfigToken({ refreshToken: "xoxe-old-refresh" });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://slack.com/api/tooling.tokens.rotate",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );

    const body = mockFetch.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("refresh_token")).toBe("xoxe-old-refresh");
  });

  it("returns the new token, refresh token, and expiry", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        token: "xoxe.xoxp-new-token",
        refresh_token: "xoxe-new-refresh",
        exp: 1633138860,
      }),
    );

    const result = await rotateConfigToken({ refreshToken: "xoxe-old" });

    expect(result.token).toBe("xoxe.xoxp-new-token");
    expect(result.refreshToken).toBe("xoxe-new-refresh");
    expect(result.exp).toBe(1633138860);
  });

  it("throws HTTPError on non-OK HTTP response", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({}, 500, "Internal Server Error"),
    );

    await expect(
      rotateConfigToken({ refreshToken: "xoxe-bad" }),
    ).rejects.toThrow("Failed to rotate configuration token");
  });

  it("throws on invalid_refresh_token error", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "invalid_refresh_token" }),
    );

    await expect(
      rotateConfigToken({ refreshToken: "xoxe-invalid" }),
    ).rejects.toThrow("invalid_refresh_token");
  });

  it("throws on token_expired error", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "token_expired" }),
    );

    await expect(
      rotateConfigToken({ refreshToken: "xoxe-expired" }),
    ).rejects.toThrow("token_expired");
  });
});
