// A stand-in for the Slack and Vercel APIs, and for a Vercel build's
// environment, for tests. Not part of the package: no entry point imports it.
import { vi } from "vitest";
import type { Logger } from "./internal/log";

/** A request as a test sees it. */
export interface Sent {
  /** Slack's method, like `apps.manifest.create`, or Vercel's verb and path. */
  call: string;
  url: URL;
  headers: Record<string, string>;
  /** The body, parsed: JSON, or a form's fields. */
  body: unknown;
}

/**
 * How a call is answered: a JSON body with status 200, a `Response`, a
 * function of the request that returns either, or `offline`. A list answers
 * one request each, and its last entry every request after.
 */
export type Answer = unknown | ((request: Sent) => unknown);

/** The network failing, as `fetch` reports it. */
export const offline = Symbol("offline");

/** An answer with a status, and JSON or text under it. */
export const status =
  (code: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: code,
      headers,
    });

/** Slack refusing a call with an error code. */
export const refuse = (error: string, extra: object = {}) => ({
  ok: false,
  error,
  ...extra,
});

const ENV = "/v10/projects/prj_1/env";

/** A variable as Vercel lists it. */
export function stored(
  key: string,
  options: {
    branch?: string;
    value?: string;
    type?: string;
    target?: string[];
    id?: string;
  } = {},
) {
  const type =
    options.type ?? (options.value === undefined ? "sensitive" : "plain");
  return {
    id: options.id ?? `env_${key}_${options.branch ?? "all"}`,
    key,
    type,
    target: options.target ?? ["preview"],
    ...(options.branch && { gitBranch: options.branch }),
    // Vercel lists what isn't plain as ciphertext.
    value: type === "plain" ? options.value : "ciphertext",
  };
}

/** A Slack and a Vercel where everything works, and the project has no variables. */
export const healthy: Record<string, Answer> = {
  "auth.test": { ok: true },
  "apps.manifest.export": { ok: true, manifest: {} },
  "apps.manifest.update": { ok: true, app_id: "A_OLD" },
  "apps.manifest.create": {
    ok: true,
    app_id: "A_NEW",
    credentials: {
      client_id: "111.222",
      client_secret: "client-secret-value",
      verification_token: "verification-token-value",
      signing_secret: "signing-secret-value",
    },
    oauth_authorize_url: "https://slack.com/oauth/v2/authorize?client_id=111",
  },
  "apps.manifest.delete": { ok: true },
  "apps.developerInstall": {
    ok: true,
    api_access_tokens: { bot: "xoxb-bot-token-0001" },
  },
  "tooling.tokens.rotate": {
    ok: true,
    token: "xoxe.xoxp-1-rotated-token",
    refresh_token: "xoxe-1-rotated-refresh",
  },
  [`GET ${ENV}`]: { envs: [] },
  [`POST ${ENV}`]: { created: [], failed: [] },
  "DELETE /v1/projects/prj_1/env": { deleted: 1, ids: [] },
  "PATCH /v1/projects/prj_1/protection-bypass": {},
  "GET /v5/projects/prj_1/branches": { branches: [] },
  "GET /v13/deployments/dpl_1": { id: "dpl_1", meta: {} },
  "POST /v13/deployments": { id: "dpl_2", url: "new-deployment.vercel.app" },
  "PATCH /v12/deployments/dpl_1/cancel": {},
};

/**
 * Replaces `fetch` with a Slack and a Vercel that answer from `answers`, on
 * top of `healthy`. A call without an answer fails the test.
 */
export function fakeApis(answers: Record<string, Answer | Answer[]> = {}) {
  const all: Record<string, Answer | Answer[]> = { ...healthy, ...answers };
  const sent: Sent[] = [];

  const fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const raw = init.body == null ? undefined : String(init.body);
    let body: unknown;
    if (raw !== undefined) {
      body = headers["content-type"]?.startsWith("application/json")
        ? JSON.parse(raw)
        : Object.fromEntries(new URLSearchParams(raw));
    }
    const call =
      url.hostname === "slack.com"
        ? url.pathname.replace("/api/", "")
        : `${method} ${url.pathname}`;
    const request: Sent = { call, url, headers, body };
    sent.push(request);

    if (!(call in all)) throw new Error(`The test has no answer for ${call}`);
    let answer = all[call];
    if (Array.isArray(answer)) {
      answer = answer.length > 1 ? answer.shift() : answer[0];
    }
    if (typeof answer === "function") answer = answer(request);
    if (answer === offline) throw new TypeError("fetch failed");
    return answer instanceof Response
      ? answer
      : new Response(JSON.stringify(answer), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);

  return {
    fetch,
    /** Every request, in order. */
    sent,
    /** The calls made, in order, like `["auth.test", "POST /v13/deployments"]`. */
    calls: () => sent.map((request) => request.call),
    /** The requests to one call. */
    to: (call: string) => sent.filter((request) => request.call === call),
    /** The body of the only request to a call. */
    body<T = Record<string, unknown>>(call: string): T {
      const requests = sent.filter((request) => request.call === call);
      if (requests.length !== 1) {
        throw new Error(`${requests.length} requests were sent to ${call}`);
      }
      return requests[0]?.body as T;
    },
    /** The variables saved to Vercel, across every request. */
    savedEnv: () =>
      sent
        .filter((request) => request.call === `POST ${ENV}`)
        .flatMap((request) => request.body as Record<string, unknown>[]),
  };
}

