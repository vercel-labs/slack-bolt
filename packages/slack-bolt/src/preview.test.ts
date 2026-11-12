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
import { HTTPError } from "./internal/http-error";
import type { Manifest } from "./internal/manifest/types";
import { installAdvice, provisionPreview } from "./internal/provision";
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
    "apps.manifest.delete": () => json({ ok: true }),
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

  // Vercel never shows a Sensitive variable's value again. Cleanup reads
  // SLACK_APP_ID back to find the app, so that one can't be.
  it("saves the app's secrets and tokens as Sensitive, and its IDs readable", async () => {
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

    expect(Object.fromEntries(savedEnvs().map((e) => [e.key, e.type]))).toEqual(
      {
        SLACK_APP_ID: "encrypted",
        SLACK_CLIENT_ID: "encrypted",
        SLACK_CLIENT_SECRET: "sensitive",
        SLACK_SIGNING_SECRET: "sensitive",
        SLACK_BOT_TOKEN: "sensitive",
        SLACK_APP_LEVEL_TOKEN: "sensitive",
        SLACK_USER_TOKEN: "sensitive",
      },
    );
  });

  // The CLI prints what failed, and Vercel's or Slack's answer can repeat
  // what it was sent.
  it("keeps the secrets it handles out of the errors it throws", async () => {
    await preview({ ...params, automationBypassSecret: BYPASS });

    // A later call fails, with an answer that repeats them.
    const error = await HTTPError.fromResponse(
      "Failed to create deployment",
      new Response(
        `echo ${SIGNING_SECRET} client-secret-from-slack ${BYPASS} ${params.slackConfigurationToken} ${params.vercelApiToken}`,
        { status: 400 },
      ),
    );

    for (const secret of [
      SIGNING_SECRET,
      "client-secret-from-slack",
      BYPASS,
      params.slackConfigurationToken,
      params.vercelApiToken,
    ]) {
      expect(error.message).not.toContain(secret);
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

  describe("when Vercel doesn't save every credential", () => {
    beforeEach(() => {
      answers["/env"] = () =>
        json({
          created: [],
          failed: [
            {
              error: {
                code: "BAD_REQUEST",
                message: "no",
                key: "SLACK_APP_ID",
              },
            },
          ],
        });
    });

    // Without SLACK_APP_ID the next build can't find the app, and creates
    // another one next to it.
    it("deletes the app it just created, and fails", async () => {
      const error = await preview({
        ...params,
        automationBypassSecret: BYPASS,
      }).catch((e: Error) => e);

      expect((error as Error).message).toContain(
        "couldn't save its credentials to Vercel, so deleted it again",
      );
      expect(((error as Error).cause as Error).message).toBe(
        "Failed to create environment variables: SLACK_APP_ID (BAD_REQUEST)",
      );
      expect(callsTo("apps.manifest.delete").map((c) => c.body)).toEqual([
        { app_id: "A_NEW" },
      ]);
      expect(callsTo("apps.developerInstall")).toEqual([]);
    });

    it("says to delete the app by hand when it can't", async () => {
      answers["apps.manifest.delete"] = () => json({}, 503);

      const error = await preview({
        ...params,
        automationBypassSecret: BYPASS,
      }).catch((e: Error) => e);

      expect((error as Error).message).toContain(
        "couldn't save its credentials to Vercel or delete it again",
      );
      expect((error as Error).message).toContain(
        "https://api.slack.com/apps/A_NEW",
      );
    });
  });

  // What Vercel answers when the branch isn't in the connected repository.
  it("names the variables Vercel refused when it refuses them all", async () => {
    answers["/env"] = () =>
      json(
        {
          error: {
            code: "BAD_REQUEST",
            message: 'Branch "feat/thing" not found',
          },
          failed: [
            {
              error: {
                code: "BAD_REQUEST",
                message: 'Branch "feat/thing" not found',
                key: "gitBranch",
                envVarKey: "SLACK_APP_ID",
              },
            },
          ],
        },
        400,
      );

    const error = await preview({
      ...params,
      automationBypassSecret: BYPASS,
    }).catch((e: Error) => e);

    const cause = ((error as Error).cause as Error).message;
    expect(cause).toContain("SLACK_APP_ID (BAD_REQUEST: gitBranch)");
    // Vercel's message can echo what was sent, so it isn't repeated.
    expect(cause).not.toContain("not found");
  });

  describe("when Slack doesn't install the app", () => {
    // What a free workspace that already has 10 apps answers.
    it("says why, with Slack's error code", async () => {
      answers["apps.developerInstall"] = () =>
        json({ ok: false, error: "service_limits_exceeded" });

      const result = await preview({
        ...params,
        automationBypassSecret: BYPASS,
      });

      expect(result).toMatchObject({
        isNew: true,
        installStatus: "unknown_error",
        installError: "service_limits_exceeded",
      });
      expect(savedEnvs().map((e) => e.key)).not.toContain("SLACK_BOT_TOKEN");
    });

    it("leaves installError out when the app was installed", async () => {
      const result = await preview({
        ...params,
        automationBypassSecret: BYPASS,
      });

      expect(result).not.toHaveProperty("installError");
      expect(result).not.toHaveProperty("changedEnv");
    });
  });

  // fetch refuses such a token as a header with an error that quotes it.
  it("refuses a token with a line break inside it, before any request", async () => {
    const error = await preview({
      ...params,
      slackConfigurationToken: "xoxe.xoxp-first-half\nsecond-half",
    }).catch((e: Error) => e);

    expect((error as Error).message).toBe(
      "slackConfigurationToken contains a line break, space or non-ASCII character, so it isn't a valid token\nCopy it again in one piece and save it.",
    );
    expect(calls).toEqual([]);
  });

  describe("with a manifest it can't use", () => {
    const write = (content: string) =>
      fs.writeFileSync(path.join(dir, "manifest.json"), content);

    it("fails before creating anything when the manifest isn't valid JSON", async () => {
      write("{ not json");

      const error = await preview(params).catch((e: Error) => e);

      expect((error as Error).message).toBe("Couldn't parse manifest.json");
      expect((error as Error).cause).toBeInstanceOf(SyntaxError);
      expect(calls).toEqual([]);
    });

    it.each([
      ["has no display_information", "{}"],
      ["has no name", '{"display_information":{}}'],
      ["has an empty name", '{"display_information":{"name":""}}'],
      ["is empty", "null"],
    ])(
      "fails before creating anything when the manifest %s",
      async (_, content) => {
        write(content);

        await expect(preview(params)).rejects.toThrow(
          "manifest.json has no display_information.name\nSlack requires one: https://docs.slack.dev/reference/manifests",
        );
        expect(calls).toEqual([]);
      },
    );

    it("fails before creating anything when the manifest is missing", async () => {
      await expect(
        preview({ ...params, manifestPath: "missing.json" }),
      ).rejects.toThrow(
        "No manifest at missing.json\nCreate one, or set MANIFEST_PATH to where yours is: https://docs.slack.dev/reference/manifests",
      );
      expect(calls).toEqual([]);
    });
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
    expect(savedEnvs().map((e) => e.key)).not.toContain("SLACK_APP_ID");
    expect(savedEnvs().map((e) => e.key)).not.toContain("SLACK_SIGNING_SECRET");
  });

  // Like an app deleted by hand, or created with another user's
  // configuration token.
  it("says why the branch gets a new app when its stored one is out of reach", async () => {
    answers["apps.manifest.export"] = () =>
      json({ ok: false, error: "no_permission" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await preview(
      { ...params, automationBypassSecret: BYPASS, slackAppId: "A_OLD" },
      "cli",
    );

    expect(result.isNew).toBe(true);
    expect(log.mock.calls.map((args) => args.join(" ")).join("\n")).toContain(
      "Slack has no app A_OLD for this configuration token, so the branch gets a new one",
    );
  });

  // The first build's install may not go through: the app can be waiting
  // for approval, the workspace full, or the service token added later.
  it("saves the tokens of an app that only now got installed", async () => {
    answers["apps.developerInstall"] = () =>
      json({
        ok: true,
        api_access_tokens: { bot: "xoxb-late", app_level: "xapp-late" },
      });

    await preview({
      ...params,
      automationBypassSecret: BYPASS,
      slackAppId: "A_OLD",
    });

    expect(savedEnvs()).toEqual([
      expect.objectContaining({
        key: "SLACK_BOT_TOKEN",
        value: "xoxb-late",
        target: ["preview"],
        gitBranch: "feat/thing",
      }),
      expect.objectContaining({
        key: "SLACK_APP_LEVEL_TOKEN",
        value: "xapp-late",
      }),
    ]);
  });

  it("saves nothing when the app still isn't installed", async () => {
    answers["apps.developerInstall"] = () =>
      json({ ok: false, error: "app_approval_request_pending" });

    const result = await preview({
      ...params,
      automationBypassSecret: BYPASS,
      slackAppId: "A_OLD",
    });

    expect(result.installStatus).toBe("app_approval_request_pending");
    expect(savedEnvs()).toEqual([]);
  });

  // The app is there, so a second one wouldn't fix the manifest, and would
  // leave the first behind.
  it("fails instead of creating a second app when Slack rejects the updated manifest", async () => {
    answers["apps.manifest.update"] = () =>
      json({
        ok: false,
        error: "invalid_manifest",
        errors: [{ message: "too long", pointer: "/display_information/name" }],
      });

    const error = await preview({
      ...params,
      automationBypassSecret: BYPASS,
      slackAppId: "A_OLD",
    }).catch((e: Error) => e);

    expect((error as Error).message).toBe(
      "Slack's apps.manifest.update failed: invalid_manifest",
    );
    expect((error as { errors?: unknown }).errors).toEqual([
      { message: "too long", pointer: "/display_information/name" },
    ]);
    expect(callsTo("apps.manifest.create")).toEqual([]);
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

describe("what the CLI prints", () => {
  const SERVICE_DOCS = "https://docs.slack.dev/authentication/tokens/#service";
  const OAUTH = "https://slack.com/oauth/v2/authorize?client_id=111";
  let log: ReturnType<typeof vi.spyOn>;
  /** Each line printed, without colour codes. */
  const printed = () =>
    log.mock.calls
      .flatMap((args: unknown[]) => args.join(" ").split("\n"))
      .map((line: string) =>
        line
          .split("\u001b[")
          .map((part, i) =>
            i === 0 ? part : part.slice(part.indexOf("m") + 1),
          )
          .join(""),
      );
  const run = (
    overrides: Partial<PreviewParams> = {},
    currentEnv: Record<string, string | undefined> = {},
  ) =>
    provisionPreview(
      { ...params, automationBypassSecret: BYPASS, ...overrides },
      { cli: true, currentEnv },
    );

  beforeEach(() => {
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("for a new app that gets installed", async () => {
    await run();

    expect(printed()).toEqual([
      "  Reading manifest from manifest.json ...",
      "✓ Rewrote manifest.json for my-app-git-feat-thing.vercel.app",
      "  Creating Slack app ...",
      "✓ Created Slack app A_NEW",
      "  Installing Slack app ...",
      "✓ Installed Slack app A_NEW",
      "  View app: https://api.slack.com/apps/A_NEW",
    ]);
  });

  it("for an existing app", async () => {
    await run({ slackAppId: "A_OLD" }, { SLACK_BOT_TOKEN: "xoxb-1" });

    expect(printed().slice(2)).toEqual([
      "  Updating Slack app A_OLD ...",
      "✓ Updated Slack app A_OLD",
      "  Installing Slack app ...",
      "✓ Installed Slack app A_OLD",
      "  View app: https://api.slack.com/apps/A_OLD",
    ]);
  });

  // The link to install it by hand is Slack's, which only a new app has.
  it("for a new app without a service token: where to install it", async () => {
    await run({ slackServiceToken: undefined });

    expect(printed().slice(4)).toEqual([
      "  Installing Slack app ...",
      "⚠ Skipped installing the app: SLACK_SERVICE_TOKEN is not set",
      `  Install it yourself if you haven't: ${OAUTH}`,
      `  To have builds install it, add a service token: ${SERVICE_DOCS}`,
      "  View app: https://api.slack.com/apps/A_NEW",
    ]);
  });

  it("for an existing app without a service token or a bot token: its settings page", async () => {
    await run({ slackServiceToken: undefined, slackAppId: "A_OLD" });

    expect(printed().slice(5)).toEqual([
      "⚠ Skipped installing the app: SLACK_SERVICE_TOKEN is not set",
      "  Install it yourself if you haven't: https://api.slack.com/apps/A_OLD",
      `  To have builds install it, add a service token: ${SERVICE_DOCS}`,
    ]);
  });

  // A build with a bot token belongs to an app that was installed before.
  it("for an app installed before: nothing about installing it by hand", async () => {
    await run(
      { slackServiceToken: undefined, slackAppId: "A_OLD" },
      { SLACK_BOT_TOKEN: "xoxb-1" },
    );

    expect(printed().slice(5)).toEqual([
      "⚠ Skipped installing the app: SLACK_SERVICE_TOKEN is not set",
      `  To have builds install it, add a service token: ${SERVICE_DOCS}`,
      "  View app: https://api.slack.com/apps/A_OLD",
    ]);
  });

  // What a free workspace that already has 10 apps answers.
  it("for a full workspace", async () => {
    answers["apps.developerInstall"] = () =>
      json({ ok: false, error: "service_limits_exceeded" });

    await run();

    expect(printed().slice(5)).toEqual([
      "⚠ Couldn't install the app: Slack answered service_limits_exceeded",
      "  The workspace is at its app limit (10 on Slack's free plan). Remove an app or upgrade, then redeploy.",
      "  View app: https://api.slack.com/apps/A_NEW",
    ]);
  });

  it("for a service token Slack refuses", async () => {
    answers["apps.developerInstall"] = () =>
      json({ ok: false, error: "invalid_auth" });

    await run({ slackAppId: "A_OLD" }, { SLACK_BOT_TOKEN: "xoxb-1" });

    expect(printed().slice(5)).toEqual([
      "⚠ Couldn't install the app: Slack answered invalid_auth",
      `  Generate a new SLACK_SERVICE_TOKEN: ${SERVICE_DOCS}`,
      "  View app: https://api.slack.com/apps/A_OLD",
    ]);
  });

  it("for an outage", async () => {
    answers["apps.developerInstall"] = () =>
      new Response(null, { status: 503, statusText: "Service Unavailable" });

    await run();

    expect(printed().slice(5)).toEqual([
      "⚠ Couldn't install the app: Slack answered 503 Service Unavailable",
      "  Redeploy to try again.",
      "  View app: https://api.slack.com/apps/A_NEW",
    ]);
  });

  it("for a code it has no advice for: where to install it by hand", async () => {
    answers["apps.developerInstall"] = () =>
      json({ ok: false, error: "something_new" });

    await run();

    expect(printed().slice(5)).toEqual([
      "⚠ Couldn't install the app: Slack answered something_new",
      `  Install it yourself if you haven't: ${OAUTH}`,
      "  View app: https://api.slack.com/apps/A_NEW",
    ]);
  });

  it.each([
    [
      "app_approval_request_eligible",
      "Couldn't install the app: a workspace admin has to approve it first",
      ["Ask an admin to approve it, then redeploy."],
    ],
    [
      "app_approval_request_pending",
      "Couldn't install the app: it's waiting for a workspace admin's approval",
      ["Redeploy once it's approved."],
    ],
    [
      "app_approval_request_denied",
      "Couldn't install the app: a workspace admin denied its approval request",
      [],
    ],
    [
      "no_access",
      "Couldn't install the app: SLACK_SERVICE_TOKEN can't access app A1",
      [
        `Create the service token and the configuration token as the same Slack user: ${SERVICE_DOCS}`,
      ],
    ],
    [
      "invalid_app_id",
      "Couldn't install the app: Slack doesn't recognize app A1",
      [
        "This is likely a bug in @vercel/slack-bolt. Please report it: https://github.com/vercel-labs/slack-bolt/issues",
      ],
    ],
  ] as const)("for %s", (status, headline, details) => {
    // Installing by hand wouldn't get past any of these.
    expect(
      installAdvice(status, undefined, "A1", "Install it yourself"),
    ).toEqual({ headline, details });
  });
});

describe("for the build that runs it", () => {
  const provision = (
    currentEnv: Record<string, string | undefined>,
    overrides: Partial<PreviewParams> = {},
  ) =>
    provisionPreview(
      { ...params, automationBypassSecret: BYPASS, ...overrides },
      { currentEnv },
    );

  it("lists every variable of a new app as missing from the build", async () => {
    const { changedEnv } = await provision({});

    expect(changedEnv).toEqual([
      "SLACK_APP_ID",
      "SLACK_CLIENT_ID",
      "SLACK_CLIENT_SECRET",
      "SLACK_SIGNING_SECRET",
      "SLACK_BOT_TOKEN",
    ]);
  });

  it("doesn't save a token the build already has", async () => {
    const { changedEnv } = await provision(
      { SLACK_APP_ID: "A_OLD", SLACK_BOT_TOKEN: "xoxb-1" },
      { slackAppId: "A_OLD" },
    );

    expect(changedEnv).toEqual([]);
    expect(savedEnvs()).toEqual([]);
  });

  it("saves a token the build doesn't have, and lists it", async () => {
    const { changedEnv } = await provision(
      { SLACK_APP_ID: "A_OLD" },
      { slackAppId: "A_OLD" },
    );

    expect(changedEnv).toEqual(["SLACK_BOT_TOKEN"]);
    expect(savedEnvs().map((e) => [e.key, e.value])).toEqual([
      ["SLACK_BOT_TOKEN", "xoxb-1"],
    ]);
  });

  // The project can have a token for every preview, like a shared
  // development app's. The branch's own app needs its own.
  it("saves the branch's token over a different one the build has", async () => {
    const { changedEnv } = await provision(
      { SLACK_APP_ID: "A_OLD", SLACK_BOT_TOKEN: "xoxb-shared" },
      { slackAppId: "A_OLD" },
    );

    expect(changedEnv).toEqual(["SLACK_BOT_TOKEN"]);
  });

  it("lists nothing when the app isn't installed", async () => {
    answers["apps.developerInstall"] = () =>
      json({ ok: false, error: "service_limits_exceeded" });

    const { changedEnv } = await provision(
      { SLACK_APP_ID: "A_OLD" },
      { slackAppId: "A_OLD" },
    );

    expect(changedEnv).toEqual([]);
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
