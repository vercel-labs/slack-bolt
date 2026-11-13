import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetSecrets } from "./internal/secrets";
import { cleanup } from "./preview";
import {
  fakeApis,
  inBuild,
  offline,
  recorder,
  refuse,
  status,
  stored,
} from "./testing";

vi.mock("./internal/wait", () => ({ wait: () => Promise.resolve() }));

const BUILDING = "feature/login";
const LIST = "GET /v10/projects/prj_1/env";
const SAVE = "POST /v10/projects/prj_1/env";
const BRANCHES = "GET /v5/projects/prj_1/branches";
const DELETE = "DELETE /v1/projects/prj_1/env";
const DELETE_APP = "apps.manifest.delete";

/** A branch's app, as the project records it. */
const app = (branch: string, id: string) =>
  stored("SLACK_APP_ID", { branch, value: id, id: `env_app_${id}` });

/** A project with apps for the branch being built, one that's alive and one that's gone. */
const PROJECT = [
  app(BUILDING, "A_BUILDING"),
  app("alive", "A_ALIVE"),
  app("gone", "A_GONE"),
  stored("SLACK_BOT_TOKEN", { branch: "gone", id: "env_bot_gone" }),
  stored("DATABASE_URL", { branch: "gone", id: "env_db_gone" }),
];
const ACTIVE = {
  branches: [{ branch: "main" }, { branch: BUILDING }, { branch: "alive" }],
};

const project = (answers: object = {}, envs: object[] = PROJECT) =>
  fakeApis({ [LIST]: { envs }, [BRANCHES]: ACTIVE, ...answers });

beforeEach(() => inBuild());

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetSecrets();
});

describe("branches that are gone", () => {
  it("lose their app, then their variables, SLACK_APP_ID last", async () => {
    const api = project();
    const out = recorder();

    const result = await cleanup({ logger: out.logger });

    expect(api.calls()).toEqual([
      LIST,
      BRANCHES,
      "auth.test",
      DELETE_APP,
      DELETE,
      DELETE,
    ]);
    expect(api.body(DELETE_APP)).toEqual({ app_id: "A_GONE" });
    // Only what a preview app is saved as: not the branch's DATABASE_URL.
    expect(api.to(DELETE).map((request) => request.body)).toEqual([
      { ids: ["env_bot_gone"] },
      { ids: ["env_app_A_GONE"] },
    ]);
    expect(result).toEqual({
      dryRun: false,
      removed: [{ branch: "gone", appId: "A_GONE" }],
      failed: [],
    });
    expect(out.said()).toEqual(["Removed Slack app A_GONE of gone"]);
  });

  it("are looked for across every page of branches", async () => {
    const api = project({
      [BRANCHES]: [
        { branches: [{ branch: BUILDING }], until: 1700000000000 },
        { branches: [{ branch: "alive" }, { branch: "gone" }] },
      ],
    });

    const result = await cleanup();

    expect(result.removed).toEqual([]);
    expect(
      api.to(BRANCHES).map((request) => request.url.searchParams.get("until")),
    ).toEqual([null, "1700000000000"]);
    expect(api.calls()).not.toContain(DELETE_APP);
  });

  it("aren't looked for when no other branch has a preview app", async () => {
    const api = project({}, [app(BUILDING, "A_BUILDING")]);
    const out = recorder();

    await cleanup({ logger: out.logger });

    expect(api.calls()).toEqual([LIST]);
    expect(out.said()).toEqual(["No preview apps to clean up"]);
  });

  it("are found from a production build, which is of no preview branch", async () => {
    inBuild({
      VERCEL_ENV: "production",
      VERCEL_TARGET_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
    });
    project({
      [BRANCHES]: { branches: [{ branch: "main" }, { branch: "alive" }] },
    });

    const result = await cleanup();

    // The branch whose preview was building in the other tests is gone here.
    expect(result.removed.map((item) => item.branch)).toEqual([
      BUILDING,
      "gone",
    ]);
  });
});

describe("an answer about branches that can't be trusted", () => {
  it.each([
    ["has no list", {}],
    ["has something else for a list", { branches: "main" }],
    ["has a branch without a name", { branches: [{ branch: BUILDING }, {}] }],
    ["lists nothing", { branches: [] }],
    ["lacks the branch being built", { branches: [{ branch: "main" }] }],
    ["repeats a page", { branches: [{ branch: BUILDING }], until: 1 }],
    ["is an error", status(500)],
    ["never comes", offline],
  ])("removes nothing when it %s", async (_, answer) => {
    const api = project({ [BRANCHES]: answer });

    await expect(cleanup()).rejects.toThrow(
      /\nNothing was removed\. To remove one branch's app, name it: vercel-slack cleanup --branch <name>$/,
    );
    expect(api.calls()).not.toContain(DELETE_APP);
    expect(api.calls()).not.toContain(DELETE);
  });
});

