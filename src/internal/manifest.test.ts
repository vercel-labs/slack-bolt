import type { Manifest } from "@slack/web-api/dist/types/request/manifest";
import { describe, expect, it } from "vitest";
import { extractPath, injectUrls, prepareManifest } from "./manifest";
import type { DeploymentContext } from "./types";

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
    redirectUrls?: string[];
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
    oauth_config: overrides.redirectUrls
      ? { redirect_urls: overrides.redirectUrls, scopes: { bot: [] } }
      : undefined,
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

  // ── redirect_urls ──────────────────────────────────────────────────────

  it("rewrites redirect_urls to the branch URL", () => {
    const m = makeManifest({
      redirectUrls: ["https://old-domain.com/slack/oauth_redirect"],
    });
    injectUrls(m, baseUrl);

    expect(m.oauth_config?.redirect_urls).toEqual([
      "https://my-branch.vercel.app/slack/oauth_redirect",
    ]);
  });

  it("does not append bypass secret to redirect_urls", () => {
    const m = makeManifest({
      redirectUrls: ["https://old-domain.com/slack/oauth_redirect"],
    });
    injectUrls(m, baseUrl, bypassSecret);

    expect(m.oauth_config?.redirect_urls).toEqual([
      "https://my-branch.vercel.app/slack/oauth_redirect",
    ]);
  });

  it("rewrites all entries when redirect_urls has multiple entries", () => {
    const m = makeManifest({
      redirectUrls: [
        "https://old-domain.com/slack/oauth_redirect",
        "https://old-domain.com/api/oauth_redirect",
      ],
    });
    injectUrls(m, baseUrl);

    expect(m.oauth_config?.redirect_urls).toEqual([
      "https://my-branch.vercel.app/slack/oauth_redirect",
      "https://my-branch.vercel.app/api/oauth_redirect",
    ]);
  });

  it("does not set redirect_urls when not present in manifest", () => {
    const m = makeManifest({ eventUrl: "https://old-domain.com/slack/events" });
    injectUrls(m, baseUrl);

    expect(m.oauth_config?.redirect_urls).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test Helpers
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
