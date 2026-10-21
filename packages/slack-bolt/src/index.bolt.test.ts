// Smoke tests against the real Bolt App and HTTPReceiver, with no Slack
// network calls. They check the Bolt behaviour index.test.ts stubs out:
// App's constructor calls receiver.init(app), HTTPReceiver calls processEvent
// on the app it was given with `this` intact, and HTTPReceiver keeps its
// logger in the `logger` field we log through, and Bolt's OAuth installer runs
// on fetch's Node request and response. Requests go through fetch both
// as plain Requests and from srvx's own Node server, which hands fetch the
// real Node request.
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  App,
  AppInitializationError,
  type AppOptions,
  type Installation,
  type InstallationStore,
} from "@slack/bolt";
import { waitUntil } from "@vercel/functions";
import { toNodeHandler } from "srvx/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelReceiver, type VercelReceiverOptions } from "./index";

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

const SECRET = "test-signing-secret";
const BODY_USED =
  "Request body already read. Bolt needs the raw body to verify Slack's signature, so clone the request before you read it, read the original and pass the clone to fetch.";
const authorize = async () => ({
  botToken: "xoxb-test",
  botId: "B1",
  botUserId: "U1",
});
const mention = {
  type: "app_mention",
  user: "U2",
  text: "<@U1> hi",
  channel: "C1",
  ts: "1.1",
  event_ts: "1.1",
};

const INIT_FAILED =
  "app.init() failed, so this event wasn't processed. It runs again on the next event.";

/** The servers a test started, closed after it. */
const servers: Server[] = [];
/** The real Node request URL after each response, as the server sees it. */
const urlsAfter: (string | undefined)[] = [];

beforeEach(() => {
  vi.mocked(waitUntil).mockClear();
  urlsAfter.length = 0;
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.close();
      return once(server, "close");
    }),
  );
});

/** Starts `server` on a free local port, and resolves with the port. */
async function listen(server: Server): Promise<number> {
  servers.push(server.listen(0, "127.0.0.1"));
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/** A Bolt logger that records its calls. */
const createLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  getLevel: vi.fn(),
  setName: vi.fn(),
});

/**
 * A fake Slack Web API, which answers the OAuth callback's oauth.v2.access
 * and answers anything else, like auth.test, with `answer`. Resolves with its
 * URL.
 */
async function fakeSlackApi(
  answer: () => object = () => ({ ok: true, bot_id: "B1", user_id: "U1" }),
) {
  const port = await listen(
    createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/oauth.v2.access")) {
        res.end(
          JSON.stringify({
            ok: true,
            app_id: "A1",
            authed_user: { id: "U9" },
            scope: "chat:write",
            token_type: "bot",
            access_token: "xoxb-installed",
            bot_user_id: "U1",
            team: { id: "T1", name: "Team" },
            enterprise: null,
            is_enterprise_install: false,
          }),
        );
        return;
      }
      res.end(JSON.stringify(answer()));
    }),
  );
  return `http://127.0.0.1:${port}/`;
}

/** A real App on a VercelReceiver, authorized without calling Slack. */
function createApp(
  options: Partial<AppOptions> = {},
  receiverOptions: VercelReceiverOptions = {},
) {
  const receiver = new VercelReceiver({
    signingSecret: SECRET,
    ...receiverOptions,
  });
  const app = new App({ receiver, authorize, ...options });
  return { receiver, app };
}

/** A Slack-signed POST to `url`. */
function signedRequest(url: string, body: string, contentType: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${signature}`,
    },
    body,
  });
}

const eventBody = (event: object) =>
  JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "Ev1",
    event_time: 1,
    event,
  });

/** Serves fetch from srvx's Node server, then sends `request` to it. */
async function viaNodeServer(receiver: VercelReceiver, request: Request) {
  const handler = toNodeHandler(receiver.fetch) as RequestListener;
  const port = await listen(
    createServer((req, res) => {
      res.once("finish", () => urlsAfter.push(req.url));
      void handler(req, res);
    }),
  );
  const { pathname, search } = new URL(request.url);
  return fetch(
    new Request(`http://127.0.0.1:${port}${pathname}${search}`, request),
  );
}

