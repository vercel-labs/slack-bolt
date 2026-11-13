import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetSecrets } from "./internal/secrets";
import { type PreviewApp, type PreviewOptions, preview } from "./preview";
import {
  BUILD,
  fakeApis,
  inBuild,
  MANIFEST,
  offline,
  recorder,
  refuse,
  rejection,
  status,
  stored,
} from "./testing";

vi.mock("./internal/wait", () => ({ wait: () => Promise.resolve() }));

const BRANCH = "feature/login";
const HOST = BUILD.VERCEL_BRANCH_URL;
const BYPASS = BUILD.VERCEL_AUTOMATION_BYPASS_SECRET;
const LIST = "GET /v10/projects/prj_1/env";
const SAVE = "POST /v10/projects/prj_1/env";
const DELETE = "DELETE /v1/projects/prj_1/env";
const META = "GET /v13/deployments/dpl_1";
const REDEPLOY = "POST /v13/deployments";
const CANCEL = "PATCH /v12/deployments/dpl_1/cancel";

/** A project where the branch has app `A_OLD`, and whatever else is given. */
const withApp = (...more: object[]) => ({
  [LIST]: {
    envs: [stored("SLACK_APP_ID", { branch: BRANCH, value: "A_OLD" }), ...more],
  },
});

/** A build whose deployment was created with the branch's variables. */
const UP_TO_DATE = {
  SLACK_APP_ID: "A_OLD",
  SLACK_BOT_TOKEN: "xoxb-bot-token-0001",
};

const run = async (options: PreviewOptions = {}) =>
  (await preview({ manifest: MANIFEST, ...options })) as PreviewApp;

/** The manifest a call sent to Slack. */
const sentManifest = (api: ReturnType<typeof fakeApis>, call: string) =>
  JSON.parse(api.body<{ manifest: string }>(call).manifest);

beforeEach(() => inBuild());

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetSecrets();
});