describe("named branches", () => {
  it("lose their apps without asking Vercel which branches are active", async () => {
    const api = project();

    const result = await cleanup({ branches: ["alive", "alive", "gone"] });

    expect(api.calls()).not.toContain(BRANCHES);
    expect(result.removed).toEqual([
      { branch: "alive", appId: "A_ALIVE" },
      { branch: "gone", appId: "A_GONE" },
    ]);
  });

  it("lose variables that no app is recorded for", async () => {
    const api = project({}, [
      stored("SLACK_BOT_TOKEN", { branch: "leftover", id: "env_bot" }),
    ]);

    const result = await cleanup({ branches: ["leftover", "nothing"] });

    expect(api.calls()).toEqual([LIST, DELETE]);
    expect(result.removed).toEqual([{ branch: "leftover" }]);
  });

  it("never include the branch being built", async () => {
    const api = project();
    const out = recorder();

    const result = await cleanup({
      branches: [BUILDING, "gone"],
      logger: out.logger,
    });

    expect(api.to(DELETE_APP).map((request) => request.body)).toEqual([
      { app_id: "A_GONE" },
    ]);
    expect(result).toEqual({
      dryRun: false,
      removed: [{ branch: "gone", appId: "A_GONE" }],
      failed: [],
    });
    expect(out.said()).toEqual([
      `  Skipped ${BUILDING}: it's the branch being built`,
      "Removed Slack app A_GONE of gone",
    ]);
  });

  it("can include any branch outside a preview build", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");
    const api = project();

    const result = await cleanup({ branches: [BUILDING] });

    expect(api.body(DELETE_APP)).toEqual({ app_id: "A_BUILDING" });
    expect(result.removed).toEqual([{ branch: BUILDING, appId: "A_BUILDING" }]);
  });

  it("are said to have no app when they don't", async () => {
    project();
    const out = recorder();

    const result = await cleanup({ branches: ["nothing"], logger: out.logger });

    expect(result).toEqual({ dryRun: false, removed: [], failed: [] });
    expect(out.said()).toEqual([
      "  nothing has no preview app",
      "No preview apps to clean up",
    ]);
  });
});

describe("a dry run", () => {
  it("says what would be removed, and changes nothing", async () => {
    // Even an expired token stays as it is.
    const api = project({ "auth.test": refuse("token_expired") });
    const out = recorder();

    const result = await cleanup({ dryRun: true, logger: out.logger });

    expect(api.calls()).toEqual([LIST, BRANCHES]);
    expect(result).toEqual({
      dryRun: true,
      removed: [{ branch: "gone", appId: "A_GONE" }],
      failed: [],
    });
    expect(out.said()).toEqual(["Would remove Slack app A_GONE of gone"]);
  });
});

describe("an app that's already deleted", () => {
  it.each([
    ["Slack says so", { [DELETE_APP]: refuse("app_not_found") }],
    [
      "Slack refuses the delete, and then says so",
      {
        [DELETE_APP]: refuse("no_permission"),
        "apps.manifest.export": refuse("app_not_found"),
      },
    ],
  ])("still has its variables removed when %s", async (_, answers) => {
    const api = project(answers);

    const result = await cleanup();

    expect(api.to(DELETE)).toHaveLength(2);
    expect(result.removed).toEqual([{ branch: "gone", appId: "A_GONE" }]);
  });
});

