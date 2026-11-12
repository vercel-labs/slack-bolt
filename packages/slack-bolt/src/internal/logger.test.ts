import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPError } from "./http-error";
import { enableFetchDebugLogging, log, registerSecret, scrub } from "./logger";
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
    // Variable names stay readable; only their values go.
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

describe("fetch debug logging, for secrets it isn't told about", () => {
  // Made-up tokens in the shape Slack and Vercel issue them, put together
  // here so the file holds nothing a secret scanner takes for a real one.
  const fake = (prefix: string, ...parts: string[]) =>
    [prefix, ...parts].join(prefix.endsWith("_") ? "" : "-");
  const BOT = fake(
    "xoxb",
    "3901254001572",
    "12587628111652",
    "AbCdEfGhIjKlUvWx",
  );

  it("redacts everything under a key named for secrets, whatever the names inside", async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          ok: true,
          api_access_tokens: {
            workflow: "plain-workflow-token-value",
            nested: { list: ["plain-listed-token-value"] },
          },
          credentials: { something_new: "plain-credential-value" },
          tokens: ["plain-array-token-value"],
        }),
      );

    await fetch("https://slack.com/api/apps.developerInstall");

    const printed = output();
    for (const secret of [
      "plain-workflow-token-value",
      "plain-listed-token-value",
      "plain-credential-value",
      "plain-array-token-value",
    ]) {
      expect(printed).not.toContain(secret);
    }
  });

  it("redacts a Slack or Vercel token under a key with an innocent name", async () => {
    const tokens = [
      BOT,
      fake("xoxp", "3901254001572", "1234567890123", "abcdefabcdef"),
      fake("xapp", "1", "A0CH9JG39K6", "1234567890123", "abcdef0123456789"),
      fake("xoxe.xoxp", "1", "Mi0yLTM5MDEyNTQwMDE1NzItabcdef"),
      fake("xoxe", "1", "My0xLTM5MDEyNTQwMDE1NzItabcdef"),
      fake("vcp_", "0123456789abcdefghijABCDEFGHIJ"),
    ];
    respond = () =>
      new Response(
        JSON.stringify({
          note: `installed with ${tokens[0]}`,
          items: tokens.map((id) => ({ id })),
        }),
      );

    await fetch(`https://example.com/hook?t=${tokens[1]}`, {
      headers: { "x-note": `bearer ${tokens[2]}` },
    });

    const printed = output();
    for (const token of tokens) expect(printed).not.toContain(token);
    // Not even most of one: only its last four characters are left.
    expect(printed).not.toContain(BOT.slice(0, 18));
    expect(printed).toContain("installed with ****UvWx");
  });

  it("redacts a project's deploy hook URLs", async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          id: "prj_1",
          link: {
            type: "github",
            deployHooks: [
              {
                id: "hook_1",
                name: "nightly",
                url: "https://api.vercel.com/v1/integrations/deploy/prj_1/HookSecret123",
              },
            ],
          },
        }),
      );

    await fetch("https://api.vercel.com/v9/projects/prj_1");

    expect(output()).not.toContain("HookSecret123");
    expect(output()).toContain("github");
  });

  it("keeps a manifest's scopes readable, though they sit under bot and user", async () => {
    await fetch("https://slack.com/api/apps.manifest.create", {
      method: "POST",
      body: JSON.stringify({
        manifest: JSON.stringify({
          oauth_config: {
            scopes: { bot: ["chat:write"], user: ["search:read"] },
          },
        }),
      }),
    });

    expect(output()).toContain("chat:write");
    expect(output()).toContain("search:read");
  });

  it("redacts credentials in headers, however the headers are passed", async () => {
    await fetch("https://api.vercel.com/v9/projects/prj_1", {
      headers: [
        ["Authorization", "Bearer pairs-authorization-value"],
        ["X-Api-Key", "pairs-api-key-value-123"],
      ],
    });
    await fetch("https://api.vercel.com/v9/projects/prj_1", {
      headers: new Headers({
        "Proxy-Authorization": "Basic headers-proxy-value-123",
        "X-Upload-Token": "headers-upload-token-value",
      }),
    });

    const printed = output();
    for (const secret of [
      "pairs-authorization-value",
      "pairs-api-key-value-123",
      "headers-proxy-value-123",
      "headers-upload-token-value",
    ]) {
      expect(printed).not.toContain(secret);
    }
  });

  // The last four characters of a short value are most of it.
  it("shows nothing of a short secret", async () => {
    respond = () =>
      new Response(JSON.stringify({ client_secret: "shortsecret" }));

    await fetch("https://slack.com/api/apps.manifest.create");

    expect(output()).toContain('"client_secret":"****"');
    expect(output()).not.toContain("shortsecret");
  });
});

