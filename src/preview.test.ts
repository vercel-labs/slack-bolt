import type { Manifest } from "@slack/web-api/dist/types/request/manifest";
import { describe, expect, it, vi } from "vitest";
import {
  type CreateAppResult,
  type DeploymentContext,
  extractPath,
  injectUrls,
  prepareManifest,
  SlackAppApprovalError,
  SlackAppNotFoundError,
  type SlackOps,
  tryInstallApp,
  upsertSlackApp,
  type VercelOps,
} from "./internal/preview.js";

// ---------------------------------------------------------------------------
// extractPath
// ---------------------------------------------------------------------------

describe("extractPath", () => {
  it("extracts path from a full https URL", () => {
    expect(extractPath("https://example.com/api/events")).toBe("/api/events");
  });

  it("returns / when the URL has no path", () => {
    expect(extractPath("https://example.com")).toBe("/");
  });

  it("preserves query parameters from a full URL", () => {
    expect(extractPath("https://example.com/api/events?token=abc")).toBe(
      "/api/events?token=abc",
    );
  });

  it("returns a bare path unchanged", () => {
    expect(extractPath("/api/events")).toBe("/api/events");
  });

  it("prepends / to a relative path", () => {
    expect(extractPath("api/events")).toBe("/api/events");
  });

  it("handles placeholder domains used in manifests", () => {
    // Manifests commonly use placeholders like <your-domain>
    // These are not valid URLs but the regex path should handle http(s) ones
    expect(extractPath("https://my-app.vercel.app/slack/events")).toBe(
      "/slack/events",
    );
  });
});

// ---------------------------------------------------------------------------
// injectUrls
// ---------------------------------------------------------------------------

/** Helper to build a minimal manifest with the URL fields we care about. */
function makeManifest(
  overrides: {
    eventUrl?: string;
    interactivityUrl?: string;
    slashCommands?: { command: string; url: string; description: string }[];
  } = {},
): Manifest {
  return {
    display_information: { name: "Test App" },
    settings: {
      event_subscriptions: overrides.eventUrl
        ? { request_url: overrides.eventUrl }
        : undefined,
      interactivity: overrides.interactivityUrl
        ? { is_enabled: true, request_url: overrides.interactivityUrl }
        : undefined,
    },
    features: {
      slash_commands: overrides.slashCommands,
    },
  } as Manifest;
}

describe("injectUrls", () => {
  const baseUrl = "https://my-branch.vercel.app";
  const bypassSecret = "test-secret-123";

  // ── Without bypass secret ──────────────────────────────────────────────

  it("replaces event_subscriptions URL with the base URL + path", () => {
    const m = makeManifest({
      eventUrl: "https://old-domain.com/slack/events",
    });
    injectUrls(m, baseUrl);

    expect(m.settings?.event_subscriptions?.request_url).toBe(
      "https://my-branch.vercel.app/slack/events",
    );
  });

  it("replaces interactivity URL with the base URL + path", () => {
    const m = makeManifest({
      interactivityUrl: "https://old-domain.com/slack/interactivity",
    });
    injectUrls(m, baseUrl);

    expect(m.settings?.interactivity?.request_url).toBe(
      "https://my-branch.vercel.app/slack/interactivity",
    );
  });

  it("replaces slash command URLs with the base URL + path", () => {
    const m = makeManifest({
      slashCommands: [
        {
          command: "/hello",
          url: "https://old-domain.com/api/hello",
          description: "Say hello",
        },
      ],
    });
    injectUrls(m, baseUrl);

    expect(m.features?.slash_commands?.[0]?.url).toBe(
      "https://my-branch.vercel.app/api/hello",
    );
  });

  // ── With bypass secret, no existing query params ───────────────────────

  it("appends bypass secret with ? when path has no query params", () => {
    const m = makeManifest({
      eventUrl: "https://old-domain.com/slack/events",
    });
    injectUrls(m, baseUrl, bypassSecret);

    expect(m.settings?.event_subscriptions?.request_url).toBe(
      `https://my-branch.vercel.app/slack/events?x-vercel-protection-bypass=${bypassSecret}`,
    );
  });

  // ── With bypass secret AND existing query params (the bug) ─────────────

  it("appends bypass secret with & when path already has query params", () => {
    const m = makeManifest({
      eventUrl: "https://old-domain.com/slack/events?token=abc",
    });
    injectUrls(m, baseUrl, bypassSecret);

    // Should use & to join, NOT a second ?
    expect(m.settings?.event_subscriptions?.request_url).toBe(
      `https://my-branch.vercel.app/slack/events?token=abc&x-vercel-protection-bypass=${bypassSecret}`,
    );
  });

  it("appends bypass secret with & for interactivity URL with existing query params", () => {
    const m = makeManifest({
      interactivityUrl: "https://old-domain.com/slack/interact?foo=1&bar=2",
    });
    injectUrls(m, baseUrl, bypassSecret);

    expect(m.settings?.interactivity?.request_url).toBe(
      `https://my-branch.vercel.app/slack/interact?foo=1&bar=2&x-vercel-protection-bypass=${bypassSecret}`,
    );
  });

  it("appends bypass secret with & for slash command URLs with existing query params", () => {
    const m = makeManifest({
      slashCommands: [
        {
          command: "/hello",
          url: "https://old-domain.com/api/hello?source=slash",
          description: "Say hello",
        },
      ],
    });
    injectUrls(m, baseUrl, bypassSecret);

    expect(m.features?.slash_commands?.[0]?.url).toBe(
      `https://my-branch.vercel.app/api/hello?source=slash&x-vercel-protection-bypass=${bypassSecret}`,
    );
  });

  // ── No bypass secret ───────────────────────────────────────────────────

  it("does not append any query param when bypassSecret is null", () => {
    const m = makeManifest({
      eventUrl: "https://old-domain.com/slack/events",
    });
    injectUrls(m, baseUrl, null);

    expect(m.settings?.event_subscriptions?.request_url).toBe(
      "https://my-branch.vercel.app/slack/events",
    );
  });

  it("does not append any query param when bypassSecret is undefined", () => {
    const m = makeManifest({
      eventUrl: "https://old-domain.com/slack/events",
    });
    injectUrls(m, baseUrl, undefined);

    expect(m.settings?.event_subscriptions?.request_url).toBe(
      "https://my-branch.vercel.app/slack/events",
    );
  });
});