describe("a branch's first build", () => {
  it("creates the app, saves its variables, installs it and replaces the deployment", async () => {
    const api = fakeApis();

    const result = await run();

    expect(api.calls()).toEqual([
      LIST,
      "auth.test",
      "apps.manifest.create",
      SAVE,
      "apps.developerInstall",
      SAVE,
      META,
      REDEPLOY,
      CANCEL,
    ]);
    expect(result).toEqual({
      status: "redeployed",
      branch: BRANCH,
      app: {
        id: "A_NEW",
        name: "Acme (feature-login)",
        created: true,
        url: "https://api.slack.com/apps/A_NEW",
        installUrl: "https://slack.com/oauth/v2/authorize?client_id=111",
      },
      installation: { installed: true },
      saved: [
        "SLACK_APP_ID",
        "SLACK_CLIENT_ID",
        "SLACK_CLIENT_SECRET",
        "SLACK_SIGNING_SECRET",
        "SLACK_BOT_TOKEN",
      ],
      deployment: { id: "dpl_2", url: "new-deployment.vercel.app" },
    });
  });

  it("saves the variables for the branch's previews: identifiers readable, secrets Sensitive", async () => {
    const api = fakeApis();

    await run();

    expect(api.savedEnv()).toEqual(
      [
        ["SLACK_APP_ID", "A_NEW", "plain"],
        ["SLACK_CLIENT_ID", "111.222", "plain"],
        ["SLACK_CLIENT_SECRET", "client-secret-value", "sensitive"],
        ["SLACK_SIGNING_SECRET", "signing-secret-value", "sensitive"],
        ["SLACK_BOT_TOKEN", "xoxb-bot-token-0001", "sensitive"],
      ].map(([key, value, type]) => ({
        key,
        value,
        type,
        target: ["preview"],
        gitBranch: BRANCH,
        comment:
          "Slack app A_NEW for the feature/login preview. Managed by @vercel/slack-bolt.",
      })),
    );
    for (const request of api.to(SAVE)) {
      expect(request.url.searchParams.get("upsert")).toBe("true");
      expect(request.url.searchParams.get("teamId")).toBe("team_1");
    }
  });

  it("saves secrets readable with sensitive: false", async () => {
    const api = fakeApis();

    await run({ sensitive: false });

    expect(api.savedEnv().map((env) => env.type)).toEqual([
      "plain",
      "plain",
      "encrypted",
      "encrypted",
      "encrypted",
    ]);
  });

  it("sends Slack a manifest that points at the branch's deployment", async () => {
    const api = fakeApis();

    await run();

    const manifest = sentManifest(api, "apps.manifest.create");
    const called = `https://${HOST}/api/slack?x-vercel-protection-bypass=${BYPASS}`;
    expect(manifest.settings.event_subscriptions.request_url).toBe(called);
    expect(manifest.settings.interactivity.request_url).toBe(called);
    expect(manifest.features.slash_commands[0].url).toBe(called);
    expect(manifest.oauth_config.redirect_urls).toEqual([
      `https://${HOST}/api/slack/oauth`,
    ]);
    expect(manifest.display_information.name).toBe("Acme (feature-login)");
    expect(api.body("apps.developerInstall")).toEqual({
      app_id: "A_NEW",
      bot_scopes: ["chat:write", "commands"],
      outgoing_domains: [],
    });
  });

  it("starts the new deployment with a mark that says where it came from", async () => {
    const api = fakeApis();

    await run();

    const [request] = api.to(REDEPLOY);
    expect(request?.body).toEqual({
      deploymentId: "dpl_1",
      name: "prj_1",
      project: "prj_1",
      meta: { vercelSlackRedeployOf: "dpl_1" },
    });
    expect(request?.url.searchParams.get("forceNew")).toBe("1");
  });

  it("says what it did", async () => {
    fakeApis();
    const out = recorder();

    await run({ logger: out.logger });

    expect(out.said()).toEqual([
      "Created Slack app A_NEW (Acme (feature-login))",
      "Installed the app in the workspace",
      "Saved SLACK_APP_ID, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN for feature/login",
      "Started a deployment that has SLACK_APP_ID, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN: https://new-deployment.vercel.app",
      "  Canceled this deployment, which the new one replaces.",
    ]);
  });

  it("adds a bypass secret to the project when the build has none", async () => {
    inBuild({ VERCEL_AUTOMATION_BYPASS_SECRET: "" });
    const api = fakeApis();

    await run();

    const { generate } = api.body<{ generate: { secret: string } }>(
      "PATCH /v1/projects/prj_1/protection-bypass",
    );
    expect(generate.secret).toMatch(/^[a-f0-9]{32}$/);
    expect(
      sentManifest(api, "apps.manifest.create").settings.event_subscriptions
        .request_url,
    ).toBe(
      `https://${HOST}/api/slack?x-vercel-protection-bypass=${generate.secret}`,
    );
  });
});

