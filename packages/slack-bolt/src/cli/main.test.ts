import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetSecrets } from "../internal/secrets";
import {
  BUILD,
  captureOutput,
  fakeApis,
  inBuild,
  MANIFEST,
  refuse,
  status,
  stored,
} from "../testing";
import { main } from "./main";

vi.mock("../internal/wait", () => ({ wait: () => Promise.resolve() }));

const LIST = "GET /v10/projects/prj_1/env";
const SAVE = "POST /v10/projects/prj_1/env";
const BRANCHES = "GET /v5/projects/prj_1/branches";
const GONE = stored("SLACK_APP_ID", {
  branch: "gone",
  value: "A_GONE",
  id: "env_gone",
});
const ACTIVE = { branches: [{ branch: "main" }, { branch: "feature/login" }] };

const run = (...argv: string[]) => main(argv, "9.9.9");

let dir: string;
let output: ReturnType<typeof captureOutput>;
/** What commander prints: help, the version, and mistakes in the arguments. */
let usage: string[];

beforeEach(() => {
  inBuild();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vercel-slack-cli-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(MANIFEST));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  output = captureOutput();
  usage = [];
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, "write").mockImplementation((chunk) => {
      usage.push(String(chunk));
      return true;
    });
  }
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetSecrets();
});

describe("vercel-slack build", () => {
  it("sets up the branch's app, says what it did, and exits with 0", async () => {
    inBuild({ SLACK_SERVICE_TOKEN: "" });
    fakeApis();

    expect(await run("build")).toBe(0);
    expect(output.lines).toEqual([
      "▲ vercel-slack 9.9.9",
      "✓ Created Slack app A_NEW (Acme (feature-login))",
      "⚠ The app isn't installed: SLACK_SERVICE_TOKEN is not set",
      "  Install it: https://slack.com/oauth/v2/authorize?client_id=111",
      "  To have builds install it, add a service token: https://docs.slack.dev/authentication/tokens/#service",
      "✓ Saved SLACK_APP_ID, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET for feature/login",
      "✓ Started a deployment that has SLACK_APP_ID, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET: https://new-deployment.vercel.app",
      "  Canceled this deployment, which the new one replaces.",
    ]);
  });

  it("exits with 1 when the app can't be set up, saying why and what to do", async () => {
    fakeApis({
      "apps.manifest.create": refuse("invalid_manifest", {
        errors: [{ message: "Bad URL", pointer: "/settings" }],
      }),
    });

    expect(await run("build")).toBe(1);
    expect(output.lines.slice(1)).toEqual([
      "✗ Slack rejected manifest.json",
      "  - /settings: Bad URL",
      "  Fix the manifest, then redeploy.",
    ]);
  });

  it("exits with 0 on the same failure with --allow-failure", async () => {
    fakeApis({ [LIST]: status(403) });

    expect(await run("build", "--allow-failure")).toBe(0);
    expect(output.lines.slice(1)).toEqual([
      "✗ VERCEL_API_TOKEN can't read this project's environment variables",
      expect.stringMatching(/^ {2}Check that it's valid/),
      "  Carrying on without it: --allow-failure is set.",
    ]);
  });

  it("does nothing and exits with 0 outside a preview deployment", async () => {
    inBuild({
      VERCEL_ENV: "production",
      VERCEL_TARGET_ENV: "production",
      VERCEL_API_TOKEN: "",
    });
    const api = fakeApis();

    expect(await run("build")).toBe(0);
    expect(output.lines).toEqual([
      "▲ vercel-slack 9.9.9",
      "  Not a preview deployment (production), so there's no preview app to set up",
    ]);
    expect(api.calls()).toEqual([]);
  });

  it("reads the manifest --manifest names", async () => {
    fs.writeFileSync(
      path.join(dir, "other.yaml"),
      "display_information:\n  name: Other\n",
    );
    fakeApis();

    expect(await run("build", "--manifest", "other.yaml")).toBe(0);
    expect(output.lines[1]).toBe(
      "✓ Created Slack app A_NEW (Other (feature-login))",
    );
  });

  it("saves secrets readable with --no-sensitive", async () => {
    const api = fakeApis();

    await run("build", "--no-sensitive");

    expect(new Set(api.savedEnv().map((env) => env.type))).toEqual(
      new Set(["plain", "encrypted"]),
    );
  });

  it("with --debug, prints each request and what caused a failure, and no secret", async () => {
    fakeApis({ [SAVE]: status(403, { error: { code: "forbidden" } }) });

    expect(await run("build", "--debug")).toBe(1);
    expect(output.lines).toContain("  → auth.test");
    expect(output.lines).toContain("  → apps.manifest.create");
    expect(output.lines).toContain(
      "  → POST https://api.vercel.com/v10/projects/prj_1/env?teamId=team_1&upsert=true",
    );
    expect(output.lines.at(-1)).toBe(
      "  Caused by: Vercel answered 403: forbidden",
    );
    for (const value of [
      ...Object.values(BUILD).filter((value) => value.length > 20),
      "client-secret-value",
      "signing-secret-value",
    ]) {
      if (value.includes("vercel.app")) continue;
      expect(output.text()).not.toContain(value);
    }
  });
});

describe("VERCEL_SLACK_DEBUG", () => {
  it.each(["1", "true"])(
    "set to %s turns debug output on without the flag",
    async (value) => {
      inBuild({ VERCEL_SLACK_DEBUG: value });
      fakeApis({ [LIST]: { envs: [] } });

      await run("cleanup");

      expect(output.lines).toContain(
        "  → GET https://api.vercel.com/v10/projects/prj_1/env?teamId=team_1",
      );
    },
  );

  it("set to anything else doesn't", async () => {
    inBuild({ VERCEL_SLACK_DEBUG: "0" });
    fakeApis({ [LIST]: { envs: [] } });

    await run("cleanup");

    expect(output.lines).toEqual([
      "▲ vercel-slack 9.9.9",
      "✓ No preview apps to clean up",
    ]);
  });
});

describe("vercel-slack build --cleanup", () => {
  it("cleans up first, then sets up the branch's app", async () => {
    const api = fakeApis({ [LIST]: { envs: [GONE] }, [BRANCHES]: ACTIVE });

    expect(await run("build", "--cleanup")).toBe(0);
    expect(api.calls().slice(0, 7)).toEqual([
      LIST,
      BRANCHES,
      "auth.test",
      "apps.manifest.delete",
      "DELETE /v1/projects/prj_1/env",
      LIST,
      "auth.test",
    ]);
    expect(output.lines.slice(1, 3)).toEqual([
      "✓ Removed Slack app A_GONE of gone",
      "✓ Created Slack app A_NEW (Acme (feature-login))",
    ]);
  });

  it("goes on with the build when cleanup can't run", async () => {
    fakeApis({ [LIST]: { envs: [GONE] }, [BRANCHES]: {} });

    expect(await run("build", "--cleanup")).toBe(0);
    expect(output.lines.slice(1, 4)).toEqual([
      "⚠ Skipped cleanup: Couldn't tell which branches are still active: Vercel's list of active branches has no branches",
      "  Nothing was removed. To remove one branch's app, name it: vercel-slack cleanup --branch <name>",
      "✓ Created Slack app A_NEW (Acme (feature-login))",
    ]);
  });

  it("cleans up in a production build, where there's no app to set up", async () => {
    inBuild({
      VERCEL_ENV: "production",
      VERCEL_TARGET_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "main",
    });
    fakeApis({
      [LIST]: { envs: [GONE] },
      [BRANCHES]: { branches: [{ branch: "main" }] },
    });

    expect(await run("build", "--cleanup")).toBe(0);
    expect(output.lines.slice(1)).toEqual([
      "✓ Removed Slack app A_GONE of gone",
      "  Not a preview deployment (production), so there's no preview app to set up",
    ]);
  });
});

describe("vercel-slack cleanup", () => {
  it("removes the apps of branches that are gone, and exits with 0", async () => {
    fakeApis({ [LIST]: { envs: [GONE] }, [BRANCHES]: ACTIVE });

    expect(await run("cleanup")).toBe(0);
    expect(output.lines).toEqual([
      "▲ vercel-slack 9.9.9",
      "✓ Removed Slack app A_GONE of gone",
    ]);
  });

  it("exits with 1 when a branch is left with something", async () => {
    fakeApis({
      [LIST]: { envs: [GONE] },
      [BRANCHES]: ACTIVE,
      "apps.manifest.delete": refuse("token_revoked"),
    });

    expect(await run("cleanup")).toBe(1);
    expect(output.lines.slice(1)).toEqual([
      "⚠ Couldn't remove gone's preview app: Slack answered apps.manifest.delete with token_revoked",
      "  Kept its app and variables. The next cleanup tries again.",
    ]);
  });

  it("exits with 1 when it can't tell which branches are gone", async () => {
    fakeApis({ [LIST]: { envs: [GONE] }, [BRANCHES]: { branches: [] } });

    expect(await run("cleanup")).toBe(1);
    expect(output.lines.slice(1)).toEqual([
      "✗ Vercel lists no active branches",
      "  Nothing was removed. To remove one branch's app, name it: vercel-slack cleanup --branch <name>",
    ]);
  });

  it("removes the apps of the branches --branch names, without asking which are gone", async () => {
    const api = fakeApis({
      [LIST]: {
        envs: [
          GONE,
          stored("SLACK_APP_ID", { branch: "also", value: "A_ALSO" }),
        ],
      },
    });

    expect(await run("cleanup", "--branch", "gone", "also")).toBe(0);
    expect(api.calls()).not.toContain(BRANCHES);
    expect(output.lines.slice(1)).toEqual([
      "✓ Removed Slack app A_GONE of gone",
      "✓ Removed Slack app A_ALSO of also",
    ]);
  });

  it("removes nothing with --dry-run", async () => {
    const api = fakeApis({ [LIST]: { envs: [GONE] }, [BRANCHES]: ACTIVE });

    expect(await run("cleanup", "--dry-run")).toBe(0);
    expect(api.calls()).toEqual([LIST, BRANCHES]);
    expect(output.lines.slice(1)).toEqual([
      "✓ Would remove Slack app A_GONE of gone",
    ]);
  });
});

describe("the command line", () => {
  it.each([
    ["no command", []],
    ["a command it doesn't have", ["deploy"]],
    ["an option it doesn't have", ["build", "--strict"]],
    ["an option without its value", ["build", "--manifest"]],
  ])("exits with 1 for %s, and does nothing", async (_, argv) => {
    const api = fakeApis();

    expect(await run(...argv)).toBe(1);
    expect(api.calls()).toEqual([]);
    expect(usage.join("")).not.toBe("");
  });

  it.each([
    ["--help", ["--help"], /Usage: vercel-slack \[options\] \[command\]/],
    ["a command's --help", ["build", "--help"], /--allow-failure/],
    ["--version", ["--version"], /^9\.9\.9\n$/],
  ])("exits with 0 for %s", async (_, argv, printed) => {
    expect(await run(...argv)).toBe(0);
    expect(usage.join("")).toMatch(printed);
  });

  it("prints without colors when NO_COLOR is set", async () => {
    vi.restoreAllMocks();
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    fakeApis({ [LIST]: { envs: [] } });

    await run("cleanup");
    expect(log.mock.calls[0]?.[0]).toBe(
      "\u001b[1m▲ vercel-slack 9.9.9\u001b[0m",
    );

    log.mockClear();
    vi.stubEnv("NO_COLOR", "1");
    await run("cleanup");
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "▲ vercel-slack 9.9.9",
      "✓ No preview apps to clean up",
    ]);
  });
});
