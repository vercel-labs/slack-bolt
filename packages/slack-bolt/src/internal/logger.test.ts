import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableFetchDebugLogging } from "./logger";
import { createNewManifest } from "./manifest";

const BYPASS = "0123456789abcdef0123456789abcdef";

let debug: ReturnType<typeof vi.spyOn>;
let respond: () => Response;

/** Everything --debug printed, without colour codes. */
const output = () =>
  debug.mock.calls
    .map((args: unknown[]) => args.join(" "))
    .join("\n")
    .replaceAll("\u001b[2m", "")
    .replaceAll("\u001b[0m", "");

beforeEach(() => {
  vi.stubEnv("VERCEL_SLACK_DEBUG", "1");
  debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  respond = () => new Response("{}");
  // A fresh fetch each time, so enableFetchDebugLogging wraps it again.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => respond()),
  );
  enableFetchDebugLogging();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("fetch debug logging", () => {
  it("redacts the bypass secret inside a manifest sent to Slack", async () => {
    const manifest = createNewManifest({
      originalManifest: {
        display_information: { name: "App" },
        settings: {
          event_subscriptions: {
            request_url: "https://example.com/api/slack/events",
          },
          interactivity: {
            is_enabled: true,
            request_url: "https://example.com/api/slack/events",
            message_menu_options_url: "https://example.com/api/slack/events",
          },
        },
        features: {
          slash_commands: [
            {
              command: "/hi",
              url: "https://example.com/api/slack/events",
              description: "d",
            },
          ],
        },
      },
      branchUrl: "my-app-git-feat.vercel.app",
      bypassSecret: BYPASS,
      branch: "feat",
    });

    // Slack takes the manifest as a JSON string inside the JSON body.
    await fetch("https://slack.com/api/apps.manifest.create", {
      method: "POST",
      headers: { Authorization: "Bearer xoxe.xoxp-config-token-1234" },
      body: JSON.stringify({ manifest: JSON.stringify(manifest) }),
    });

    expect(output()).not.toContain(BYPASS);
    expect(output()).toContain("x-vercel-protection-bypass=****");
    // Still useful for debugging: the URL it would call is there.
    expect(output()).toContain("my-app-git-feat.vercel.app/api/slack/events");
  });

  it("redacts the bypass secret in a request URL", async () => {
    await fetch(
      `https://my-app.vercel.app/api?a=1&x-vercel-protection-bypass=${BYPASS}&b=2`,
    );

    expect(output()).not.toContain(BYPASS);
    expect(output()).toContain("a=1&x-vercel-protection-bypass=****&b=2");
  });

  it("redacts the bypass secrets Vercel returns as object keys", async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          protectionBypass: {
            [BYPASS]: { createdAt: 1, scope: "automation-bypass" },
          },
        }),
      );

    await fetch("https://api.vercel.com/v1/projects/prj_1/protection-bypass", {
      method: "PATCH",
      body: JSON.stringify({ generate: { secret: BYPASS, note: "n" } }),
    });

    expect(output()).not.toContain(BYPASS);
    expect(output()).toContain("automation-bypass");
  });

  it("redacts tokens, secrets and env var values in bodies", async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          ok: true,
          credentials: {
            client_id: "111.222",
            client_secret: "client-secret-value",
            signing_secret: "signing-secret-value",
          },
          api_access_tokens: { bot: "xoxb-bot-token-value" },
        }),
      );

    await fetch("https://api.vercel.com/v10/projects/prj_1/env", {
      method: "POST",
      headers: { Authorization: "Bearer vercel-api-token-value" },
      body: JSON.stringify([{ key: "SLACK_BOT_TOKEN", value: "env-value-1" }]),
    });

    const printed = output();
    for (const secret of [
      "client-secret-value",
      "signing-secret-value",
      "xoxb-bot-token-value",
      "vercel-api-token-value",
      "env-value-1",
    ]) {
      expect(printed).not.toContain(secret);
    }
    expect(printed).toContain("111.222");
    expect(printed).toContain("SLACK_BOT_TOKEN");
  });

  it("redacts cookies and the bypass header", async () => {
    await fetch("https://my-app.vercel.app/api", {
      headers: {
        cookie: "session=cookie-value-12345",
        "x-vercel-protection-bypass": BYPASS,
        "x-other": "visible",
      },
    });

    expect(output()).not.toContain("cookie-value-1");
    expect(output()).not.toContain(BYPASS);
    expect(output()).toContain("visible");
  });

  it("doesn't print a body that isn't JSON", async () => {
    await fetch("https://slack.com/api/tooling.tokens.rotate", {
      method: "POST",
      body: "refresh_token=xoxe-refresh-token-value",
    });

    expect(output()).not.toContain("xoxe-refresh-token-value");
    expect(output()).toContain("<non-JSON body, 38 bytes>");
  });

  it("returns the response untouched", async () => {
    respond = () => new Response(JSON.stringify({ ok: true, token: "t" }));

    const response = await fetch("https://slack.com/api/auth.test");

    expect(await response.json()).toEqual({ ok: true, token: "t" });
  });
});
