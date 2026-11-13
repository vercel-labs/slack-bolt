// The Slack and Vercel clients: what they send, and how they read answers.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeApis,
  offline,
  recorder,
  refuse,
  rejection,
  status,
  stored,
} from "../testing";
import { SlackError, Unavailable, VercelError } from "./errors";
import { logTo } from "./log";
import { forgetSecrets, scrub } from "./secrets";
import { createSlack } from "./slack";
import { createVercel } from "./vercel";

vi.mock("./wait", () => ({ wait: () => Promise.resolve() }));

const LIST = "GET /v10/projects/prj_1/env";
const SAVE = "POST /v10/projects/prj_1/env";
const DELETE = "DELETE /v1/projects/prj_1/env";
const BRANCHES = "GET /v5/projects/prj_1/branches";

const out = recorder();
const log = logTo(out.logger);
const slack = createSlack(log);
const vercel = (teamId?: string, projectId = "prj_1") =>
  createVercel({ token: "vercel-api-token-0001", projectId, teamId, log });

afterEach(() => {
  vi.unstubAllGlobals();
  forgetSecrets();
  out.lines.length = 0;
});

describe("Slack", () => {
  it("sends JSON with the token as a bearer", async () => {
    const api = fakeApis();

    await slack.updateApp("xoxe.xoxp-1-token", "A1", {
      display_information: { name: "Acme" },
    });

    const [request] = api.sent;
    expect(request?.url.href).toBe(
      "https://slack.com/api/apps.manifest.update",
    );
    expect(request?.headers).toMatchObject({
      authorization: "Bearer xoxe.xoxp-1-token",
      "content-type": "application/json; charset=utf-8",
    });
    expect(request?.body).toEqual({
      app_id: "A1",
      manifest: '{"display_information":{"name":"Acme"}}',
    });
  });

  it("rotates with a form, and no token but the refresh token", async () => {
    const api = fakeApis();

    await expect(slack.rotate("xoxe-1-refresh")).resolves.toEqual({
      token: "xoxe.xoxp-1-rotated-token",
      refreshToken: "xoxe-1-rotated-refresh",
    });
    expect(api.sent[0]?.headers).toEqual({
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(api.sent[0]?.body).toEqual({ refresh_token: "xoxe-1-refresh" });
  });

  it("throws Slack's error code, and what it found in a manifest", async () => {
    const problems = [{ message: "No.", pointer: "/settings" }];
    fakeApis({ "auth.test": refuse("invalid_manifest", { errors: problems }) });

    const error = await rejection(slack.authTest("t"));

    expect(error).toBeInstanceOf(SlackError);
    expect(error).toMatchObject({
      message: "Slack answered auth.test with invalid_manifest",
      method: "auth.test",
      code: "invalid_manifest",
      problems,
    });
    expect(out.lines.at(-1)).toBe("?   auth.test: invalid_manifest");
  });

  it.each([
    ["a refusal without a code", { ok: false }, "unknown_error"],
    [
      "a refusal with an HTTP error status",
      status(400, refuse("invalid_arguments")),
      "invalid_arguments",
    ],
  ])("reads %s", async (_, answer, code) => {
    fakeApis({ "auth.test": answer });

    await expect(slack.authTest("t")).rejects.toMatchObject({ code });
  });

  it.each([
    ["a page", status(200, "<html>Maintenance</html>")],
    ["an empty answer", status(200, "null")],
    ["a refusal that isn't JSON", status(403, "Forbidden")],
  ])("takes %s for no verdict at all", async (_, answer) => {
    fakeApis({ "auth.test": answer });

    const error = await rejection(slack.authTest("t"));

    expect(error).toBeInstanceOf(Unavailable);
    expect(error.message).toMatch(
      /^Slack answered auth\.test with \d+ and no JSON$/,
    );
  });

  it("creates an app once, and reads what Slack only says then", async () => {
    const api = fakeApis();

    await expect(
      slack.createApp("t", { display_information: { name: "Acme" } }),
    ).resolves.toEqual({
      id: "A_NEW",
      clientId: "111.222",
      clientSecret: "client-secret-value",
      signingSecret: "signing-secret-value",
      installUrl: "https://slack.com/oauth/v2/authorize?client_id=111",
    });
    // Each is a secret from here on, the one this package doesn't save too.
    expect(
      scrub(
        "client-secret-value signing-secret-value verification-token-value",
      ),
    ).toBe("[redacted] [redacted] [redacted]");

    api.fetch.mockClear();
    fakeApis({ "apps.manifest.create": offline });
    await expect(
      slack.createApp("t", { display_information: { name: "Acme" } }),
    ).rejects.toBeInstanceOf(Unavailable);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("refuses an app without an ID", async () => {
    fakeApis({ "apps.manifest.create": { ok: true } });

    await expect(
      slack.createApp("t", { display_information: { name: "Acme" } }),
    ).rejects.toMatchObject({ code: "no_app_id_in_answer" });
  });

  it.each([
    ["exists", { ok: true }, true],
    ["was deleted", refuse("app_not_found"), false],
    ["never existed", refuse("invalid_app_id"), false],
  ])("says whether an app is there: one that %s", async (_, answer, exists) => {
    fakeApis({ "apps.manifest.export": answer });

    await expect(slack.appExists("t", "A1")).resolves.toBe(exists);
  });

  it("doesn't guess whether an app is there", async () => {
    fakeApis({ "apps.manifest.export": refuse("no_permission") });

    await expect(slack.appExists("t", "A1")).rejects.toMatchObject({
      code: "no_permission",
    });
  });

  it("reads an installation's tokens, and keeps them out of print", async () => {
    fakeApis({
      "apps.developerInstall": {
        ok: true,
        api_access_tokens: {
          bot: "bot-token-000",
          app_level: "app-token-000",
          user: "user-token-00",
        },
      },
    });

    await expect(slack.install("t", "A1", ["commands"])).resolves.toEqual({
      bot: "bot-token-000",
      appLevel: "app-token-000",
      user: "user-token-00",
    });
    expect(scrub("bot-token-000 app-token-000 user-token-00")).not.toMatch(
      /token/,
    );

    fakeApis({ "apps.developerInstall": { ok: true } });
    await expect(slack.install("t", "A1", [])).resolves.toEqual({});
  });
});

describe("Vercel", () => {
  it("sends the token, and the team when there is one", async () => {
    const api = fakeApis({
      "GET /v10/projects/my%20project/env": { envs: [] },
    });

    await vercel("team_1").listEnv();
    await vercel(undefined, "my project").listEnv();

    expect(api.sent[0]?.headers).toEqual({
      authorization: "Bearer vercel-api-token-0001",
    });
    expect(api.sent[0]?.url.search).toBe("?teamId=team_1");
    expect(api.sent[1]?.url.href).toBe(
      "https://api.vercel.com/v10/projects/my%20project/env",
    );
  });

  it("lists variables with the value of plain ones only", async () => {
    fakeApis({
      [LIST]: {
        envs: [
          stored("SLACK_APP_ID", { branch: "x", value: "A1" }),
          {
            ...stored("SLACK_BOT_TOKEN", { type: "encrypted" }),
            target: "preview",
          },
          { id: "env_bare", key: "BARE" },
          { key: "NO_ID" },
          null,
        ],
        pagination: { count: 3, next: null, prev: null },
      },
    });

    await expect(vercel().listEnv()).resolves.toEqual([
      {
        id: "env_SLACK_APP_ID_x",
        key: "SLACK_APP_ID",
        type: "plain",
        target: ["preview"],
        gitBranch: "x",
        value: "A1",
      },
      {
        id: "env_SLACK_BOT_TOKEN_all",
        key: "SLACK_BOT_TOKEN",
        type: "encrypted",
        target: ["preview"],
        gitBranch: undefined,
        value: undefined,
      },
      {
        id: "env_bare",
        key: "BARE",
        type: undefined,
        target: [],
        gitBranch: undefined,
        value: undefined,
      },
    ]);
  });

  it.each([
    ["has no list", {}, "Vercel's list of environment variables has no envs"],
    [
      "is something else",
      "nope",
      "Vercel's list of environment variables has no envs",
    ],
    [
      "is one page of several",
      { envs: [], pagination: { next: 1700000000000 } },
      "Vercel's list of environment variables is only its first page",
    ],
  ])("refuses a list that %s", async (_, answer, message) => {
    fakeApis({ [LIST]: answer });

    await expect(vercel().listEnv()).rejects.toThrow(message);
  });

  it.each([
    ["a value", { type: "encrypted", value: "A1" }, "A1"],
    ["a Sensitive variable", { type: "sensitive", value: "ciphertext" }, null],
    ["no value", { type: "encrypted", value: "" }, null],
    ["nothing", null, null],
  ])("reads %s", async (_, answer, value) => {
    const api = fakeApis({ "GET /v1/projects/prj_1/env/env%2F1": answer });

    await expect(vercel().readEnv("env/1")).resolves.toBe(value);
    expect(api.calls()).toEqual(["GET /v1/projects/prj_1/env/env%2F1"]);
  });

  it("saves variables in one request, and nothing in none", async () => {
    const api = fakeApis();
    const variable = {
      key: "K",
      value: "v",
      type: "plain" as const,
      target: ["preview"],
    };

    await vercel().saveEnv([]);
    expect(api.calls()).toEqual([]);

    await vercel().saveEnv([variable, variable]);
    expect(api.body(SAVE)).toEqual([variable, variable]);
  });

  it("names the variables Vercel refused, and never their values", async () => {
    fakeApis({
      [SAVE]: {
        created: [{ key: "A" }],
        failed: [
          {
            error: { code: "ENV_CONFLICT", envVarKey: "B", message: "value v" },
          },
          { error: { key: "C" } },
          {},
        ],
      },
    });

    await expect(
      vercel().saveEnv([{ key: "B", value: "v", type: "plain", target: [] }]),
    ).rejects.toThrow(
      "Vercel didn't save every variable: B (ENV_CONFLICT), C (no reason given), a variable (no reason given)",
    );
  });

  it("leaves Vercel's words out of an error about a request that carries secrets", async () => {
    const answer = status(400, {
      error: { code: "bad_request", message: "Invalid value hunter2-hunter2" },
      failed: [{ error: { code: "BAD", envVarKey: "K" } }],
    });
    fakeApis({
      [SAVE]: answer,
      "GET /v1/projects/prj_1/env/e1": answer,
      [LIST]: answer,
    });
    const variable = {
      key: "K",
      value: "v",
      type: "plain" as const,
      target: [],
    };

    await expect(vercel().saveEnv([variable])).rejects.toThrow(
      /^Vercel answered 400: bad_request: K \(BAD\)$/,
    );
    await expect(vercel().readEnv("e1")).rejects.not.toThrow(/hunter2/);
    // One that doesn't says what Vercel said.
    const error = await rejection(vercel().listEnv());
    expect(error).toBeInstanceOf(VercelError);
    expect(error).toMatchObject({ status: 400, code: "bad_request" });
    expect(error.message).toContain("Invalid value hunter2-hunter2");
  });

  it("says only the status of an error without a body", async () => {
    fakeApis({ [LIST]: status(404, "Not Found") });

    await expect(vercel().listEnv()).rejects.toThrow(/^Vercel answered 404$/);
  });

  it("deletes variables in one request, and counts missing ones as deleted", async () => {
    const api = fakeApis();

    await vercel().deleteEnv([]);
    expect(api.calls()).toEqual([]);

    await vercel().deleteEnv(["e1", "e2"]);
    expect(api.body(DELETE)).toEqual({ ids: ["e1", "e2"] });

    fakeApis({ [DELETE]: status(404) });
    await expect(vercel().deleteEnv(["e1"])).resolves.toBeUndefined();

    // A 404 for the project, not the variables, leaves them there.
    fakeApis({
      [DELETE]: status(404),
      [LIST]: { envs: [stored("K", { id: "e1" })] },
    });
    await expect(vercel().deleteEnv(["e1"])).rejects.toThrow(
      "Vercel answered 404",
    );

    fakeApis({ [DELETE]: status(404), [LIST]: status(404) });
    await expect(vercel().deleteEnv(["e1"])).rejects.toThrow(
      "Vercel answered 404",
    );

    fakeApis({ [DELETE]: status(403) });
    await expect(vercel().deleteEnv(["e1"])).rejects.toThrow(
      "Vercel answered 403",
    );
  });

  it("adds a bypass secret Vercel accepts, and keeps it out of print", async () => {
    const api = fakeApis();

    const value = await vercel().createBypassSecret();

    expect(value).toMatch(/^[a-zA-Z0-9]{32}$/);
    expect(api.body("PATCH /v1/projects/prj_1/protection-bypass")).toEqual({
      generate: { secret: value, note: "Slack previews (@vercel/slack-bolt)" },
    });
    expect(scrub(`secret ${value}`)).toBe("secret [redacted]");
  });

  it("gives up on a list of branches that never ends", async () => {
    let page = 0;
    const api = fakeApis({
      [BRANCHES]: () => ({ branches: [{ branch: `b${page}` }], until: ++page }),
    });

    await expect(vercel().activeBranches()).rejects.toThrow(
      "Vercel's list of active branches has too many pages",
    );
    expect(api.sent).toHaveLength(100);
    expect(api.sent[0]?.url.search).toBe("?active=1&limit=100");
  });

  it("reads a deployment's metadata, and what a redeploy answers", async () => {
    fakeApis({
      "GET /v13/deployments/dpl_1": {},
      "POST /v13/deployments": [{ id: "dpl_2" }, {}],
    });

    await expect(vercel().deploymentMeta("dpl_1")).resolves.toEqual({});
    await expect(vercel().redeploy("dpl_1", {})).resolves.toEqual({
      id: "dpl_2",
      url: "",
    });
    // Without an ID, there's no telling a deployment was started.
    await expect(vercel().redeploy("dpl_1", {})).rejects.toThrow(
      "Vercel's answer doesn't name the new deployment",
    );
  });

  it("sends a change again while Vercel is saving another", async () => {
    const ongoing = {
      error: {
        code: "bad_request",
        message:
          "The environment variable couldn't be created because an ongoing update env update is already happening",
      },
    };
    const api = fakeApis({
      [SAVE]: [status(400, ongoing), status(400, ongoing), { created: [] }],
    });
    const variable = {
      key: "K",
      value: "v",
      type: "plain" as const,
      target: ["preview"],
    };

    await vercel().saveEnv([variable]);
    expect(api.to(SAVE)).toHaveLength(3);

    // Only so many times.
    const busy = fakeApis({ [SAVE]: status(400, ongoing) });
    await expect(vercel().saveEnv([variable])).rejects.toThrow(
      "Vercel answered 400: bad_request",
    );
    expect(busy.to(SAVE)).toHaveLength(4);

    // Never a request that isn't safe to send twice.
    const once = fakeApis({ "POST /v13/deployments": status(400, ongoing) });
    await expect(vercel().redeploy("dpl_1", {})).rejects.toThrow(
      "Vercel answered 400",
    );
    expect(once.sent).toHaveLength(1);
  });

  it("starts a deployment once: a second would be another deployment", async () => {
    const api = fakeApis({ "POST /v13/deployments": status(500) });

    await expect(vercel().redeploy("dpl_1", {})).rejects.toBeInstanceOf(
      Unavailable,
    );
    expect(api.sent).toHaveLength(1);
  });
});
