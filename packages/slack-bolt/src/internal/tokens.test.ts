import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeApis,
  offline,
  recorder,
  refuse,
  status,
  stored,
} from "../testing";
import { logTo } from "./log";
import { forgetSecrets } from "./secrets";
import { createSlack } from "./slack";
import { usableConfigToken } from "./tokens";
import { createVercel } from "./vercel";

vi.mock("./wait", () => ({ wait: () => Promise.resolve() }));

const CONFIG = "SLACK_CONFIGURATION_TOKEN";
const REFRESH = "SLACK_CONFIG_REFRESH_TOKEN";
const LIST = "GET /v10/projects/prj_1/env";
const SAVE = "POST /v10/projects/prj_1/env";
const OWN = "xoxe.xoxp-1-own-token";
const NEWER = "xoxe.xoxp-1-newer-token";
const ROTATED = "xoxe.xoxp-1-rotated-token";
const EXPIRED = refuse("token_expired");

/** The stored token, as Vercel lists it and as it reads back. */
const config = (value: string | null, target = ["production", "preview"]) => ({
  [LIST]: {
    envs: [stored(CONFIG, { type: "encrypted", id: "env_config", target })],
  },
  "GET /v1/projects/prj_1/env/env_config":
    value === null ? { type: "sensitive" } : { type: "encrypted", value },
});

/** Asks for a usable token, in a project that answers from `answers`. */
async function usable(
  answers: Record<string, unknown> = {},
  own: { token?: string; refreshToken?: string; environment?: string } = {
    token: OWN,
    refreshToken: "xoxe-1-own-refresh",
  },
) {
  const api = fakeApis(answers);
  const out = recorder();
  const log = logTo(out.logger);
  const vercel = createVercel({
    token: "vercel-api-token-0001",
    projectId: "prj_1",
    log,
  });
  const envs = await vercel.listEnv();
  const result = usableConfigToken({
    slack: createSlack(log),
    vercel,
    log,
    envs,
    ...own,
  });
  return { api, out, result, calls: () => api.calls().slice(1) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  forgetSecrets();
});

describe("a token Slack accepts", () => {
  it("is used as it is", async () => {
    const { result, calls } = await usable();

    await expect(result).resolves.toBe(OWN);
    expect(calls()).toEqual(["auth.test"]);
  });
});

describe("a token Slack can't be asked about", () => {
  it.each([
    ["Slack can't be reached", offline],
    ["Slack answers a server error", status(503)],
    ["Slack is rate limiting", refuse("ratelimited")],
  ])("isn't rotated when %s", async (_, answer) => {
    const { result, api } = await usable({ "auth.test": answer });

    await expect(result).rejects.toThrow(
      /^Couldn't check SLACK_CONFIGURATION_TOKEN: .+\nRedeploy to try again\.$/,
    );
    expect(api.calls()).not.toContain("tooling.tokens.rotate");
  });
});

describe("a token Slack refuses", () => {
  it("is rotated, and the new pair saved for the next run", async () => {
    const { result, api, out, calls } = await usable({ "auth.test": EXPIRED });

    await expect(result).resolves.toBe(ROTATED);
    expect(calls()).toEqual(["auth.test", "tooling.tokens.rotate", SAVE]);
    expect(api.body("tooling.tokens.rotate")).toEqual({
      refresh_token: "xoxe-1-own-refresh",
    });
    // Nothing stored yet: saved where this package runs.
    expect(api.savedEnv()).toEqual([
      {
        key: CONFIG,
        value: ROTATED,
        type: "encrypted",
        target: ["production", "preview"],
      },
      {
        key: REFRESH,
        value: "xoxe-1-rotated-refresh",
        type: "encrypted",
        target: ["production", "preview"],
      },
    ]);
    expect(out.said()).toEqual([
      "Rotated SLACK_CONFIGURATION_TOKEN and saved it to Vercel",
    ]);
  });

  it("is saved over the stored pair, in its environments, and Sensitive when either is", async () => {
    const { result, api } = await usable({
      "auth.test": EXPIRED,
      [LIST]: {
        envs: [
          stored(CONFIG, {
            type: "encrypted",
            id: "env_config",
            target: ["preview"],
          }),
          stored(REFRESH, {
            id: "env_refresh",
            target: ["preview", "production"],
          }),
          // A branch's own token is someone's override, and stays.
          stored(CONFIG, { branch: "feature/x", id: "env_branch" }),
        ],
      },
      "GET /v1/projects/prj_1/env/env_config": {
        type: "encrypted",
        value: OWN,
      },
      "GET /v1/projects/prj_1/env/env_refresh": { type: "sensitive" },
    });

    await result;

    // A token from a Sensitive pair is never saved readable.
    expect(api.savedEnv()).toEqual([
      { key: CONFIG, value: ROTATED, type: "sensitive", target: ["preview"] },
      {
        key: REFRESH,
        value: "xoxe-1-rotated-refresh",
        type: "sensitive",
        target: ["preview", "production"],
      },
    ]);
  });

  it("gives way to a newer one another build stored", async () => {
    const { result, out, api } = await usable({
      ...config(NEWER),
      "auth.test": [EXPIRED, { ok: true }],
    });

    await expect(result).resolves.toBe(NEWER);
    expect(api.calls()).not.toContain("tooling.tokens.rotate");
    expect(out.said()).toEqual([
      "Using the SLACK_CONFIGURATION_TOKEN another build rotated to",
    ]);
  });

  it("is rotated with the stored refresh token, which is the newest", async () => {
    const { result, api } = await usable({
      "auth.test": EXPIRED,
      [LIST]: {
        envs: [stored(REFRESH, { type: "encrypted", id: "env_refresh" })],
      },
      "GET /v1/projects/prj_1/env/env_refresh": {
        type: "encrypted",
        value: "xoxe-1-stored-refresh",
      },
    });

    await result;

    expect(api.body("tooling.tokens.rotate")).toEqual({
      refresh_token: "xoxe-1-stored-refresh",
    });
  });

  it("can't be rotated without a refresh token", async () => {
    const { result } = await usable({ "auth.test": EXPIRED }, { token: OWN });

    await expect(result).rejects.toThrow(
      "Slack refused SLACK_CONFIGURATION_TOKEN (token_expired)\nConfiguration tokens expire after 12 hours. Generate a new one and save it in Vercel, with its refresh token as SLACK_CONFIG_REFRESH_TOKEN so it's rotated from then on: https://api.slack.com/apps",
    );
  });
});