/**
 * Like viaNodeServer, but the route is `route`, which gets srvx's Node-backed
 * Request, the way Express's toNodeHandler and Nitro hand one over.
 */
async function viaNodeRoute(
  route: (request: Request) => Promise<Response>,
  request: Request,
) {
  const handler = toNodeHandler(route) as RequestListener;
  const port = await listen(createServer((req, res) => void handler(req, res)));
  const { pathname, search } = new URL(request.url);
  // A string body, so the client doesn't fail when the route answers before
  // reading it all.
  return fetch(`http://127.0.0.1:${port}${pathname}${search}`, {
    method: request.method,
    headers: request.headers,
    body: await request.text(),
  });
}

/** POSTs a signed Events API payload to /webhooks/slack on srvx's Node server. */
function postEvent(receiver: VercelReceiver, event: object) {
  return viaNodeServer(
    receiver,
    signedRequest(
      "https://example.com/webhooks/slack",
      eventBody(event),
      "application/json",
    ),
  );
}

it("acks a real App's event and keeps its listener alive with waitUntil", async () => {
  const { receiver, app } = createApp();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tokens: unknown[] = [];
  app.event("app_mention", async ({ context }) => {
    await released;
    tokens.push(context.botToken);
  });

  const response = await postEvent(receiver, mention);

  // Slack is acknowledged while the listener is still waiting.
  expect(response.status).toBe(200);
  expect(waitUntil).toHaveBeenCalledOnce();
  expect(tokens).toEqual([]);

  // The promise kept alive settles only once the listener has finished.
  release();
  await vi.mocked(waitUntil).mock.calls[0][0];
  expect(tokens).toEqual(["xoxb-test"]);
});

it("initializes an App created with deferInitialization on its first event", async () => {
  const { receiver, app } = createApp({ deferInitialization: true });
  const tokens: unknown[] = [];
  app.event("app_mention", async ({ context }) => {
    tokens.push(context.botToken);
  });

  const response = await postEvent(receiver, mention);

  expect(response.status).toBe(200);
  await vi.mocked(waitUntil).mock.calls[0][0];
  expect(tokens).toEqual(["xoxb-test"]);
});

it("logs why a deferred App couldn't initialize", async () => {
  const logger = createLogger();
  // No token and no authorize, so Bolt's app.init() throws.
  const { receiver } = createApp(
    { deferInitialization: true, authorize: undefined },
    { logger },
  );

  const response = await postEvent(receiver, mention);

  expect(response.status).toBe(500);
  expect(logger.error).toHaveBeenCalledWith(
    INIT_FAILED,
    expect.any(AppInitializationError),
  );
});

// The receiver retries only because Bolt's app.init() sets `initialized` back
// to false when it fails.
it("initializes a deferred App on the next event after auth.test fails", async () => {
  let authTests = 0;
  const slackApiUrl = await fakeSlackApi(() =>
    ++authTests === 1
      ? { ok: false, error: "invalid_auth" }
      : { ok: true, bot_id: "B1", user_id: "U1" },
  );
  const logger = createLogger();
  const { receiver, app } = createApp(
    {
      token: "xoxb-token",
      authorize: undefined,
      deferInitialization: true,
      clientOptions: { slackApiUrl, retryConfig: { retries: 0 } },
    },
    { logger },
  );
  const tokens: unknown[] = [];
  app.event("app_mention", async ({ context }) => {
    tokens.push(context.botToken);
  });

  const failed = await postEvent(receiver, mention);
  const response = await postEvent(receiver, mention);

  expect(failed.status).toBe(500);
  expect(logger.error).toHaveBeenCalledWith(INIT_FAILED, expect.any(Error));
  expect(response.status).toBe(200);
  await vi.mocked(waitUntil).mock.calls[1][0];
  expect(tokens).toEqual(["xoxb-token"]);
});