describe("registered secrets", () => {
  // No shape gives these away: Slack's signing and client secrets are hex.
  const SIGNING = "8f742231b10e8888abcd99yyyzzz85a5";
  let printed: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  const lines = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");

  beforeEach(() => {
    printed = vi.spyOn(console, "log").mockImplementation(() => {});
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
    registerSecret(SIGNING);
  });

  it("are taken out of every kind of message", () => {
    log.step(`step ${SIGNING}`);
    log.info(`info ${SIGNING}`);
    log.success(`success ${SIGNING}`);
    log.warning(`warning ${SIGNING}`);
    log.error(`error ${SIGNING}`, new Error(`thrown with ${SIGNING}`));
    log.debug(`debug ${SIGNING}`, new Error(`thrown with ${SIGNING}`));

    for (const text of [lines(printed), lines(errors), output()]) {
      expect(text).not.toContain(SIGNING);
      expect(text).toContain("****85a5");
    }
    expect(lines(errors)).toContain("thrown with ****85a5");
  });

  it("are taken out of a body, under any key and inside any text", async () => {
    respond = () =>
      new Response(
        JSON.stringify({ id: SIGNING, detail: `rejected ${SIGNING} twice` }),
      );

    await fetch(`https://example.com/${SIGNING}`);

    expect(output()).not.toContain(SIGNING);
  });

  it("are taken out of the error for a failed request", () => {
    const error = new HTTPError(
      "Failed to create deployment",
      400,
      "Bad Request",
      `{"error":{"message":"bad env ${SIGNING}"}}`,
    );

    expect(error.message).not.toContain(SIGNING);
    expect(error.message).toContain("Failed to create deployment: 400");
  });

  it("keeps every line of a message indented under its step", () => {
    log.info(
      "Slack refused the token. Generate a new one:\nhttps://example.com",
    );

    expect(lines(printed)).toBe(
      "  Slack refused the token. Generate a new one:\n  https://example.com",
    );
  });

  it("go as a whole when one contains another", () => {
    registerSecret("inner-secret-value", "outer-inner-secret-value-outer");

    expect(scrub("got outer-inner-secret-value-outer")).toBe("got ****uter");
  });

  it("leave short and empty values alone, which would match ordinary words", () => {
    registerSecret("", undefined, null, "build");

    expect(scrub("build failed")).toBe("build failed");
  });

  it("leave ordinary text alone", () => {
    const text =
      "Slack's apps.manifest.update failed: invalid_manifest (xoxo, vcpkg, app A0CH9JG39K6)";

    expect(scrub(text)).toBe(text);
  });
});

describe("scrub", () => {
  it("redacts the bypass secret in a URL inside any text", () => {
    expect(
      scrub(
        `The request_url https://a.vercel.app/api?x-vercel-protection-bypass=${BYPASS}&x=1 is invalid`,
      ),
    ).toBe(
      "The request_url https://a.vercel.app/api?x-vercel-protection-bypass=****&x=1 is invalid",
    );
  });
});