describe("a stored token that can't be checked", () => {
  it("stops the run when Slack gives no verdict on it, rather than rotate", async () => {
    const { result, api } = await usable({
      ...config(NEWER),
      "auth.test": [EXPIRED, refuse("service_unavailable")],
    });

    await expect(result).rejects.toThrow(
      "Couldn't check the stored SLACK_CONFIGURATION_TOKEN: Slack answered auth.test with service_unavailable\nRedeploy to try again.",
    );
    expect(api.calls()).not.toContain("tooling.tokens.rotate");
  });

  it("stops the run when Vercel can't be asked for it, rather than rotate", async () => {
    const { result, api } = await usable({
      ...config(NEWER),
      "auth.test": EXPIRED,
      "GET /v1/projects/prj_1/env/env_config": offline,
    });

    await expect(result).rejects.toThrow(
      "Couldn't check the stored SLACK_CONFIGURATION_TOKEN: Vercel couldn't be reached\nRedeploy to try again.",
    );
    expect(api.calls()).not.toContain("tooling.tokens.rotate");
  });

  it("is passed over when Slack refuses it", async () => {
    const { result, api } = await usable({
      ...config(NEWER),
      "auth.test": EXPIRED,
    });

    await expect(result).resolves.toBe(ROTATED);
    expect(api.to("tooling.tokens.rotate")).toHaveLength(1);
  });
});

describe("a refresh token Slack refuses", () => {
  it("means another build used it: its token is picked up once it's saved", async () => {
    const stale = config(OWN);
    const { result, api } = await usable({
      ...stale,
      "auth.test": [EXPIRED, { ok: true }],
      "tooling.tokens.rotate": refuse("invalid_refresh_token"),
      // Listed for the run, then twice while the other build is still saving.
      [LIST]: [stale[LIST], stale[LIST], stale[LIST], stale[LIST]],
      "GET /v1/projects/prj_1/env/env_config": [
        { type: "encrypted", value: OWN },
        { type: "encrypted", value: OWN },
        { type: "encrypted", value: OWN },
        { type: "encrypted", value: NEWER },
      ],
    });

    await expect(result).resolves.toBe(NEWER);
    expect(api.to("tooling.tokens.rotate")).toHaveLength(1);
  });

  it("fails the run when no other token turns up", async () => {
    const { result, api } = await usable({
      "auth.test": EXPIRED,
      "tooling.tokens.rotate": refuse("invalid_refresh_token"),
    });

    await expect(result).rejects.toThrow(
      "Slack refused SLACK_CONFIG_REFRESH_TOKEN (invalid_refresh_token), so SLACK_CONFIGURATION_TOKEN can't be rotated\nGenerate both tokens again and save them in Vercel: https://api.slack.com/apps",
    );
    // The run's own list, then five looks.
    expect(api.to(LIST)).toHaveLength(6);
    expect(api.calls()).not.toContain(SAVE);
  });

  it("says to redeploy when the stored tokens are Sensitive, so the new ones can't be read", async () => {
    const hidden = { type: "sensitive" };
    const { result, api } = await usable({
      [LIST]: {
        envs: [
          stored(CONFIG, { target: ["production", "preview"] }),
          stored(REFRESH, { target: ["production", "preview"] }),
        ],
      },
      [`GET /v1/projects/prj_1/env/env_${CONFIG}_all`]: hidden,
      [`GET /v1/projects/prj_1/env/env_${REFRESH}_all`]: hidden,
      "auth.test": EXPIRED,
      "tooling.tokens.rotate": refuse("invalid_refresh_token"),
    });

    await expect(result).rejects.toThrow(
      "Slack refused SLACK_CONFIG_REFRESH_TOKEN (invalid_refresh_token), so SLACK_CONFIGURATION_TOKEN can't be rotated. Another build has probably rotated the tokens since this deployment was created, and Vercel doesn't show Sensitive values, so this one can't read the new ones\nRedeploy to pick them up. If that fails too, generate both tokens again and save them in Vercel: https://api.slack.com/apps",
    );
    // The run's own refresh token, since the stored one can't be read.
    expect(api.body("tooling.tokens.rotate")).toEqual({
      refresh_token: "xoxe-1-own-refresh",
    });
    expect(api.calls()).not.toContain(SAVE);
  });
});

