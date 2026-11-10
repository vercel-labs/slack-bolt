// preview() against fake Slack and Vercel APIs, with the manifest in a
// temporary directory. The last test hands what preview() stored and wrote to
// a real VercelReceiver, to check that a preview's Slack app reaches it.
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { App } from "@slack/bolt";
import { waitUntil } from "@vercel/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { VercelReceiver } from "./index";
import type { Manifest } from "./internal/manifest/types";
import type { CreateProjectEnv } from "./internal/vercel/types";
import { type PreviewParams, preview } from "./preview";

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

const BYPASS = "0123456789abcdef0123456789abcdef";
const SIGNING_SECRET = "signing-secret-from-slack";

const manifest: Manifest = {
  display_information: { name: "My App" },
  features: {
    bot_user: { display_name: "My App" },
    slash_commands: [
      {
        command: "/hello",
        url: "https://example.com/api/slack/events",
        description: "Says hello",
      },
    ],
  },
  oauth_config: {
    scopes: { bot: ["chat:write", "commands"] },
    redirect_urls: ["https://example.com/api/slack/events"],
  },
  settings: {
    event_subscriptions: {
      request_url: "https://example.com/api/slack/events",
      bot_events: ["app_mention"],
    },
    interactivity: {
      is_enabled: true,
      request_url: "https://example.com/api/slack/events",
    },
  },
};

const params: PreviewParams = {
  branch: "feat/thing",
  projectId: "prj_123",
  teamId: "team_456",
  deploymentUrl: "my-app-abc123.vercel.app",
  branchUrl: "my-app-git-feat-thing.vercel.app",
  manifestPath: "manifest.json",
  slackConfigurationToken: "xoxe.xoxp-config",
  slackServiceToken: "xoxp-service",
  vercelApiToken: "vercel-token",
  commitSha: "abcdef1234567890",
  commitMessage: "Add thing",
  commitAuthor: "octocat",
};

/** One request preview() made, with its JSON body parsed. */
type Call = { url: URL; method: string; body: unknown };