describe("a later build", () => {
  it("updates the branch's app and changes nothing else", async () => {
    inBuild(UP_TO_DATE);
    const api = fakeApis(withApp());

    const result = await run();

    expect(api.calls()).toEqual([
      LIST,
      "auth.test",
      "apps.manifest.update",
      "apps.developerInstall",
    ]);
    expect(api.body("apps.manifest.update")).toMatchObject({ app_id: "A_OLD" });
    expect(result).toMatchObject({
      status: "ready",
      app: {
        id: "A_OLD",
        created: false,
        installUrl: "https://api.slack.com/apps/A_OLD/install-on-team",
      },
      saved: [],
    });
  });

  it("finds the branch's app in the project, not in the build's environment", async () => {
    // Like production's app ID, set for every environment.
    inBuild({
      SLACK_APP_ID: "A_PRODUCTION",
      SLACK_BOT_TOKEN: "xoxb-production",
    });
    const api = fakeApis();

    const result = await run();

    expect(api.calls()).not.toContain("apps.manifest.update");
    expect(result.app).toMatchObject({ id: "A_NEW", created: true });
  });

  it("reads an app ID that Vercel doesn't list in the clear", async () => {
    inBuild(UP_TO_DATE);
    const api = fakeApis({
      [LIST]: {
        envs: [
          stored("SLACK_APP_ID", {
            branch: BRANCH,
            type: "encrypted",
            id: "env_app",
          }),
        ],
      },
      "GET /v1/projects/prj_1/env/env_app": {
        type: "encrypted",
        value: "A_V1",
      },
    });
    inBuild({ SLACK_APP_ID: "A_V1", SLACK_BOT_TOKEN: "xoxb-bot-token-0001" });

    await run();

    expect(api.body("apps.manifest.update")).toMatchObject({ app_id: "A_V1" });
  });

  it("falls back to the deployment's own SLACK_APP_ID when Vercel won't show the stored one", async () => {
    inBuild(UP_TO_DATE);
    const api = fakeApis({
      [LIST]: {
        envs: [stored("SLACK_APP_ID", { branch: BRANCH, id: "env_app" })],
      },
      "GET /v1/projects/prj_1/env/env_app": { type: "sensitive", value: "" },
    });

    await run();

    expect(api.body("apps.manifest.update")).toMatchObject({ app_id: "A_OLD" });
  });

  it("stops when the branch's app ID can't be found, rather than create a second app", async () => {
    const api = fakeApis({
      [LIST]: {
        envs: [stored("SLACK_APP_ID", { branch: BRANCH, id: "env_app" })],
      },
      "GET /v1/projects/prj_1/env/env_app": { type: "sensitive", value: "" },
    });

    await expect(run()).rejects.toThrow(
      /Vercel doesn't show the value of feature\/login's SLACK_APP_ID/,
    );
    expect(api.calls()).not.toContain("apps.manifest.create");
  });

  it("saves a token the deployment was built without, and replaces the deployment", async () => {
    // Its first install waited for an admin's approval.
    inBuild({ SLACK_APP_ID: "A_OLD" });
    const api = fakeApis(withApp());

    const result = await run();

    expect(api.savedEnv().map((env) => env.key)).toEqual(["SLACK_BOT_TOKEN"]);
    expect(result).toMatchObject({
      status: "redeployed",
      saved: ["SLACK_BOT_TOKEN"],
    });
  });

  it("replaces a deployment that's older than the app's variables", async () => {
    // Created before another build of the branch made the app.
    inBuild({ SLACK_BOT_TOKEN: "xoxb-bot-token-0001" });
    const api = fakeApis(
      withApp(stored("SLACK_SIGNING_SECRET", { branch: BRANCH })),
    );
    const out = recorder();

    const result = await run({ logger: out.logger });

    expect(result).toMatchObject({ status: "redeployed", saved: [] });
    expect(api.calls()).toContain(REDEPLOY);
    expect(out.said()).toContain(
      "Started a deployment that has SLACK_APP_ID, SLACK_SIGNING_SECRET: https://new-deployment.vercel.app",
    );
  });

  it("doesn't replace a deployment that was itself started as a replacement", async () => {
    inBuild({ SLACK_APP_ID: "A_OLD" });
    const api = fakeApis({
      ...withApp(),
      [META]: {
        meta: { vercelSlackRedeployOf: "dpl_0", originalDeploymentId: "dpl_0" },
      },
    });
    const out = recorder();

    const result = await run({ logger: out.logger });

    expect(result.status).toBe("outdated");
    expect(api.calls()).not.toContain(REDEPLOY);
    expect(out.said().slice(-2)).toEqual([
      "! This deployment was built without SLACK_BOT_TOKEN, and it was started to pick them up",
      "  Not starting another. Redeploy the branch yourself.",
    ]);
  });

  it("replaces a deployment that someone redeployed from a replacement", async () => {
    inBuild({ SLACK_APP_ID: "A_OLD" });
    const api = fakeApis({
      ...withApp(),
      // The mark is copied from the deployment it was made from.
      [META]: {
        meta: { vercelSlackRedeployOf: "dpl_0", originalDeploymentId: "dpl_9" },
      },
    });

    expect((await run()).status).toBe("redeployed");
    expect(api.calls()).toContain(REDEPLOY);
  });

  it("replaces the deployment when it can't tell how it was started", async () => {
    inBuild({ SLACK_APP_ID: "A_OLD" });
    fakeApis({ ...withApp(), [META]: status(404) });

    expect((await run()).status).toBe("redeployed");
  });

  it("replaces nothing outside a deployment", async () => {
    inBuild({ VERCEL_DEPLOYMENT_ID: "" });
    const api = fakeApis();

    const result = await run();

    expect(result.status).toBe("ready");
    expect(api.calls()).not.toContain(REDEPLOY);
  });

  it("carries on when this deployment can't be canceled", async () => {
    fakeApis({ [CANCEL]: status(403, { error: { code: "forbidden" } }) });
    const out = recorder();

    const result = await run({ logger: out.logger });

    expect(result.status).toBe("redeployed");
    expect(out.said().at(-1)).toBe(
      "! Couldn't cancel this deployment, which the new one replaces: Vercel answered 403: forbidden",
    );
  });

  it("fails when the new deployment can't be started", async () => {
    fakeApis({
      [REDEPLOY]: status(402, { error: { code: "payment_required" } }),
    });

    await expect(run()).rejects.toThrow(
      /a new one couldn't be started: Vercel answered 402: payment_required\nThe variables are saved\. Redeploy the branch to use them\./,
    );
  });

  it("keeps this deployment when Vercel's answer doesn't name a new one", async () => {
    const api = fakeApis({ [REDEPLOY]: { url: "new-deployment.vercel.app" } });

    await expect(run()).rejects.toThrow(
      /a new one couldn't be started: Vercel's answer doesn't name the new deployment\nThe variables are saved\./,
    );
    expect(api.calls()).not.toContain(CANCEL);
  });
});