describe("rotating", () => {
  it("is tried once when Slack can't be reached: the refresh token may be spent", async () => {
    const { result, api } = await usable({
      "auth.test": EXPIRED,
      "tooling.tokens.rotate": offline,
    });

    await expect(result).rejects.toThrow(
      /^Couldn't rotate SLACK_CONFIGURATION_TOKEN: Slack couldn't be reached\nRedeploy/,
    );
    expect(api.to("tooling.tokens.rotate")).toHaveLength(1);
  });

  it("says the stored tokens are spent when the new ones can't be saved", async () => {
    const { result } = await usable({
      "auth.test": EXPIRED,
      [SAVE]: status(403, { error: { code: "forbidden", message: "No." } }),
    });

    await expect(result).rejects.toThrow(
      /^Rotated SLACK_CONFIGURATION_TOKEN, but couldn't save the new tokens to Vercel: Vercel answered 403: forbidden\nThe stored tokens no longer work\./,
    );
  });

  it("fails on an answer without tokens", async () => {
    const { result } = await usable({
      "auth.test": EXPIRED,
      "tooling.tokens.rotate": { ok: true },
    });

    await expect(result).rejects.toThrow(
      /^Slack refused SLACK_CONFIG_REFRESH_TOKEN \(no_tokens_in_answer\)/,
    );
  });
});

describe("a run without a token of its own", () => {
  it("uses the one stored in the project", async () => {
    const { result, out } = await usable(config(NEWER), {});

    await expect(result).resolves.toBe(NEWER);
    expect(out.said()).toEqual([]);
  });

  it("rotates with its refresh token when the stored one can't be read", async () => {
    const { result } = await usable(config(null), {
      refreshToken: "xoxe-1-own-refresh",
    });

    await expect(result).resolves.toBe(ROTATED);
  });

  it("says what to set when there's nothing to use", async () => {
    const { result } = await usable({}, {});

    await expect(result).rejects.toThrow(
      /^SLACK_CONFIGURATION_TOKEN is not set\nGenerate a configuration token/,
    );
  });
});

describe("more than one stored token", () => {
  const both = {
    [LIST]: {
      envs: [
        stored(CONFIG, {
          type: "encrypted",
          id: "env_production",
          target: ["production"],
        }),
        stored(CONFIG, {
          type: "encrypted",
          id: "env_preview",
          target: ["preview"],
        }),
      ],
    },
    "GET /v1/projects/prj_1/env/env_production": {
      type: "encrypted",
      value: "xoxe.xoxp-1-production",
    },
    "GET /v1/projects/prj_1/env/env_preview": {
      type: "encrypted",
      value: NEWER,
    },
  };

  it("means the one for previews is looked at first", async () => {
    const { result, calls } = await usable(both, {});

    await expect(result).resolves.toBe(NEWER);
    expect(calls()).toEqual([
      "GET /v1/projects/prj_1/env/env_preview",
      "auth.test",
    ]);
  });

  it("stops a run outside a deployment before rotating, when it can't tell which pair is its own", async () => {
    const { result, api } = await usable({ ...both, "auth.test": EXPIRED });

    await expect(result).rejects.toThrow(
      "The project keeps a SLACK_CONFIGURATION_TOKEN for each of several environments, and this run can't tell which pair its own tokens belong to\nNothing was rotated.",
    );
    expect(api.calls()).not.toContain("tooling.tokens.rotate");
    expect(api.calls()).not.toContain(SAVE);
  });
});