let dir: string;
let calls: Call[];
/** What the fake APIs answer, by a substring of the URL. */
let answers: Record<string, () => Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const created = () =>
  json({
    ok: true,
    app_id: "A_NEW",
    credentials: {
      client_id: "111.222",
      client_secret: "client-secret-from-slack",
      verification_token: "verification-token",
      signing_secret: SIGNING_SECRET,
    },
    oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=111",
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-bolt-preview-"));
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  vi.spyOn(process, "cwd").mockReturnValue(dir);

  calls = [];
  answers = {
    "/protection-bypass": () => json({}),
    "apps.manifest.create": created,
    "apps.manifest.export": () => json({ ok: true, manifest }),
    "apps.manifest.update": () =>
      json({ ok: true, app_id: "A_OLD", permissions_updated: false }),
    "apps.developerInstall": () =>
      json({ ok: true, app_id: "A_NEW", api_access_tokens: { bot: "xoxb-1" } }),
    "/env": () => json({ created: [], failed: [] }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      const key = Object.keys(answers).find((k) => url.href.includes(k));
      if (!key) throw new Error(`Unexpected request to ${url.href}`);
      return answers[key]();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const callsTo = (part: string) =>
  calls.filter((c) => c.url.href.includes(part));
/** Every environment variable preview() asked Vercel to save, in order. */
const savedEnvs = () =>
  callsTo("/env").flatMap((c) => c.body as CreateProjectEnv[]);
const writtenManifest = (): Manifest =>
  JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

describe("a branch's first preview", () => {
  it("creates the Slack app from the manifest, rewritten for the branch", async () => {
    const result = await preview({ ...params, automationBypassSecret: BYPASS });

    expect(result).toMatchObject({ isNew: true, installStatus: "installed" });
    expect(result.app.app_id).toBe("A_NEW");

    const [create] = callsTo("apps.manifest.create");
    const sent: Manifest = JSON.parse(
      (create.body as { manifest: string }).manifest,
    );
    const requestUrl = new URL(
      sent.settings!.event_subscriptions!.request_url!,
    );
    expect(requestUrl.origin).toBe("https://my-app-git-feat-thing.vercel.app");
    expect(requestUrl.pathname).toBe("/api/slack/events");
    expect(requestUrl.searchParams.get("x-vercel-protection-bypass")).toBe(
      BYPASS,
    );
    expect(sent.display_information.name).toBe("My App (feat-thing)");
    // The browser comes back to the redirect URL, so it carries no secret.
    expect(sent.oauth_config!.redirect_urls).toEqual([
      "https://my-app-git-feat-thing.vercel.app/api/slack/events",
    ]);
  });

  it("writes the rewritten manifest back, for code that imports it", async () => {
    await preview({ ...params, automationBypassSecret: BYPASS });

    const [create] = callsTo("apps.manifest.create");
    expect(writtenManifest()).toEqual(
      JSON.parse((create.body as { manifest: string }).manifest),
    );
  });

  it("saves the app's credentials and bot token for the branch only", async () => {
    await preview({ ...params, automationBypassSecret: BYPASS });

    const envs = savedEnvs();
    expect(Object.fromEntries(envs.map((e) => [e.key, e.value]))).toEqual({
      SLACK_APP_ID: "A_NEW",
      SLACK_CLIENT_ID: "111.222",
      SLACK_CLIENT_SECRET: "client-secret-from-slack",
      SLACK_SIGNING_SECRET: SIGNING_SECRET,
      SLACK_BOT_TOKEN: "xoxb-1",
    });
    for (const env of envs) {
      expect(env).toMatchObject({
        type: "encrypted",
        target: ["preview"],
        gitBranch: "feat/thing",
      });
    }
    for (const call of callsTo("/env")) {
      expect(call.url.pathname).toBe("/v10/projects/prj_123/env");
      expect(call.url.searchParams.get("teamId")).toBe("team_456");
      expect(call.url.searchParams.get("upsert")).toBe("true");
    }
  });

  it("saves the app-level and user tokens when Slack issues them", async () => {
    answers["apps.developerInstall"] = () =>
      json({
        ok: true,
        api_access_tokens: {
          bot: "xoxb-1",
          app_level: "xapp-1",
          user: "xoxp-1",
        },
      });

    await preview({ ...params, automationBypassSecret: BYPASS });

    expect(savedEnvs().map((e) => e.key)).toEqual(
      expect.arrayContaining(["SLACK_APP_LEVEL_TOKEN", "SLACK_USER_TOKEN"]),
    );
  });

  it("installs with the manifest's bot scopes", async () => {
    await preview({ ...params, automationBypassSecret: BYPASS });

    expect(callsTo("apps.developerInstall")[0].body).toEqual({
      app_id: "A_NEW",
      bot_scopes: ["chat:write", "commands"],
      outgoing_domains: [],
    });
  });

  it("generates a bypass secret when the project has none", async () => {
    await preview(params);

    const [bypass] = callsTo("/protection-bypass");
    const { secret } = (bypass.body as { generate: { secret: string } })
      .generate;
    expect(secret).toMatch(/^[0-9a-f]{32}$/);
    expect(
      new URL(
        writtenManifest().settings!.event_subscriptions!.request_url!,
      ).searchParams.get("x-vercel-protection-bypass"),
    ).toBe(secret);
  });

  it("doesn't generate a bypass secret when the project has one", async () => {
    await preview({ ...params, automationBypassSecret: BYPASS });

    expect(callsTo("/protection-bypass")).toEqual([]);
  });

  it("creates the app without installing it when there's no service token", async () => {
    const result = await preview({
      ...params,
      automationBypassSecret: BYPASS,
      slackServiceToken: undefined,
    });

    expect(result.installStatus).toBe("missing_service_token");
    expect(callsTo("apps.developerInstall")).toEqual([]);
    expect(savedEnvs().map((e) => e.key)).not.toContain("SLACK_BOT_TOKEN");
    expect(savedEnvs().map((e) => e.key)).toContain("SLACK_SIGNING_SECRET");
  });

  it("falls back to the deployment URL when there's no branch URL", async () => {
    await preview({
      ...params,
      automationBypassSecret: BYPASS,
      branchUrl: undefined,
    });

    expect(
      new URL(writtenManifest().settings!.event_subscriptions!.request_url!)
        .host,
    ).toBe("my-app-abc123.vercel.app");
  });

  it("reads and writes a YAML manifest as YAML", async () => {
    fs.writeFileSync(
      path.join(dir, "manifest.yaml"),
      "display_information:\n  name: Yaml App\nsettings:\n  event_subscriptions:\n    request_url: https://example.com/api/slack/events\n",
    );

    await preview({
      ...params,
      automationBypassSecret: BYPASS,
      manifestPath: "manifest.yaml",
    });

    const written = parseYaml(
      fs.readFileSync(path.join(dir, "manifest.yaml"), "utf8"),
    ) as Manifest;
    expect(written.display_information.name).toBe("Yaml App (feat-thing)");
    expect(
      new URL(written.settings!.event_subscriptions!.request_url!).host,
    ).toBe("my-app-git-feat-thing.vercel.app");
  });

  it("fails when Vercel doesn't save every credential", async () => {
    answers["/env"] = () =>
      json({
        created: [],
        failed: [
          {
            error: { code: "BAD_REQUEST", message: "no", key: "SLACK_APP_ID" },
          },
        ],
      });

    await expect(
      preview({ ...params, automationBypassSecret: BYPASS }),
    ).rejects.toThrow(
      "Failed to create environment variables: SLACK_APP_ID (BAD_REQUEST)",
    );
  });
});

describe("a branch's later previews", () => {
  it("updates the branch's app without saving credentials again", async () => {
    const result = await preview({
      ...params,
      automationBypassSecret: BYPASS,
      slackAppId: "A_OLD",
    });

    expect(result).toMatchObject({ isNew: false, installStatus: "installed" });
    expect(result.app.app_id).toBe("A_OLD");
    expect(callsTo("apps.manifest.create")).toEqual([]);
    expect(callsTo("apps.manifest.update")[0].body).toMatchObject({
      app_id: "A_OLD",
    });
    expect(savedEnvs()).toEqual([]);
  });

  it("creates a new app when the stored one is gone", async () => {
    answers["apps.manifest.export"] = () =>
      json({ ok: false, error: "app_not_found" });

    const result = await preview({
      ...params,
      automationBypassSecret: BYPASS,
      slackAppId: "A_DELETED",
    });

    expect(result.isNew).toBe(true);
    expect(savedEnvs().find((e) => e.key === "SLACK_APP_ID")?.value).toBe(
      "A_NEW",
    );
  });

  it("fails instead of creating a second app when Slack is down", async () => {
    answers["apps.manifest.export"] = () => json({}, 503);

    await expect(
      preview({
        ...params,
        automationBypassSecret: BYPASS,
        slackAppId: "A_OLD",
      }),
    ).rejects.toThrow("Failed to export Slack app: 503");

    expect(callsTo("apps.manifest.create")).toEqual([]);
    expect(savedEnvs()).toEqual([]);
  });
});

describe("with the v2 receiver", () => {
  it("serves the preview app's events at the URL preview() gave Slack", async () => {
    await preview({ ...params, automationBypassSecret: BYPASS });

    // The next deployment of the branch gets these as environment variables.
    const env = Object.fromEntries(savedEnvs().map((e) => [e.key, e.value]));
    vi.stubEnv("SLACK_SIGNING_SECRET", env.SLACK_SIGNING_SECRET);
    try {
      const receiver = new VercelReceiver();
      const app = new App({
        receiver,
        authorize: async () => ({
          botToken: env.SLACK_BOT_TOKEN,
          botId: "B1",
          botUserId: "U1",
        }),
      });
      const mentioned = vi.fn();
      app.event("app_mention", async ({ event }) => mentioned(event.text));

      const body = JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        api_app_id: env.SLACK_APP_ID,
        event_id: "Ev1",
        event_time: 1,
        event: {
          type: "app_mention",
          user: "U2",
          text: "<@U1> hi",
          channel: "C1",
          ts: "1.1",
          event_ts: "1.1",
        },
        authorizations: [{ team_id: "T1", user_id: "U1", is_bot: true }],
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")}`;
      // Slack calls the request URL from the manifest, bypass secret and all.
      const requestUrl =
        writtenManifest().settings!.event_subscriptions!.request_url!;
      expect(requestUrl).toContain("x-vercel-protection-bypass=");

      const response = await receiver.POST(
        new Request(requestUrl, {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": String(timestamp),
            "x-slack-signature": signature,
          },
        }),
      );
      await vi.mocked(waitUntil).mock.calls[0][0];

      expect(response.status).toBe(200);
      expect(mentioned).toHaveBeenCalledWith("<@U1> hi");

      // And a request signed with another app's secret is refused.
      const forged = await receiver.POST(
        new Request(requestUrl, {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": String(timestamp),
            "x-slack-signature": `v0=${createHmac("sha256", "another-secret")
              .update(`v0:${timestamp}:${body}`)
              .digest("hex")}`,
          },
        }),
      );
      expect(forged.status).toBe(401);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