describe("a branch that can't be cleaned up", () => {
  it("keeps its variables when Slack won't delete its app", async () => {
    const api = project({ [DELETE_APP]: refuse("no_permission") });
    const out = recorder();

    const result = await cleanup({ logger: out.logger });

    expect(api.calls()).not.toContain(DELETE);
    expect(result).toEqual({
      dryRun: false,
      removed: [],
      failed: [
        {
          branch: "gone",
          appId: "A_GONE",
          reason: "Slack answered apps.manifest.delete with no_permission",
        },
      ],
    });
    expect(out.said()).toEqual([
      "! Couldn't remove gone's preview app: Slack answered apps.manifest.delete with no_permission",
      "  Slack will refuse again. Delete the app yourself (https://api.slack.com/apps/A_GONE), or if it isn't yours, delete the branch's SLACK_ variables in Vercel.",
    ]);
  });

  it.each([
    ["Slack can't be reached", offline],
    ["Slack is migrating the workspace", refuse("team_added_to_org")],
    ["Slack refuses the token", refuse("token_revoked")],
    ["Slack answers something else", status(200, "<html></html>")],
  ])("keeps everything for the next run when %s", async (_, answer) => {
    const api = project({ [DELETE_APP]: answer });
    const out = recorder();

    const result = await cleanup({ logger: out.logger });

    expect(api.calls()).not.toContain(DELETE);
    expect(result.failed).toHaveLength(1);
    expect(out.said().at(-1)).toBe(
      "  Kept its app and variables. The next cleanup tries again.",
    );
  });

  it("keeps everything when Vercel won't show the app's ID", async () => {
    const api = project(
      { "GET /v1/projects/prj_1/env/env_hidden": { type: "sensitive" } },
      [stored("SLACK_APP_ID", { branch: "gone", id: "env_hidden" })],
    );
    inBuild({ VERCEL_GIT_COMMIT_REF: "alive" });

    const result = await cleanup();

    expect(api.calls()).not.toContain(DELETE);
    expect(result.failed).toEqual([
      {
        branch: "gone",
        reason: "Vercel doesn't show the value of its SLACK_APP_ID",
      },
    ]);
  });

  it("is reported when its variables can't be deleted, and tried again by the next run", async () => {
    project({ [DELETE]: status(403, { error: { code: "forbidden" } }) });

    const result = await cleanup();

    expect(result.failed).toEqual([
      {
        branch: "gone",
        appId: "A_GONE",
        reason:
          "deleted the app, but not its variables: Vercel answered 403: forbidden",
      },
    ]);
  });

  it("doesn't stop the others", async () => {
    const api = project(
      { [DELETE_APP]: [refuse("no_permission"), { ok: true }] },
      [app("first", "A_1"), app("second", "A_2"), app(BUILDING, "A_B")],
    );

    const result = await cleanup();

    expect(result.failed.map((item) => item.branch)).toEqual(["first"]);
    expect(result.removed.map((item) => item.branch)).toEqual(["second"]);
    expect(api.to(DELETE)).toHaveLength(1);
  });
});

describe("the configuration token", () => {
  it("is rotated when it has expired, and the new one deletes the app", async () => {
    const api = project({ "auth.test": refuse("token_expired") });

    await cleanup();

    expect(api.calls()).toEqual([
      LIST,
      BRANCHES,
      "auth.test",
      "tooling.tokens.rotate",
      SAVE,
      DELETE_APP,
      DELETE,
      DELETE,
    ]);
    expect(api.to(DELETE_APP)[0]?.headers.authorization).toBe(
      "Bearer xoxe.xoxp-1-rotated-token",
    );
  });

  it("is the one stored in the project when the run has none", async () => {
    inBuild({ SLACK_CONFIGURATION_TOKEN: "", SLACK_CONFIG_REFRESH_TOKEN: "" });
    const api = project(
      {
        "GET /v1/projects/prj_1/env/env_config": {
          type: "encrypted",
          value: "xoxe.xoxp-1-stored-token",
        },
      },
      [
        ...PROJECT,
        stored("SLACK_CONFIGURATION_TOKEN", {
          type: "encrypted",
          id: "env_config",
          target: ["production", "preview"],
        }),
      ],
    );

    await cleanup();

    expect(api.to(DELETE_APP)[0]?.headers.authorization).toBe(
      "Bearer xoxe.xoxp-1-stored-token",
    );
  });

  it("stops the cleanup when there's none that works", async () => {
    inBuild({ SLACK_CONFIG_REFRESH_TOKEN: "" });
    const api = project({ "auth.test": refuse("token_expired") });

    await expect(cleanup()).rejects.toThrow(
      /^Slack refused SLACK_CONFIGURATION_TOKEN \(token_expired\)\n/,
    );
    expect(api.calls()).not.toContain(DELETE_APP);
  });
});

describe("what it needs", () => {
  it("is a Vercel token and a project, wherever it runs", async () => {
    inBuild({ VERCEL_API_TOKEN: "" });
    fakeApis();
    await expect(cleanup()).rejects.toThrow(/^VERCEL_API_TOKEN is not set\n/);

    const api = project();
    await cleanup({ vercelToken: "vercel-api-token-0002", projectId: "prj_1" });
    expect(api.sent[0]?.headers.authorization).toBe(
      "Bearer vercel-api-token-0002",
    );
  });
});

describe("a branch whose state can't be read", () => {
  it("is kept when its app's ID can't be read", async () => {
    inBuild({ VERCEL_GIT_COMMIT_REF: "alive" });
    const api = project({ "GET /v1/projects/prj_1/env/env_app": status(500) }, [
      stored("SLACK_APP_ID", {
        branch: "gone",
        type: "encrypted",
        id: "env_app",
      }),
    ]);

    const result = await cleanup();

    expect(result.failed).toEqual([
      {
        branch: "gone",
        reason:
          "couldn't read its SLACK_APP_ID from Vercel: Vercel answered 500",
      },
    ]);
    expect(api.calls()).not.toContain(DELETE);
  });

  it("is kept when Slack won't delete its app and can't say whether it's there", async () => {
    const api = project({
      [DELETE_APP]: refuse("no_permission"),
      "apps.manifest.export": offline,
    });

    const result = await cleanup();

    expect(result.failed).toHaveLength(1);
    expect(api.calls()).not.toContain(DELETE);
  });
});