// ---------------------------------------------------------------------------
// Test Helpers: Fakes
// ---------------------------------------------------------------------------

/** Default deployment context for prepareManifest tests. */
function makeDeploymentContext(
  overrides: Partial<DeploymentContext> = {},
): DeploymentContext {
  return {
    branch: "feat/cool-feature",
    branchUrl: "my-app-feat-cool-feature.vercel.app",
    commitSha: "abc1234def5678",
    commitMsg: "add cool feature",
    commitAuthor: "testuser",
    bypassSecret: null,
    ...overrides,
  };
}

/** Builds a manifest with configurable fields for helper tests. */
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
// prepareManifest
// ---------------------------------------------------------------------------

describe("prepareManifest", () => {
  it("formats display_information.name with the branch suffix", () => {
    const m = makeFullManifest({ name: "My App" });
    prepareManifest(m, makeDeploymentContext({ branch: "main" }));

    expect(m.display_information.name).toBe("My App (main)");
  });

  it("formats bot_user.display_name with the branch suffix", () => {
    const m = makeFullManifest({ name: "App", botDisplayName: "Bot" });
    prepareManifest(m, makeDeploymentContext({ branch: "dev" }));

    expect(m.features?.bot_user?.display_name).toBe("Bot (dev)");
  });

  it("does not crash when bot_user is absent", () => {
    const m = makeFullManifest({ name: "App" });
    // No bot_user set
    expect(() => prepareManifest(m, makeDeploymentContext())).not.toThrow();
  });

  it("appends deployment info to long_description", () => {
    const m = makeFullManifest({ longDescription: "Original description." });
    prepareManifest(
      m,
      makeDeploymentContext({
        branchUrl: "app-branch.vercel.app",
        branch: "feat/x",
        commitSha: "abc1234",
        commitMsg: "fix bug",
        commitAuthor: "alice",
      }),
    );

    const desc = m.display_information.long_description ?? "";
    expect(desc).toContain("Original description.");
    expect(desc).toContain("app-branch.vercel.app");
    expect(desc).toContain("feat/x");
    expect(desc).toContain("abc1234");
    expect(desc).toContain("fix bug");
    expect(desc).toContain("alice");
    expect(desc).toContain("Automatically created by");
  });

  it("truncates long_description to fit Slack's 4000-char limit", () => {
    const longDesc = "A".repeat(3900);
    const m = makeFullManifest({ longDescription: longDesc });
    prepareManifest(m, makeDeploymentContext());

    const desc = m.display_information.long_description ?? "";
    expect(desc.length).toBeLessThanOrEqual(4000);
    // Deployment info should still be present at the end
    expect(desc).toContain("Automatically created by");
  });

  it("respects the 4000-char limit when deploymentInfo alone exceeds it", () => {
    // When commitMsg is extremely long, deploymentInfo itself can exceed 4000
    // chars. In that case `available` (maxLongDesc - deploymentInfo.length)
    // becomes negative. The code must guard against this so the final
    // long_description never exceeds 4000 characters.
    const hugeCommitMsg = "X".repeat(4500);
    const m = makeFullManifest({ longDescription: "Some description." });
    prepareManifest(m, makeDeploymentContext({ commitMsg: hugeCommitMsg }));

    const desc = m.display_information.long_description ?? "";
    expect(desc.length).toBeLessThanOrEqual(4000);
  });

  it("injects the branch URL into manifest URLs", () => {
    const m = makeFullManifest({
      eventUrl: "https://placeholder.com/slack/events",
    });
    prepareManifest(
      m,
      makeDeploymentContext({ branchUrl: "my-branch.vercel.app" }),
    );

    expect(m.settings?.event_subscriptions?.request_url).toBe(
      "https://my-branch.vercel.app/slack/events",
    );
  });

  it("injects bypass secret into manifest URLs when provided", () => {
    const m = makeFullManifest({
      eventUrl: "https://placeholder.com/slack/events",
    });
    prepareManifest(
      m,
      makeDeploymentContext({
        branchUrl: "my-branch.vercel.app",
        bypassSecret: "secret-123",
      }),
    );

    expect(m.settings?.event_subscriptions?.request_url).toBe(
      "https://my-branch.vercel.app/slack/events?x-vercel-protection-bypass=secret-123",
    );
  });

  it("sanitizes branch names with slashes in the display name", () => {
    const m = makeFullManifest({ name: "App" });
    prepareManifest(
      m,
      makeDeploymentContext({ branch: "refs/heads/feat/thing" }),
    );

    // formatPreviewName should strip refs/heads/ and replace / with -
    expect(m.display_information.name).not.toContain("/");
  });

  it("truncates branch in display name to fit Slack's 35-char limit", () => {
    const m = makeFullManifest({ name: "App" });
    prepareManifest(
      m,
      makeDeploymentContext({
        branch: "very-long-branch-name-that-exceeds-limit",
      }),
    );

    expect(m.display_information.name.length).toBeLessThanOrEqual(35);
  });
});

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
