import type { Manifest } from "@slack/web-api/dist/types/request/manifest";
import { describe, expect, it } from "vitest";
import { extractPath, injectUrls } from "./preview.js";

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