describe("a pair for each environment", () => {
  // Production's pair is Sensitive, Preview's readable.
  const PAIRS = {
    [LIST]: {
      envs: [
        stored(CONFIG, { id: "env_config_prod", target: ["production"] }),
        stored(REFRESH, { id: "env_refresh_prod", target: ["production"] }),
        stored(CONFIG, {
          type: "encrypted",
          id: "env_config_preview",
          target: ["preview"],
        }),
        stored(REFRESH, {
          type: "encrypted",
          id: "env_refresh_preview",
          target: ["preview"],
        }),
      ],
    },
    "GET /v1/projects/prj_1/env/env_config_prod": { type: "sensitive" },
    "GET /v1/projects/prj_1/env/env_refresh_prod": { type: "sensitive" },
    "GET /v1/projects/prj_1/env/env_config_preview": {
      type: "encrypted",
      value: OWN,
    },
    "GET /v1/projects/prj_1/env/env_refresh_preview": {
      type: "encrypted",
      value: "xoxe-1-preview-refresh",
    },
  };
  const reads = (api: { calls: () => string[] }) =>
    api.calls().filter((call) => call.startsWith("GET /v1/"));

  it("keeps a production rotation to Production's variables, Sensitive", async () => {
    const { result, api } = await usable(
      { ...PAIRS, "auth.test": EXPIRED },
      {
        token: "xoxe.xoxp-1-production-token",
        refreshToken: "xoxe-1-production-refresh",
        environment: "production",
      },
    );

    await expect(result).resolves.toBe(ROTATED);
    // Production's own refresh token, never Preview's readable one.
    expect(api.body("tooling.tokens.rotate")).toEqual({
      refresh_token: "xoxe-1-production-refresh",
    });
    expect(reads(api)).toEqual([
      "GET /v1/projects/prj_1/env/env_config_prod",
      "GET /v1/projects/prj_1/env/env_refresh_prod",
    ]);
    expect(api.savedEnv()).toEqual([
      {
        key: CONFIG,
        value: ROTATED,
        type: "sensitive",
        target: ["production"],
      },
      {
        key: REFRESH,
        value: "xoxe-1-rotated-refresh",
        type: "sensitive",
        target: ["production"],
      },
    ]);
  });

  it("keeps a preview rotation to Preview's variables, as they are", async () => {
    const { result, api } = await usable(
      { ...PAIRS, "auth.test": EXPIRED },
      { token: OWN, environment: "preview" },
    );

    await expect(result).resolves.toBe(ROTATED);
    expect(api.body("tooling.tokens.rotate")).toEqual({
      refresh_token: "xoxe-1-preview-refresh",
    });
    expect(reads(api)).not.toContain(
      "GET /v1/projects/prj_1/env/env_config_prod",
    );
    expect(api.savedEnv()).toEqual([
      { key: CONFIG, value: ROTATED, type: "encrypted", target: ["preview"] },
      {
        key: REFRESH,
        value: "xoxe-1-rotated-refresh",
        type: "encrypted",
        target: ["preview"],
      },
    ]);
  });

  it("saves a readable refresh token's pair only where that variable is", async () => {
    // Outside a deployment: the readable variable says which pair it is.
    const { result, api } = await usable(
      { ...PAIRS, "auth.test": EXPIRED },
      { token: "xoxe.xoxp-1-someone-elses" },
    );

    await expect(result).resolves.toBe(ROTATED);
    expect(api.savedEnv().map((env) => env.target)).toEqual([
      ["preview"],
      ["preview"],
    ]);
  });

  it("saves tokens no variable holds as Sensitive, for its environment only", async () => {
    // In a deployment, they may come from a Sensitive shared variable.
    const { result, api } = await usable(
      { "auth.test": EXPIRED },
      {
        token: OWN,
        refreshToken: "xoxe-1-own-refresh",
        environment: "preview",
      },
    );

    await expect(result).resolves.toBe(ROTATED);
    expect(api.savedEnv()).toEqual([
      { key: CONFIG, value: ROTATED, type: "sensitive", target: ["preview"] },
      {
        key: REFRESH,
        value: "xoxe-1-rotated-refresh",
        type: "sensitive",
        target: ["preview"],
      },
    ]);
  });
});

describe("looking for another build's token", () => {
  it("carries on when Vercel can't be listed for a moment", async () => {
    const { result, api } = await usable({
      "auth.test": EXPIRED,
      "tooling.tokens.rotate": refuse("invalid_refresh_token"),
      [LIST]: [{ envs: [] }, status(403), { envs: [] }],
    });

    await expect(result).rejects.toThrow(
      /^Slack refused SLACK_CONFIG_REFRESH_TOKEN/,
    );
    expect(api.to(LIST)).toHaveLength(6);
  });
});
