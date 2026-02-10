import type { Manifest } from "@slack/web-api/dist/types/request/manifest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackAppApprovalError, SlackAppNotFoundError } from "./errors";
import { checkSlackConfigToken, rotateSlackConfigToken } from "./slack";
import type { CreateAppResult, SlackOps, VercelOps } from "./types";
import { tryInstallApp, upsertSlackApp } from "./utils";

// ---------------------------------------------------------------------------
// Test Helpers: Fakes
// ---------------------------------------------------------------------------

/** Builds a manifest with configurable fields for tests. */
function makeFullManifest(
  overrides: {
    name?: string;
    longDescription?: string;
    botDisplayName?: string;
    eventUrl?: string;
    botScopes?: string[];
  } = {},
): Manifest {
  return {
    display_information: {
      name: overrides.name ?? "My App",
      long_description: overrides.longDescription ?? "A test app.",
    },
    features: {
      bot_user: overrides.botDisplayName
        ? { display_name: overrides.botDisplayName, always_online: false }
        : undefined,
    },
    settings: {
      event_subscriptions: overrides.eventUrl
        ? { request_url: overrides.eventUrl }
        : undefined,
    },
    oauth_config: {
      scopes: {
        bot: overrides.botScopes ?? ["chat:write"],
      },
    },
  } as Manifest;
}

/** Default CreateAppResult for fake SlackOps. */
const defaultCreateResult: CreateAppResult = {
  appId: "A_NEW_APP",
  clientId: "client-id-123",
  clientSecret: "client-secret-456",
  signingSecret: "signing-secret-789",
  installUrl: "https://slack.com/oauth/install",
};

/** Creates a fake SlackOps with sensible defaults. Override individual methods as needed. */
function fakeSlackOps(overrides: Partial<SlackOps> = {}): SlackOps {
  return {
    createApp: vi
      .fn<SlackOps["createApp"]>()
      .mockResolvedValue(defaultCreateResult),
    updateApp: vi.fn<SlackOps["updateApp"]>().mockResolvedValue(undefined),
    deleteApp: vi.fn<SlackOps["deleteApp"]>().mockResolvedValue(undefined),
    installApp: vi
      .fn<SlackOps["installApp"]>()
      .mockResolvedValue("xoxb-bot-token"),
    ...overrides,
  };
}