it("answers Slack's URL verification through fetch at any path", async () => {
  const { receiver } = createApp();
  const body = JSON.stringify({ type: "url_verification", challenge: "c1" });

  const response = await receiver.fetch(
    signedRequest("https://example.com/api/slack", body, "application/json"),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ challenge: "c1" });
});

describe("customPropertiesExtractor", () => {
  /** What the extractor saw, and returns a tenant from the query and a header. */
  function recordingExtractor() {
    const seen: { url?: string; headers?: object; rawBody?: unknown }[] = [];
    const customPropertiesExtractor = (
      req: Parameters<
        NonNullable<VercelReceiverOptions["customPropertiesExtractor"]>
      >[0],
    ) => {
      seen.push({ url: req.url, headers: req.headers, rawBody: req.rawBody });
      return {
        tenant: new URL(req.url ?? "/", "http://localhost").searchParams.get(
          "tenant",
        ),
        region: req.headers["x-region"],
      };
    };
    return { seen, customPropertiesExtractor };
  }

  /** Adds the custom and retry headers a test request carries. */
  function withHeaders(request: Request) {
    request.headers.set("X-Region", "iad1");
    request.headers.set("X-Slack-Retry-Num", "2");
    request.headers.set("X-Slack-Retry-Reason", "http_timeout");
    return request;
  }

  it("gets the path and query, lowercase headers and the raw JSON body of an event", async () => {
    const { seen, customPropertiesExtractor } = recordingExtractor();
    const { receiver, app } = createApp({}, { customPropertiesExtractor });
    const contexts: Record<string, unknown>[] = [];
    app.event("app_mention", async ({ context }) => {
      contexts.push(context);
    });
    const body = eventBody(mention);

    const response = await receiver.fetch(
      withHeaders(
        signedRequest(
          "https://example.com/api/slack?tenant=acme",
          body,
          "application/json",
        ),
      ),
    );

    expect(response.status).toBe(200);
    // The path the route was called on, not an absolute URL.
    expect(seen[0].url).toBe("/api/slack?tenant=acme");
    expect(seen[0].headers).toMatchObject({
      "x-region": "iad1",
      "x-slack-retry-num": "2",
    });
    expect(Buffer.isBuffer(seen[0].rawBody)).toBe(true);
    expect(String(seen[0].rawBody)).toBe(body);
    await vi.mocked(waitUntil).mock.calls[0][0];
    expect(contexts[0]).toMatchObject({
      tenant: "acme",
      region: "iad1",
      retryNum: 2,
      retryReason: "http_timeout",
    });
  });

  it("gets a slash command's raw form-encoded body", async () => {
    const { seen, customPropertiesExtractor } = recordingExtractor();
    const { receiver, app } = createApp({}, { customPropertiesExtractor });
    let tenant: unknown;
    app.command("/hello", async ({ ack, context }) => {
      tenant = context.tenant;
      await ack();
    });
    const body = new URLSearchParams({
      command: "/hello",
      text: "",
      user_id: "U2",
      team_id: "T1",
      channel_id: "C1",
      trigger_id: "t1",
      response_url: "https://example.com/response",
    }).toString();

    const response = await receiver.fetch(
      withHeaders(
        signedRequest(
          "https://example.com/api/slack?tenant=acme",
          body,
          "application/x-www-form-urlencoded",
        ),
      ),
    );

    expect(response.status).toBe(200);
    expect(new URLSearchParams(String(seen[0].rawBody)).get("command")).toBe(
      "/hello",
    );
    expect(tenant).toBe("acme");
  });

  // Bolt calls it outside any try, so a throw would be an unhandled
  // rejection, which crashes srvx's Node server.
  it("answers 500 without running listeners when it throws", async () => {
    const logger = createLogger();
    const error = new Error("no tenant");
    const { receiver, app } = createApp(
      {},
      {
        logger,
        customPropertiesExtractor: () => {
          throw error;
        },
        unhandledRequestTimeoutMillis: 10,
      },
    );
    const listener = vi.fn();
    app.event("app_mention", listener);

    const response = await postEvent(receiver, mention);

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("");
    expect(listener).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "customPropertiesExtractor threw, so this event wasn't processed.",
      error,
    );
    expect(logger.error).toHaveBeenCalledWith(
      "An unhandled error occurred while Bolt processed an event",
    );
    // Bolt's timer for an unacknowledged event still fires, and leaves the
    // finished response alone.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("not acknowledged within 3 seconds"),
    );
  });

  it("hands what it threw to processEventErrorHandler", async () => {
    const error = new Error("no tenant");
    const processEventErrorHandler = vi.fn<
      NonNullable<VercelReceiverOptions["processEventErrorHandler"]>
    >(async ({ response }) => {
      response.writeHead(503).end();
      return true;
    });
    const { receiver } = createApp(
      {},
      {
        logger: createLogger(),
        customPropertiesExtractor: () => {
          throw error;
        },
        processEventErrorHandler,
      },
    );

    const response = await receiver.fetch(
      signedRequest(
        "https://example.com/api/slack",
        eventBody(mention),
        "application/json",
      ),
    );

    expect(response.status).toBe(503);
    expect(processEventErrorHandler).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ error }),
    );
  });
});