describe("an app the token can no longer manage", () => {
  it.each([
    "app_not_found",
    "invalid_app_id",
    "no_permission",
    "app_not_owned_by_manager_app",
    "app_not_eligible",
  ])("is replaced after %s, along with the tokens it left", async (code) => {
    inBuild(UP_TO_DATE);
    const api = fakeApis({
      ...withApp(stored("SLACK_BOT_TOKEN", { branch: BRANCH, id: "env_bot" })),
      "apps.manifest.update": refuse(code),
    });
    const out = recorder();

    const result = await run({ logger: out.logger });

    expect(result.app).toMatchObject({
      id: "A_NEW",
      created: true,
      replaced: "A_OLD",
    });
    expect(api.body(DELETE)).toEqual({ ids: ["env_bot"] });
    expect(out.said()).toContain(
      "  Slack app A_OLD is deleted or belongs to another Slack user, so the branch has a new one.",
    );
  });

  it.each([
    ["an error Slack doesn't document", refuse("some_new_error")],
    ["a workspace that's migrating", refuse("team_added_to_org")],
    ["a refused token", refuse("invalid_auth")],
    ["an answer that isn't JSON", status(200, "<html>Maintenance</html>")],
    ["a server error", status(503)],
    ["no answer", offline],
  ])(
    "is kept after %s: the build stops and creates nothing",
    async (_, answer) => {
      inBuild(UP_TO_DATE);
      const api = fakeApis({ ...withApp(), "apps.manifest.update": answer });

      await expect(run()).rejects.toThrow(/Couldn't update Slack app A_OLD/);
      expect(api.calls()).not.toContain("apps.manifest.create");
      expect(api.calls()).not.toContain(SAVE);
    },
  );
});

describe("when something fails", () => {
  it("deletes a new app again when its variables can't be saved", async () => {
    const api = fakeApis({
      [SAVE]: status(403, { error: { code: "forbidden", message: "No." } }),
    });

    await expect(run()).rejects.toThrow(
      "Created Slack app A_NEW, but couldn't save its variables to Vercel: Vercel answered 403: forbidden\nDeleted the app again. Check that VERCEL_API_TOKEN can write environment variables, then redeploy.",
    );
    expect(api.body("apps.manifest.delete")).toEqual({ app_id: "A_NEW" });
    expect(api.calls()).not.toContain("apps.developerInstall");
  });

  it("deletes a new app again when Vercel saves only some of its variables", async () => {
    const api = fakeApis({
      [SAVE]: {
        created: [],
        failed: [
          { error: { code: "ENV_CONFLICT", envVarKey: "SLACK_APP_ID" } },
        ],
      },
    });

    await expect(run()).rejects.toThrow(
      /Vercel didn't save every variable: SLACK_APP_ID \(ENV_CONFLICT\)/,
    );
    expect(api.calls()).toContain("apps.manifest.delete");
  });

  it("says where to delete the app when that fails too", async () => {
    fakeApis({
      [SAVE]: status(403),
      "apps.manifest.delete": refuse("internal_error"),
    });

    await expect(run()).rejects.toThrow(
      /Couldn't delete the app again either\. Delete it yourself: https:\/\/api\.slack\.com\/apps\/A_NEW/,
    );
  });

  it("lists what Slack found wrong with the manifest", async () => {
    const api = fakeApis({
      "apps.manifest.create": refuse("invalid_manifest", {
        errors: [
          {
            message: "Interactivity requires a Request URL",
            pointer: "/settings/interactivity",
          },
          { message: "Something without a place" },
        ],
      }),
    });

    await expect(run()).rejects.toThrow(
      "Slack rejected the manifest\n- /settings/interactivity: Interactivity requires a Request URL\n- Something without a place\nFix the manifest, then redeploy.",
    );
    expect(api.calls()).not.toContain(SAVE);
  });

  it("stops before any request when the manifest can't be used", async () => {
    const api = fakeApis();

    await expect(run({ manifest: {} as never })).rejects.toThrow(
      /The manifest has no display_information\.name/,
    );
    expect(api.calls()).toEqual([]);
  });

  it.each([
    ["VERCEL_API_TOKEN", /VERCEL_API_TOKEN is not set\nCreate a token/],
    ["VERCEL_PROJECT_ID", /VERCEL_PROJECT_ID is not set/],
  ])("says so when %s is missing", async (name, message) => {
    inBuild({ [name]: "" });
    const api = fakeApis();

    await expect(run()).rejects.toThrow(message);
    expect(api.calls()).toEqual([]);
  });

  it("blames the Vercel token when the project can't be read, before touching Slack", async () => {
    const api = fakeApis({
      [LIST]: status(403, { error: { code: "forbidden" } }),
    });

    await expect(run()).rejects.toThrow(
      /VERCEL_API_TOKEN can't read this project's environment variables\nCheck that it's valid/,
    );
    expect(api.calls()).toEqual([LIST]);
  });

  it("rejects a token with a line break in it without repeating it", async () => {
    inBuild({ VERCEL_API_TOKEN: "vercel-api\ntoken-0001" });
    fakeApis();

    const error = await rejection(run());

    expect(error.message).toMatch(/^VERCEL_API_TOKEN has a space, line break/);
    expect(error.message).not.toContain("token-0001");
  });

  it("never puts a secret in an error or in a log line", async () => {
    const secrets = [
      BYPASS,
      BUILD.VERCEL_API_TOKEN,
      BUILD.SLACK_CONFIGURATION_TOKEN,
      BUILD.SLACK_SERVICE_TOKEN,
      "client-secret-value",
      "signing-secret-value",
      "verification-token-value",
      "xoxb-bot-token-0001",
    ];
    // Slack and Vercel quote what they were sent.
    fakeApis({
      "apps.developerInstall": refuse(`bad_${BUILD.SLACK_SERVICE_TOKEN}`),
      [REDEPLOY]: status(400, {
        error: { code: "bad_request", message: `Not ${secrets.join(" ")}` },
      }),
    });
    const out = recorder();

    const error = await rejection(run({ logger: out.logger }));

    const printed = [out.text(), error.message, String(error.cause)].join("\n");
    expect(printed).toContain("[redacted]");
    for (const secret of secrets) expect(printed).not.toContain(secret);
  });
});

describe("installing the app", () => {
  it("says once, for a new app, how to install it without a service token", async () => {
    inBuild({ SLACK_SERVICE_TOKEN: "" });
    const api = fakeApis();
    const out = recorder();

    const result = await run({ logger: out.logger });

    expect(result.installation).toEqual({
      installed: false,
      reason: "no_service_token",
    });
    expect(api.calls()).not.toContain("apps.developerInstall");
    expect(out.said().slice(1, 4)).toEqual([
      "! The app isn't installed: SLACK_SERVICE_TOKEN is not set",
      "  Install it: https://slack.com/oauth/v2/authorize?client_id=111",
      "  To have builds install it, add a service token: https://docs.slack.dev/authentication/tokens/#service",
    ]);
  });

  it("doesn't repeat that on later builds", async () => {
    inBuild({ SLACK_APP_ID: "A_OLD", SLACK_SERVICE_TOKEN: "" });
    fakeApis(withApp());
    const out = recorder();

    await run({ logger: out.logger });

    expect(out.said()).toEqual([
      "Updated Slack app A_OLD (Acme (feature-login))",
    ]);
  });

  it.each([
    [
      "app_approval_request_eligible",
      "approval_required",
      "a workspace admin has to approve it first",
    ],
    [
      "app_approval_request_pending",
      "approval_pending",
      "it's waiting for a workspace admin's approval",
    ],
    [
      "app_approval_request_denied",
      "approval_denied",
      "a workspace admin denied its approval request",
    ],
  ])("reports %s as %s, and the build goes on", async (code, reason, why) => {
    fakeApis({ "apps.developerInstall": refuse(code) });
    const out = recorder();

    const result = await run({ logger: out.logger });

    expect(result.installation).toEqual({ installed: false, reason });
    expect(result.status).toBe("redeployed");
    expect(out.said()).toContain(`! The app isn't installed: ${why}`);
  });

  it.each(["app_not_found", "no_permission"])(
    "reports an app the service token's user can't see (%s)",
    async (probe) => {
      fakeApis({
        "apps.developerInstall": refuse("invalid_app_id"),
        "apps.manifest.export": refuse(probe),
      });

      expect((await run()).installation).toEqual({
        installed: false,
        reason: "no_access",
      });
    },
  );

  it("reports Slack's code when it refuses for another reason", async () => {
    fakeApis({ "apps.developerInstall": refuse("token_revoked") });
    const out = recorder();

    const result = await run({ logger: out.logger });

    expect(result.installation).toEqual({
      installed: false,
      reason: "refused",
      code: "token_revoked",
    });
    expect(out.said()).toContain(
      "  Generate a new SLACK_SERVICE_TOKEN: https://docs.slack.dev/authentication/tokens/#service",
    );
  });

  it("gives the install link when Slack refuses the app itself", async () => {
    fakeApis({
      "apps.developerInstall": refuse("invalid_app_id"),
      "apps.manifest.export": { ok: true },
    });
    const out = recorder();

    await run({ logger: out.logger });

    expect(out.said()).toContain(
      "  Install it yourself: https://slack.com/oauth/v2/authorize?client_id=111",
    );
  });

  it("goes on when Slack can't be reached to install it", async () => {
    fakeApis({ "apps.developerInstall": offline });
    const out = recorder();

    const result = await run({ logger: out.logger });

    expect(result.installation).toEqual({
      installed: false,
      reason: "unavailable",
    });
    expect(out.said()).toContain(
      "! Couldn't install the app: Slack couldn't be reached",
    );
  });

  it("fails when the tokens of an installed app can't be saved", async () => {
    inBuild({ SLACK_APP_ID: "A_OLD" });
    fakeApis({ ...withApp(), [SAVE]: status(500) });

    await expect(run()).rejects.toThrow(
      "Installed Slack app A_OLD, but couldn't save its tokens to Vercel: Vercel answered 500\nRedeploy to try again.",
    );
  });
});

describe("deployments that aren't a branch's preview", () => {
  it.each([
    [
      "production",
      { VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production" },
    ],
    [
      "a custom environment",
      { VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "staging" },
    ],
    ["development", { VERCEL_ENV: "development", VERCEL_TARGET_ENV: "" }],
  ])("are skipped: %s", async (_, env) => {
    // Without the tokens, which such a deployment may not have.
    inBuild({ ...env, VERCEL_API_TOKEN: "", SLACK_CONFIGURATION_TOKEN: "" });
    const api = fakeApis();
    const out = recorder();

    const result = await preview({ logger: out.logger });

    expect(result).toMatchObject({ status: "skipped", reason: "not_preview" });
    expect(out.said()).toEqual([
      expect.stringMatching(/^ {2}Not a preview deployment \(/),
    ]);
    expect(api.calls()).toEqual([]);
  });

  it("are skipped: a deployment that isn't of a Git branch", async () => {
    inBuild({ VERCEL_GIT_COMMIT_REF: "" });
    const api = fakeApis();

    expect(await preview()).toMatchObject({
      status: "skipped",
      reason: "no_branch",
    });
    expect(api.calls()).toEqual([]);
  });
});

describe("options", () => {
  it("take the place of the environment", async () => {
    const api = fakeApis();

    const result = await run({
      branch: "other/branch",
      url: "https://other.example.com/ignored",
      commit: { sha: "0123456789" },
    });

    const manifest = sentManifest(api, "apps.manifest.create");
    expect(result.branch).toBe("other/branch");
    expect(api.savedEnv()[0]).toMatchObject({ gitBranch: "other/branch" });
    expect(manifest.settings.event_subscriptions.request_url).toMatch(
      /^https:\/\/other\.example\.com\/api\/slack\?/,
    );
    expect(manifest.display_information.long_description).toContain(
      "It runs commit 0123456 ",
    );
  });

  it("use the deployment's own URL when the branch has none", async () => {
    inBuild({ VERCEL_BRANCH_URL: "" });
    const api = fakeApis();

    await run();

    expect(
      sentManifest(api, "apps.manifest.create").oauth_config.redirect_urls,
    ).toEqual([`https://${BUILD.VERCEL_URL}/api/slack/oauth`]);
  });

  it("send a team ID the CLI linked, but not a personal account's", async () => {
    inBuild({
      VERCEL_TEAM_ID: "",
      VERCEL_ORG_ID: "team_linked",
      ...UP_TO_DATE,
    });
    const linked = fakeApis(withApp());
    await run();
    expect(linked.sent[0]?.url.searchParams.get("teamId")).toBe("team_linked");

    inBuild({ VERCEL_TEAM_ID: "", VERCEL_ORG_ID: "user_1", ...UP_TO_DATE });
    const personal = fakeApis(withApp());
    await run();
    expect(personal.sent[0]?.url.searchParams.has("teamId")).toBe(false);
  });
});

describe("the manifest file", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vercel-slack-"));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is found in the working directory and left as it is", async () => {
    const file = path.join(dir, "manifest.yaml");
    const yaml = "display_information:\n  name: From YAML\n";
    fs.writeFileSync(file, yaml);
    const api = fakeApis();

    const result = (await preview()) as PreviewApp;

    expect(result.app.name).toBe("From YAML (feature-login)");
    expect(api.calls()).toContain("apps.manifest.create");
    expect(fs.readFileSync(file, "utf8")).toBe(yaml);
    expect(fs.readdirSync(dir)).toEqual(["manifest.yaml"]);
  });

  it("is where MANIFEST_PATH says, and an option says otherwise", async () => {
    fs.mkdirSync(path.join(dir, "slack"));
    fs.writeFileSync(
      path.join(dir, "slack/app.json"),
      JSON.stringify({ display_information: { name: "From env" } }),
    );
    fs.writeFileSync(
      path.join(dir, "option.json"),
      JSON.stringify({ display_information: { name: "From option" } }),
    );
    inBuild({ MANIFEST_PATH: "slack/app.json" });
    fakeApis();

    expect(((await preview()) as PreviewApp).app.name).toBe(
      "From env (feature-login)",
    );
    expect(
      (
        (await preview({
          manifest: path.join(dir, "option.json"),
        })) as PreviewApp
      ).app.name,
    ).toBe("From option (feature-login)");
  });

  it("stops the build when it's missing", async () => {
    const api = fakeApis();

    await expect(preview()).rejects.toThrow(
      `No manifest.json in ${dir}\nCreate one, or set MANIFEST_PATH to where yours is: https://docs.slack.dev/reference/app-manifest`,
    );
    expect(api.calls()).toEqual([]);
  });
});

describe("what else can go wrong", () => {
  const hidden = {
    [LIST]: {
      envs: [
        stored("SLACK_APP_ID", {
          branch: BRANCH,
          type: "encrypted",
          id: "env_app",
        }),
      ],
    },
  };

  it("stops when the branch's app ID can't be read, rather than create a second app", async () => {
    const api = fakeApis({
      ...hidden,
      "GET /v1/projects/prj_1/env/env_app": status(500),
    });

    await expect(run()).rejects.toThrow(
      "Couldn't read feature/login's SLACK_APP_ID from Vercel: Vercel answered 500\nRedeploy to try again.",
    );
    expect(api.calls()).not.toContain("apps.manifest.create");
  });

  it("stops before creating an app when a bypass secret can't be added", async () => {
    inBuild({ VERCEL_AUTOMATION_BYPASS_SECRET: "" });
    const api = fakeApis({
      "PATCH /v1/projects/prj_1/protection-bypass": status(403),
    });

    await expect(run()).rejects.toThrow(
      "Couldn't create a Protection Bypass for Automation secret: Vercel answered 403\nCreate one in the project's Deployment Protection settings, then redeploy.",
    );
    expect(api.calls()).not.toContain("apps.manifest.create");
  });

  it("goes on when the tokens of the branch's earlier app can't be deleted", async () => {
    inBuild(UP_TO_DATE);
    fakeApis({
      ...withApp(stored("SLACK_BOT_TOKEN", { branch: BRANCH })),
      "apps.manifest.update": refuse("app_not_found"),
      [DELETE]: status(403),
    });
    const out = recorder();

    const result = await run({ logger: out.logger });

    expect(result.app.id).toBe("A_NEW");
    expect(out.said()).toContain(
      "! Couldn't delete the tokens of the branch's earlier app (SLACK_BOT_TOKEN): Vercel answered 403",
    );
  });

  it("says so when the build doesn't know its own URL", async () => {
    inBuild({ VERCEL_BRANCH_URL: "", VERCEL_URL: "" });
    fakeApis();

    await expect(run()).rejects.toThrow(/^VERCEL_BRANCH_URL is not set\n/);
  });

  it.each([
    [
      "Vercel can't be reached",
      offline,
      "Vercel couldn't be reached\nRedeploy to try again.",
    ],
    [
      "Vercel's answer makes no sense",
      {},
      "Vercel's list of environment variables has no envs\nThis looks like a bug in @vercel/slack-bolt. Please report it: https://github.com/vercel-labs/slack-bolt/issues",
    ],
  ])("says what to do when %s", async (_, answer, message) => {
    const api = fakeApis({ [LIST]: answer });

    await expect(run()).rejects.toThrow(
      `Couldn't list the project's environment variables: ${message}`,
    );
    expect(api.calls()).not.toContain("auth.test");
  });

  it("says a deployment was started even when Vercel doesn't say where", async () => {
    fakeApis({ [REDEPLOY]: { id: "dpl_2" } });
    const out = recorder();

    const result = await run({ logger: out.logger });

    expect(result.deployment).toEqual({ id: "dpl_2", url: "" });
    expect(out.said().at(-2)).toMatch(/SLACK_BOT_TOKEN$/);
  });
});

describe("an error that quotes what was sent", () => {
  it("leaves without the secret in it", async () => {
    // Slack quotes the URL it didn't like, and that URL carries the secret.
    const url = `https://${HOST}/api/slack?x-vercel-protection-bypass=${BYPASS}`;
    fakeApis({
      "apps.manifest.create": refuse("invalid_manifest", {
        errors: [{ message: `${url} isn't reachable`, pointer: "/settings" }],
      }),
    });

    const error = await rejection(run());

    expect(error.message).toBe(
      `Slack rejected the manifest\n- /settings: https://${HOST}/api/slack?x-vercel-protection-bypass=[redacted] isn't reachable\nFix the manifest, then redeploy.`,
    );
  });
});