/** Creates a fake VercelOps with sensible defaults. Override individual methods as needed. */
function fakeVercelOps(overrides: Partial<VercelOps> = {}): VercelOps {
  return {
    getSlackAppId: vi.fn<VercelOps["getSlackAppId"]>().mockResolvedValue(null),
    setEnvVars: vi.fn<VercelOps["setEnvVars"]>().mockResolvedValue(undefined),
    deleteSlackEnvVars: vi
      .fn<VercelOps["deleteSlackEnvVars"]>()
      .mockResolvedValue(undefined),
    ensureProtectionBypass: vi
      .fn<VercelOps["ensureProtectionBypass"]>()
      .mockResolvedValue("bypass-secret"),
    triggerRedeploy: vi
      .fn<VercelOps["triggerRedeploy"]>()
      .mockResolvedValue(undefined),
    cancelDeployment: vi
      .fn<VercelOps["cancelDeployment"]>()
      .mockResolvedValue(undefined),
    getActiveBranches: vi
      .fn<VercelOps["getActiveBranches"]>()
      .mockResolvedValue(new Set()),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// upsertSlackApp
// ---------------------------------------------------------------------------

describe("upsertSlackApp", () => {
  const branch = "feat/test";

  it("creates a new app when no existing app is found", async () => {
    const slack = fakeSlackOps();
    const vercel = fakeVercelOps();
    const m = makeFullManifest();

    const result = await upsertSlackApp(m, branch, slack, vercel);

    expect(result.isNew).toBe(true);
    expect(result.appId).toBe("A_NEW_APP");
    expect(result.installUrl).toBe("https://slack.com/oauth/install");
    expect(slack.createApp).toHaveBeenCalledWith(m);
    expect(vercel.setEnvVars).toHaveBeenCalledWith(branch, [
      { key: "SLACK_APP_ID", value: "A_NEW_APP" },
      { key: "SLACK_CLIENT_ID", value: "client-id-123" },
      { key: "SLACK_CLIENT_SECRET", value: "client-secret-456" },
      { key: "SLACK_SIGNING_SECRET", value: "signing-secret-789" },
    ]);
  });

  it("updates an existing app when one is found", async () => {
    const slack = fakeSlackOps();
    const vercel = fakeVercelOps({
      getSlackAppId: vi
        .fn<VercelOps["getSlackAppId"]>()
        .mockResolvedValue("A_EXISTING"),
    });
    const m = makeFullManifest();

    const result = await upsertSlackApp(m, branch, slack, vercel);

    expect(result.isNew).toBe(false);
    expect(result.appId).toBe("A_EXISTING");
    expect(result.installUrl).toBeNull();
    expect(slack.updateApp).toHaveBeenCalledWith("A_EXISTING", m);
    expect(slack.createApp).not.toHaveBeenCalled();
    expect(vercel.setEnvVars).not.toHaveBeenCalled();
  });

  it("recreates the app when update fails with SlackAppNotFoundError", async () => {
    const slack = fakeSlackOps({
      updateApp: vi
        .fn<SlackOps["updateApp"]>()
        .mockRejectedValue(new SlackAppNotFoundError("A_STALE")),
    });
    const vercel = fakeVercelOps({
      getSlackAppId: vi
        .fn<VercelOps["getSlackAppId"]>()
        .mockResolvedValue("A_STALE"),
    });
    const m = makeFullManifest();

    const result = await upsertSlackApp(m, branch, slack, vercel);

    // Should clean up stale env vars
    expect(vercel.deleteSlackEnvVars).toHaveBeenCalledWith(branch);
    // Should fall through to create
    expect(result.isNew).toBe(true);
    expect(result.appId).toBe("A_NEW_APP");
    expect(slack.createApp).toHaveBeenCalledWith(m);
    expect(vercel.setEnvVars).toHaveBeenCalled();
  });

  it("propagates non-SlackAppNotFoundError errors from updateApp", async () => {
    const slack = fakeSlackOps({
      updateApp: vi
        .fn<SlackOps["updateApp"]>()
        .mockRejectedValue(new Error("Invalid manifest: bad field")),
    });
    const vercel = fakeVercelOps({
      getSlackAppId: vi
        .fn<VercelOps["getSlackAppId"]>()
        .mockResolvedValue("A_EXISTING"),
    });
    const m = makeFullManifest();

    await expect(upsertSlackApp(m, branch, slack, vercel)).rejects.toThrow(
      "Invalid manifest: bad field",
    );
    // Should NOT clean up env vars or create a new app
    expect(vercel.deleteSlackEnvVars).not.toHaveBeenCalled();
    expect(slack.createApp).not.toHaveBeenCalled();
  });

  it("tolerates deleteSlackEnvVars failure during stale cleanup", async () => {
    const slack = fakeSlackOps({
      updateApp: vi
        .fn<SlackOps["updateApp"]>()
        .mockRejectedValue(new SlackAppNotFoundError("A_STALE")),
    });
    const vercel = fakeVercelOps({
      getSlackAppId: vi
        .fn<VercelOps["getSlackAppId"]>()
        .mockResolvedValue("A_STALE"),
      deleteSlackEnvVars: vi
        .fn<VercelOps["deleteSlackEnvVars"]>()
        .mockRejectedValue(new Error("cleanup failed")),
    });
    const m = makeFullManifest();

    // Should still succeed -- cleanup is best-effort
    const result = await upsertSlackApp(m, branch, slack, vercel);
    expect(result.isNew).toBe(true);
    expect(result.appId).toBe("A_NEW_APP");
  });
});

// ---------------------------------------------------------------------------
// tryInstallApp
// ---------------------------------------------------------------------------

describe("tryInstallApp", () => {
  const branch = "feat/test";
  const appId = "A_TEST_APP";

  it("installs the app and sets SLACK_BOT_TOKEN on success", async () => {
    const slack = fakeSlackOps();
    const vercel = fakeVercelOps();
    const m = makeFullManifest();

    const result = await tryInstallApp(appId, m, slack, vercel, branch);

    expect(result.installed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(slack.installApp).toHaveBeenCalledWith(appId, m);
    expect(vercel.setEnvVars).toHaveBeenCalledWith(branch, [
      { key: "SLACK_BOT_TOKEN", value: "xoxb-bot-token" },
    ]);
  });

  it("returns installed: false with approval message on SlackAppApprovalError", async () => {
    const slack = fakeSlackOps({
      installApp: vi
        .fn<SlackOps["installApp"]>()
        .mockRejectedValue(new SlackAppApprovalError("app_approval_required")),
    });
    const vercel = fakeVercelOps();
    const m = makeFullManifest();

    const result = await tryInstallApp(appId, m, slack, vercel, branch);

    expect(result.installed).toBe(false);
    expect(result.error).toContain("app_approval");
    // Should not attempt to set env vars
    expect(vercel.setEnvVars).not.toHaveBeenCalled();
  });

  it("returns installed: false with generic message on other errors", async () => {
    const slack = fakeSlackOps({
      installApp: vi
        .fn<SlackOps["installApp"]>()
        .mockRejectedValue(new Error("network timeout")),
    });
    const vercel = fakeVercelOps();
    const m = makeFullManifest();

    const result = await tryInstallApp(appId, m, slack, vercel, branch);

    expect(result.installed).toBe(false);
    expect(result.error).toContain("network timeout");
    expect(vercel.setEnvVars).not.toHaveBeenCalled();
  });

  it("returns installed: false when setEnvVars fails after successful install", async () => {
    const slack = fakeSlackOps();
    const vercel = fakeVercelOps({
      setEnvVars: vi
        .fn<VercelOps["setEnvVars"]>()
        .mockRejectedValue(new Error("env var write failed")),
    });
    const m = makeFullManifest();

    const result = await tryInstallApp(appId, m, slack, vercel, branch);

    expect(result.installed).toBe(false);
    expect(result.error).toContain("env var write failed");
  });
});

// ---------------------------------------------------------------------------
// checkSlackConfigToken
// ---------------------------------------------------------------------------

// Mock the WebClient to avoid real API calls
vi.mock("@slack/web-api", () => {
  const MockWebClient = vi.fn();
  return { WebClient: MockWebClient };
});

// We need to import the mocked WebClient after vi.mock
const { WebClient } = await import("@slack/web-api");

function mockWebClient(authTestResult: {
  resolve?: unknown;
  reject?: unknown;
}) {
  const testFn = authTestResult.reject
    ? vi.fn().mockRejectedValue(authTestResult.reject)
    : vi.fn().mockResolvedValue(authTestResult.resolve ?? { ok: true });

  vi.mocked(WebClient).mockImplementation(function (this: unknown) {
    Object.assign(this as Record<string, unknown>, {
      auth: { test: testFn },
    });
  } as unknown as typeof WebClient);
}

describe("checkSlackConfigToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the same token when auth.test succeeds", async () => {
    mockWebClient({ resolve: { ok: true } });

    const result = await checkSlackConfigToken("xoxe.xoxp-valid-token");

    expect(result.token).toBe("xoxe.xoxp-valid-token");
    expect(result.rotated).toBe(false);
    expect(result.newRefreshToken).toBeUndefined();
  });

  it("throws when token is expired and no refresh token is provided", async () => {
    mockWebClient({ reject: { data: { error: "invalid_auth" } } });

    await expect(
      checkSlackConfigToken("xoxe.xoxp-expired-token"),
    ).rejects.toThrow("SLACK_CONFIG_REFRESH_TOKEN");
  });

  it("rotates token when expired and refresh token is provided", async () => {
    mockWebClient({ reject: { data: { error: "token_expired" } } });

    // Mock the fetch call to tooling.tokens.rotate
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          token: "xoxe.xoxp-new-token",
          refresh_token: "xoxe-new-refresh",
          exp: Math.floor(Date.now() / 1000) + 43200,
        }),
        { status: 200 },
      ),
    );

    const result = await checkSlackConfigToken(
      "xoxe.xoxp-expired-token",
      "xoxe-old-refresh",
    );

    expect(result.token).toBe("xoxe.xoxp-new-token");
    expect(result.newRefreshToken).toBe("xoxe-new-refresh");
    expect(result.rotated).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://slack.com/api/tooling.tokens.rotate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rethrows non-auth errors without attempting rotation", async () => {
    mockWebClient({ reject: new Error("network failure") });

    await expect(
      checkSlackConfigToken("xoxe.xoxp-token", "xoxe-refresh"),
    ).rejects.toThrow("network failure");
  });
});

// ---------------------------------------------------------------------------
// rotateSlackConfigToken
// ---------------------------------------------------------------------------

describe("rotateSlackConfigToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns new token and refresh token on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          token: "xoxe.xoxp-rotated",
          refresh_token: "xoxe-rotated-refresh",
          exp: Math.floor(Date.now() / 1000) + 43200,
        }),
        { status: 200 },
      ),
    );

    const result = await rotateSlackConfigToken("xoxe-old-refresh");

    expect(result.token).toBe("xoxe.xoxp-rotated");
    expect(result.newRefreshToken).toBe("xoxe-rotated-refresh");
    expect(result.rotated).toBe(true);
  });

  it("throws when the rotation API returns an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: "invalid_refresh_token",
        }),
        { status: 200 },
      ),
    );

    await expect(rotateSlackConfigToken("xoxe-bad-refresh")).rejects.toThrow(
      "invalid_refresh_token",
    );
  });

  it("throws when token is missing from response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          // token and refresh_token deliberately missing
        }),
        { status: 200 },
      ),
    );

    await expect(rotateSlackConfigToken("xoxe-refresh")).rejects.toThrow(
      "missing token in response",
    );
  });
});