/** What a Vercel build of a branch's preview has in its environment. */
export const BUILD: Record<string, string> = {
  VERCEL_ENV: "preview",
  VERCEL_TARGET_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "feature/login",
  VERCEL_GIT_COMMIT_SHA: "a1b2c3d4e5f60718",
  VERCEL_GIT_COMMIT_MESSAGE: "Add login",
  VERCEL_GIT_COMMIT_AUTHOR_LOGIN: "octocat",
  VERCEL_BRANCH_URL: "app-git-feature-login-acme.vercel.app",
  VERCEL_URL: "app-9x8y7z-acme.vercel.app",
  VERCEL_PROJECT_ID: "prj_1",
  VERCEL_TEAM_ID: "team_1",
  VERCEL_DEPLOYMENT_ID: "dpl_1",
  VERCEL_AUTOMATION_BYPASS_SECRET: "bypass0000000000000000000000001",
  VERCEL_API_TOKEN: "vercel-api-token-0001",
  SLACK_CONFIGURATION_TOKEN: "xoxe.xoxp-1-config-token",
  SLACK_CONFIG_REFRESH_TOKEN: "xoxe-1-refresh-token",
  SLACK_SERVICE_TOKEN: "xoxp-service-token-0001",
};

/** Variables a build can have that these tests start without. */
const UNSET = [
  "VERCEL_ORG_ID",
  "MANIFEST_PATH",
  "NO_COLOR",
  "VERCEL_SLACK_DEBUG",
  "SLACK_APP_ID",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_LEVEL_TOKEN",
  "SLACK_USER_TOKEN",
];

/**
 * Sets the environment to a preview build's, with `overrides` on top. An
 * empty string unsets a variable, as far as this package can tell.
 */
export function inBuild(overrides: Record<string, string> = {}): void {
  for (const name of UNSET) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries({ ...BUILD, ...overrides })) {
    vi.stubEnv(name, value);
  }
}

/** A logger that keeps what it's told: warnings start with `!`, debug lines with `?`. */
export function recorder() {
  const lines: string[] = [];
  const logger: Logger = {
    info: (message) => lines.push(message),
    warn: (message) => lines.push(`! ${message}`),
    debug: (message) => lines.push(`? ${message}`),
  };
  return {
    logger,
    lines,
    /** Everything but debug lines. */
    said: () => lines.filter((line) => !line.startsWith("?")),
    text: () => lines.join("\n"),
  };
}

/** The escape codes a terminal reads as colors. */
const COLORS = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g");

/** Everything printed to the console, with colors taken out. */
export function captureOutput() {
  const lines: string[] = [];
  for (const method of ["log", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" ").replace(COLORS, ""));
    });
  }
  return { lines, text: () => lines.join("\n") };
}

/** A manifest with every URL this package rewrites. */
export const MANIFEST = {
  display_information: { name: "Acme" },
  features: {
    bot_user: { display_name: "Acme Bot" },
    slash_commands: [{ command: "/acme", url: "https://acme.com/api/slack" }],
  },
  oauth_config: {
    redirect_urls: ["https://acme.com/api/slack/oauth"],
    scopes: { bot: ["chat:write", "commands"] },
  },
  settings: {
    event_subscriptions: { request_url: "https://acme.com/api/slack" },
    interactivity: {
      is_enabled: true,
      request_url: "https://acme.com/api/slack",
    },
  },
};

/** The error a promise rejects with. Fails the test when it resolves. */
export const rejection = (promise: Promise<unknown>): Promise<Error> =>
  promise.then(
    () => {
      throw new Error("Expected a rejection");
    },
    (error: Error) => error,
  );