it("acks a slash command through fetch before its listener finishes", async () => {
  const { receiver, app } = createApp();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  app.command("/hello", async ({ ack }) => {
    await ack("hi");
    await released;
    finished = true;
  });
  const body = new URLSearchParams({
    command: "/hello",
    text: "",
    user_id: "U2",
    team_id: "T1",
    channel_id: "C1",
    trigger_id: "t1",
    response_url: "https://example.com/response",
  }).toString();

  const response = await receiver.fetch(
    signedRequest(
      "https://example.com/api/slack",
      body,
      "application/x-www-form-urlencoded",
    ),
  );

  await expect(response.text()).resolves.toBe("hi");
  expect(finished).toBe(false);
  release();
  await vi.mocked(waitUntil).mock.calls[0][0];
  expect(finished).toBe(true);
});

it("rejects a bad signature through fetch", async () => {
  const logger = createLogger();
  const { receiver } = createApp({}, { logger });
  const request = signedRequest(
    "https://example.com/api/slack",
    eventBody(mention),
    "application/json",
  );
  request.headers.set("x-slack-signature", "v0=bad");

  const response = await receiver.fetch(request);

  expect(response.status).toBe(401);
  expect(waitUntil).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalled();
});

it("responds 404 to GET through fetch when OAuth is off", async () => {
  const { receiver } = createApp();

  const response = await receiver.fetch(
    new Request("https://example.com/api/slack"),
  );

  expect(response.status).toBe(404);
});

it("leaves the real Node request's URL as it was on srvx's Node server", async () => {
  const { receiver } = createApp();

  const response = await postEvent(receiver, mention);
  const notFound = await viaNodeServer(
    receiver,
    new Request("https://example.com/webhooks/slack?a=1"),
  );

  expect(response.status).toBe(200);
  expect(notFound.status).toBe(404);
  expect(urlsAfter).toEqual(["/webhooks/slack", "/webhooks/slack?a=1"]);
});

// srvx's Request.body getter starts reading the Node stream Bolt reads, which
// stalls a body bigger than that stream's buffer.
it("leaves a large body on srvx's Node server for Bolt to read", async () => {
  const { receiver } = createApp();

  const response = await postEvent(receiver, {
    ...mention,
    text: "x".repeat(100_000),
  });

  expect(response.status).toBe(200);
});

// srvx's Node server rejects instead of answering. Bolt only throws to defer
// a request, which the receiver answers, so it takes the receiver's own error
// handling failing, like a logger that throws.
it("answers 500 on srvx's Node server when handling an error fails", async () => {
  const logger = createLogger();
  const failure = new Error("log transport failed");
  logger.error.mockImplementationOnce(() => {
    throw failure;
  });
  const { receiver } = createApp({}, { logger });
  Object.assign(receiver, {
    requestListener: () => {
      throw new Error("boom");
    },
  });

  const response = await postEvent(receiver, mention);

  expect(response.status).toBe(500);
  expect(logger.error).toHaveBeenLastCalledWith(
    "Couldn't handle the Slack request.",
    failure,
  );
});

describe("reading the body before fetch, on srvx's Node requests", () => {
  const signedMention = () =>
    signedRequest(
      "https://example.com/webhooks/slack",
      eventBody(mention),
      "application/json",
    );

  it("works when the route clones first, reads the original and passes the clone", async () => {
    const { receiver, app } = createApp();
    const seen: string[] = [];
    app.event("app_mention", async ({ event }) => {
      seen.push(event.text);
    });
    let body = "";

    const response = await viaNodeRoute(async (request) => {
      const copy = request.clone();
      body = await request.text();
      return receiver.fetch(copy);
    }, signedMention());

    expect(response.status).toBe(200);
    expect(JSON.parse(body).event.text).toBe("<@U1> hi");
    await vi.mocked(waitUntil).mock.calls[0][0];
    expect(seen).toEqual(["<@U1> hi"]);
  });

  // Reading a clone drains the Node stream Bolt reads, but leaves bodyUsed
  // false, so without the receiver's check Bolt answered 401.
  it("throws a TypeError when the route reads a clone and passes the original", async () => {
    const { receiver } = createApp();
    let thrown: unknown;

    const response = await viaNodeRoute(async (request) => {
      await request.clone().text();
      try {
        return await receiver.fetch(request);
      } catch (error) {
        thrown = error;
        return new Response(null, { status: 500 });
      }
    }, signedMention());

    expect(response.status).toBe(500);
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message).toBe(BODY_USED);
  });
});

describe("OAuth", () => {
  /**
   * Sends a GET to `url` through fetch and reads the response to the end, or
   * resolves with "pending" if it hasn't ended after a second.
   */
  async function fetchToEnd(receiver: VercelReceiver, url: string) {
    let timer: NodeJS.Timeout | undefined;
    const response = await Promise.race([
      receiver.fetch(new Request(url)).then(async (response) => {
        await response.text();
        return response;
      }),
      new Promise<"pending">((resolve) => {
        timer = setTimeout(() => resolve("pending"), 1000);
      }),
    ]);
    clearTimeout(timer);
    // Let Bolt log what the installer threw.
    await new Promise((resolve) => setImmediate(resolve));
    return response;
  }

  /** A real App doing Bolt's OAuth on a VercelReceiver, with an in-memory store. */
  async function createOAuthApp(receiverOptions: VercelReceiverOptions = {}) {
    const installations = new Map<string, Installation>();
    const installationStore: InstallationStore = {
      storeInstallation: async (installation) => {
        installations.set(
          installation.team?.id ?? "",
          installation as Installation,
        );
      },
      fetchInstallation: async ({ teamId }) => {
        const installation = installations.get(teamId ?? "");
        if (!installation) throw new Error("No installation");
        return installation;
      },
    };
    const receiver = new VercelReceiver({
      signingSecret: SECRET,
      clientId: "client-id",
      clientSecret: "client-secret",
      stateSecret: "state-secret",
      scopes: ["chat:write"],
      installationStore,
      ...receiverOptions,
      installerOptions: {
        clientOptions: { slackApiUrl: await fakeSlackApi() },
        ...receiverOptions.installerOptions,
      },
    });
    const app = new App({ receiver, deferInitialization: true });
    return { receiver, app, installations };
  }

  it.each(["?x=1", "#fragment", "?", "#"])(
    "rejects redirectUri suffix %s with a clear initialization error",
    (suffix) => {
      expect(
        () =>
          new VercelReceiver({
            signingSecret: SECRET,
            redirectUri: `https://example.com/api/slack/oauth${suffix}`,
          }),
      ).toThrow(
        new AppInitializationError(
          "redirectUri must not include a query string or fragment. Use a URL like https://example.com/api/slack/oauth.",
        ),
      );
    },
  );

  // Bolt requires redirectUri to end with its path, and would otherwise blame
  // installerOptions.redirectUriPath, which users can't set.
  it.each([
    [
      "https://example.com",
      'redirectUri must include a path, like https://example.com/api/slack/oauth, but it\'s "https://example.com".',
    ],
    [
      "https://example.com/api/slack/ü",
      'redirectUri must be percent-encoded and normalized, like https://example.com/api/slack/%C3%BC, but it\'s "https://example.com/api/slack/ü".',
    ],
    [
      "https://example.com/api/./slack",
      'redirectUri must be percent-encoded and normalized, like https://example.com/api/slack, but it\'s "https://example.com/api/./slack".',
    ],
  ])(
    "rejects redirectUri %s with a clear initialization error",
    (redirectUri, message) => {
      expect(
        () => new VercelReceiver({ signingSecret: SECRET, redirectUri }),
      ).toThrow(new AppInitializationError(message));
    },
  );

  it.each<[string, string, VercelReceiverOptions]>([
    ["separate routes", "https://example.com/api/slack/oauth", {}],
    [
      "an empty redirectUri",
      "https://example.com/api/slack/oauth",
      { redirectUri: "" },
    ],
    [
      "a redirectUri at the domain root",
      "https://example.com/",
      { redirectUri: "https://example.com/" },
    ],
    [
      "a redirectUri with encoded path delimiters",
      "https://example.com/api/slack%3Foauth%23callback",
      { redirectUri: "https://example.com/api/slack%3Foauth%23callback" },
    ],
    [
      "one route with a redirectUri",
      "https://example.com/api/slack",
      { redirectUri: "https://example.com/api/slack" },
    ],
  ])(
    "installs through fetch with %s, then authorizes events from the store",
    async (_, callbackUrl, receiverOptions) => {
      const { receiver, app, installations } =
        await createOAuthApp(receiverOptions);
      const tokens: unknown[] = [];
      app.event("app_mention", async ({ context }) => {
        tokens.push(context.botToken);
      });

      const page = await receiver.fetch(
        new Request("https://example.com/api/slack"),
      );
      const html = await page.text();
      const state = html.match(/state=([^&"]+)/)?.[1];
      const [cookie] = page.headers.getSetCookie();

      expect(page.status).toBe(200);
      expect(state).toBeDefined();
      if (receiverOptions.redirectUri) {
        expect(html).toContain(
          `redirect_uri=${encodeURIComponent(receiverOptions.redirectUri)}`,
        );
      } else {
        expect(html).not.toContain("redirect_uri");
      }

      const callback = await receiver.fetch(
        new Request(`${callbackUrl}?code=c1&state=${state}`, {
          headers: { cookie: cookie.split(";")[0] },
        }),
      );

      expect(callback.status).toBe(200);
      expect(installations.get("T1")?.bot?.token).toBe("xoxb-installed");

      const response = await postEvent(receiver, mention);

      expect(response.status).toBe(200);
      // The install page and callback were kept alive first.
      expect(waitUntil).toHaveBeenCalledTimes(3);
      await vi.mocked(waitUntil).mock.calls[2][0];
      expect(tokens).toEqual(["xoxb-installed"]);
    },
  );

  it("rejects a callback from another browser session", async () => {
    const { receiver, installations } = await createOAuthApp();
    const page = await receiver.fetch(
      new Request("https://example.com/api/slack"),
    );
    const state = (await page.text()).match(/state=([^&"]+)/)?.[1];

    const callback = await receiver.fetch(
      new Request(`https://example.com/api/slack?code=c1&state=${state}`),
    );

    expect(callback.status).toBe(400);
    expect(installations.size).toBe(0);
  });

  // Bolt runs the installer without awaiting it and only logs its errors, so
  // without the receiver's help these responses never finish.
  it.each<[string, string, VercelReceiverOptions["installerOptions"], string]>([
    [
      "the install page",
      "https://example.com/api/slack",
      {
        installPathOptions: {
          beforeRedirection: async () => {
            throw new Error("beforeRedirection failed");
          },
        },
      },
      "An unhandled error occurred while Bolt processed a request to the installation path",
    ],
    [
      "the OAuth callback",
      "https://example.com/api/slack?code=c1&state=not-this-session",
      {
        callbackOptions: {
          failure: () => {
            throw new Error("failure callback failed");
          },
        },
      },
      "HTTPReceiver encountered an unexpected error while handling the OAuth install redirect",
    ],
  ])(
    "answers 500 when %s throws instead of leaving the request open",
    async (_, url, installerOptions, boltError) => {
      const logger = createLogger();
      const { receiver } = await createOAuthApp({ installerOptions, logger });

      const response = await fetchToEnd(receiver, url);

      expect(response).not.toBe("pending");
      expect((response as Response).status).toBe(500);
      // Bolt's own log line, which it writes only if the receiver rethrows.
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(boltError),
      );
    },
  );

  // Answering 500 after the headers were sent would throw
  // ERR_HTTP_HEADERS_SENT and leave the response open.
  it("keeps the status a callback wrote before it threw, and ends the response", async () => {
    const logger = createLogger();
    const { receiver } = await createOAuthApp({
      logger,
      installerOptions: {
        callbackOptions: {
          failure: (_error, _options, _req, res) => {
            res.writeHead(302, { location: "https://example.com/oops" });
            throw new Error("after headers");
          },
        },
      },
    });

    const response = await fetchToEnd(
      receiver,
      "https://example.com/api/slack?code=c1&state=not-this-session",
    );

    expect(response).not.toBe("pending");
    expect((response as Response).status).toBe(302);
    expect(logger.debug).toHaveBeenCalledWith(
      "Error details: Error: after headers",
    );
  });

  // srvx resolves the response once its head is written, and @slack/oauth
  // runs successAsync after success has answered.
  it("keeps the installer's work after the response alive with waitUntil", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let welcomed = false;
    const { receiver, installations } = await createOAuthApp({
      installerOptions: {
        callbackOptions: {
          success: (_installation, _options, _req, res) => {
            res.writeHead(302, { location: "https://example.com/thanks" });
            res.end();
          },
          successAsync: async () => {
            await released;
            welcomed = true;
          },
        },
      },
    });
    const page = await receiver.fetch(
      new Request("https://example.com/api/slack"),
    );
    const state = (await page.text()).match(/state=([^&"]+)/)?.[1];
    const [cookie] = page.headers.getSetCookie();

    const callback = await receiver.fetch(
      new Request(`https://example.com/api/slack?code=c1&state=${state}`, {
        headers: { cookie: cookie.split(";")[0] },
      }),
    );
    await callback.text();

    expect(callback.status).toBe(302);
    expect(installations.has("T1")).toBe(true);
    // One for the install page and one for the callback, which is still
    // waiting for successAsync.
    expect(waitUntil).toHaveBeenCalledTimes(2);
    const kept = vi.mocked(waitUntil).mock.calls[1][0];
    let settled = false;
    void kept.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    release();
    await kept;
    expect(welcomed).toBe(true);
  });

  // Bolt calls the installer while the request has Bolt's path, and these
  // callbacks run before the installer's first await.
  it("gives the installer's callbacks the URL the route was called on", async () => {
    const urls: (string | undefined)[] = [];
    const { receiver } = await createOAuthApp({
      logger: createLogger(),
      installerOptions: {
        installPathOptions: {
          beforeRedirection: async (req) => {
            urls.push(req.url);
            return true;
          },
        },
        callbackOptions: {
          failure: (_error, _options, req, res) => {
            urls.push(req.url);
            res.writeHead(400).end();
          },
        },
      },
    });

    await fetchToEnd(receiver, "https://example.com/api/slack?team=T1");
    // No state, so the callback fails before its first await.
    await fetchToEnd(receiver, "https://example.com/api/slack?code=c1");

    expect(urls).toEqual(["/api/slack?team=T1", "/api/slack?code=c1"]);
  });
});
