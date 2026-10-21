import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type App,
  AppInitializationError,
  HTTPReceiverDeferredRequestError,
  type HTTPReceiverOptions,
  type ReceiverEvent,
} from "@slack/bolt";
import { waitUntil } from "@vercel/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelReceiver, type VercelReceiverOptions } from "./index";

const superCalls = vi.hoisted((): unknown[] => []);

// Stub HTTPReceiver so only our subclass logic runs. Like Bolt's, init()
// stores the app it is given (Bolt then calls `this.app.processEvent`), and
// the logger defaults when none is passed, and there's an installer when
// clientId and clientSecret are set; the constructor records what our
// subclass passes to super(). requestListener answers with the method and URL
// it received.
vi.mock("@slack/bolt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slack/bolt")>();
  class HTTPReceiver {
    public app: unknown;
    public logger: unknown;
    public installer: unknown;
    public requestListener = (req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200).end(`${req.method} ${req.url}`);
    };
    public constructor(options: HTTPReceiverOptions) {
      superCalls.push(options);
      this.logger = options.logger ?? { error: vi.fn() };
      if (options.clientId && options.clientSecret) this.installer = {};
    }
    public init(app: unknown): void {
      this.app = app;
    }
  }
  return { ...actual, HTTPReceiver };
});

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

type ErrorHandler = NonNullable<
  HTTPReceiverOptions["processEventErrorHandler"]
>;

const INIT_FAILED =
  "app.init() failed, so this event wasn't processed. It runs again on the next event.";

const MISSING_STORE =
  "Missing installationStore. OAuth needs one that saves installations somewhere lasting, like a database, because Bolt's default keeps them in memory.";

const MISSING_CLIENT_SECRET =
  "Missing clientSecret. OAuth needs it whenever clientId is set.";

const MISSING_STATE_SECRET =
  "Missing stateSecret. OAuth needs it to sign the state parameter whenever clientId is set, unless you pass installerOptions.stateStore or set installerOptions.stateVerification to false.";

// What the receiver passes Bolt as installerOptions when none are given.
const BOLT_PATHS = {
  installerOptions: {
    installPath: "/slack/install",
    redirectUriPath: "/slack/oauth_redirect",
  },
};

const oauth: VercelReceiverOptions = {
  signingSecret: "secret",
  clientId: "id",
  clientSecret: "secret",
  stateSecret: "state",
  installationStore: {
    storeInstallation: async () => {},
    fetchInstallation: async () => ({}) as never,
  },
};

const MISSING_SECRET =
  "Missing signing secret. Set the SLACK_SIGNING_SECRET environment variable or pass the signingSecret option.";
const MISSING_OPTION_SECRET =
  "Missing signing secret. The signingSecret option is empty. Check that the environment variable you pass as signingSecret is set.";

const makeEvent = () =>
  ({ body: {}, ack: async () => {} }) as unknown as ReceiverEvent;

/** Inits a receiver with `app` and returns the app HTTPReceiver now holds. */
function initWith(app: Partial<App>, options: VercelReceiverOptions = {}): App {
  const receiver = new VercelReceiver({ signingSecret: "secret", ...options });
  receiver.init(app as App);
  return (receiver as unknown as { app: App }).app;
}

/** The promise passed to the nth waitUntil call. */
const keptAlive = (n = 0) => vi.mocked(waitUntil).mock.calls[n][0];

/** Whether `promise` has settled once pending callbacks have run. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  void promise.then(mark, mark);
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.stubEnv("SLACK_SIGNING_SECRET", undefined);
  superCalls.length = 0;
  vi.mocked(waitUntil).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("constructor", () => {
  it("reads the signing secret from SLACK_SIGNING_SECRET", () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "env-signing");

    new VercelReceiver();

    expect(superCalls).toEqual([
      {
        signingSecret: "env-signing",
        endpoints: "/slack/events",
        ...BOLT_PATHS,
      },
    ]);
  });

  it("prefers the signingSecret option over the environment variable", () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "env-signing");

    new VercelReceiver({ signingSecret: "opt-signing" });

    expect(superCalls).toEqual([
      {
        signingSecret: "opt-signing",
        endpoints: "/slack/events",
        ...BOLT_PATHS,
      },
    ]);
  });

  it("passes every other option to HTTPReceiver unchanged", () => {
    const options: VercelReceiverOptions = {
      signingSecret: "secret",
      unhandledRequestTimeoutMillis: 1000,
      processBeforeResponse: true,
      logger: { info: vi.fn() } as unknown as HTTPReceiverOptions["logger"],
    };

    new VercelReceiver(options);

    expect(superCalls).toEqual([
      { ...options, endpoints: "/slack/events", ...BOLT_PATHS },
    ]);
  });

  it("does not require a secret when signatureVerification is false", () => {
    new VercelReceiver({ signatureVerification: false });

    expect(superCalls).toEqual([
      {
        signatureVerification: false,
        signingSecret: "",
        endpoints: "/slack/events",
        ...BOLT_PATHS,
      },
    ]);
  });

  it.each<[string, VercelReceiverOptions, string | undefined]>([
    ["neither the option nor the env var is set", {}, undefined],
    ["the env var is an empty string", {}, ""],
    [
      "signatureVerification is true",
      { signatureVerification: true },
      undefined,
    ],
  ])("throws before calling HTTPReceiver when %s", (_, options, env) => {
    vi.stubEnv("SLACK_SIGNING_SECRET", env);

    expect(() => new VercelReceiver(options)).toThrow(
      new AppInitializationError(MISSING_SECRET),
    );
    expect(superCalls).toEqual([]);
  });

  // Like `signingSecret: process.env.MY_SIGNING_SECRET` with that var unset.
  // An empty string doesn't fall back to SLACK_SIGNING_SECRET, even when set.
  it.each<[string, VercelReceiverOptions, string | undefined]>([
    ["undefined", { signingSecret: undefined }, undefined],
    ["an empty string", { signingSecret: "" }, undefined],
    [
      "an empty string and SLACK_SIGNING_SECRET is set",
      { signingSecret: "" },
      "env-secret",
    ],
  ])(
    "points at the app's own env var when the option is %s",
    (_, options, env) => {
      vi.stubEnv("SLACK_SIGNING_SECRET", env);

      expect(() => new VercelReceiver(options)).toThrow(
        new AppInitializationError(MISSING_OPTION_SECRET),
      );
      expect(superCalls).toEqual([]);
    },
  );
});

describe("OAuth options", () => {
  /** The installerOptions our receiver passed to HTTPReceiver. */
  function installerOptionsFor(options: VercelReceiverOptions) {
    new VercelReceiver({ ...oauth, ...options });
    const [passed] = superCalls as HTTPReceiverOptions[];
    return passed.installerOptions;
  }

  it("passes other installer options through", () => {
    const beforeRedirection = async () => true;

    expect(
      installerOptionsFor({
        installerOptions: {
          directInstall: true,
          installPathOptions: { beforeRedirection },
        },
      }),
    ).toEqual({
      directInstall: true,
      installPathOptions: { beforeRedirection },
      ...BOLT_PATHS.installerOptions,
    });
  });

  it("derives redirectUriPath from redirectUri", () => {
    expect(
      installerOptionsFor({
        redirectUri: "https://example.com/api/slack/oauth",
      }),
    ).toEqual({
      installPath: "/slack/install",
      redirectUriPath: "/api/slack/oauth",
    });
  });

  it("rejects a redirectUri query before calling HTTPReceiver without logging its value", () => {
    expect(
      () =>
        new VercelReceiver({
          ...oauth,
          redirectUri: "https://example.com/api/slack/oauth?token=private",
        }),
    ).toThrow(
      new AppInitializationError(
        "redirectUri must not include a query string or fragment. Use a URL like https://example.com/api/slack/oauth.",
      ),
    );
    expect(superCalls).toEqual([]);
  });

  it("moves the install page off the callback's path", () => {
    expect(
      installerOptionsFor({ redirectUri: "https://example.com/slack/install" }),
    ).toEqual({
      installPath: "/slack/events",
      redirectUriPath: "/slack/install",
    });
  });

  it("keeps Bolt's paths even if JavaScript passes them", () => {
    expect(
      installerOptionsFor({
        installerOptions: {
          // @ts-expect-error fetch serves the install page at any path
          installPath: "/install",
          redirectUriPath: "/redirect",
        },
      }),
    ).toEqual(BOLT_PATHS.installerOptions);
  });

  it("doesn't accept installer options for Bolt's own server", () => {
    const options: VercelReceiverOptions["installerOptions"][] = [
      // @ts-expect-error fetch serves the install page at any path
      { installPath: "/i" },
      // @ts-expect-error fetch serves the callback at any path
      { redirectUriPath: "/r" },
      // @ts-expect-error port doesn't apply to fetch
      { port: 3000 },
    ];
    expect(options).toHaveLength(3);
  });

  it("throws before calling HTTPReceiver when clientId has no installationStore", () => {
    expect(
      () => new VercelReceiver({ ...oauth, installationStore: undefined }),
    ).toThrow(new AppInitializationError(MISSING_STORE));
    expect(superCalls).toEqual([]);
  });

  it.each<[string, VercelReceiverOptions]>([
    ["is missing", { clientSecret: undefined }],
    ["is an empty string", { clientSecret: "" }],
  ])(
    "throws before calling HTTPReceiver when clientSecret %s",
    (_, options) => {
      expect(() => new VercelReceiver({ ...oauth, ...options })).toThrow(
        new AppInitializationError(MISSING_CLIENT_SECRET),
      );
      expect(superCalls).toEqual([]);
    },
  );

  it.each<[string, VercelReceiverOptions]>([
    ["is missing", { stateSecret: undefined }],
    ["is an empty string", { stateSecret: "" }],
  ])("throws before calling HTTPReceiver when stateSecret %s", (_, options) => {
    expect(() => new VercelReceiver({ ...oauth, ...options })).toThrow(
      new AppInitializationError(MISSING_STATE_SECRET),
    );
    expect(superCalls).toEqual([]);
  });

  it.each<[string, VercelReceiverOptions["installerOptions"]]>([
    [
      "a stateStore",
      {
        stateStore: {
          generateStateParam: async () => "state",
          verifyStateParam: async () => ({}) as never,
        },
      },
    ],
    ["stateVerification turned off", { stateVerification: false }],
  ])("doesn't need stateSecret with %s", (_, installerOptions) => {
    expect(
      () =>
        new VercelReceiver({
          ...oauth,
          stateSecret: undefined,
          installerOptions,
        }),
    ).not.toThrow();
    expect(superCalls).toHaveLength(1);
  });

  it("throws before calling HTTPReceiver when redirectUri isn't an absolute URL", () => {
    expect(
      () => new VercelReceiver({ ...oauth, redirectUri: "/api/slack/oauth" }),
    ).toThrow(
      new AppInitializationError(
        'redirectUri must be an absolute URL, like https://example.com/api/slack, but it\'s "/api/slack/oauth".',
      ),
    );
    expect(superCalls).toEqual([]);
  });
});

describe("processEventErrorHandler", () => {
  /** The handler our receiver passed to HTTPReceiver. */
  function wrap(handler: ErrorHandler): ErrorHandler {
    new VercelReceiver({
      signingSecret: "secret",
      processEventErrorHandler: handler,
    });
    const [options] = superCalls as HTTPReceiverOptions[];
    return options.processEventErrorHandler as ErrorHandler;
  }

  it("calls a custom handler and keeps it alive with waitUntil until it settles", async () => {
    const handled = deferred<boolean>();
    const handler = vi.fn<ErrorHandler>(() => handled.promise);
    const args = {} as Parameters<ErrorHandler>[0];

    const result = wrap(handler)(args);

    expect(handler).toHaveBeenCalledExactlyOnceWith(args);
    expect(result).toBe(handled.promise);
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(await isSettled(keptAlive())).toBe(false);
    handled.resolve(true);
    expect(await isSettled(keptAlive())).toBe(true);
  });

  it("never rejects the promise kept alive", async () => {
    const error = new Error("reporting failed");
    const handler = vi.fn<ErrorHandler>(() => Promise.reject(error));

    await expect(wrap(handler)({} as Parameters<ErrorHandler>[0])).rejects.toBe(
      error,
    );
    await expect(keptAlive()).resolves.toBeUndefined();
  });

  it("accepts a handler that returns a boolean instead of a promise", async () => {
    const handler = (() => true) as unknown as ErrorHandler;

    expect(wrap(handler)({} as Parameters<ErrorHandler>[0])).toBe(true);
    expect(await isSettled(keptAlive())).toBe(true);
  });
});

describe("processEvent", () => {
  it("calls the app's processEvent on the app and returns its promise", () => {
    const processing = Promise.resolve();
    const app = { processEvent: vi.fn<App["processEvent"]>(() => processing) };
    const event = makeEvent();

    const result = initWith(app).processEvent(event);

    expect(app.processEvent).toHaveBeenCalledOnce();
    expect(app.processEvent.mock.calls[0][0]).toBe(event);
    expect(app.processEvent.mock.contexts[0]).toBe(app);
    expect(result).toBe(processing);
  });

  it("keeps processing alive with waitUntil until it settles", async () => {
    const processing = deferred();
    const wrapped = initWith({ processEvent: () => processing.promise });

    void wrapped.processEvent(makeEvent());

    // Synchronously, so waitUntil resolves the current request's context.
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(await isSettled(keptAlive())).toBe(false);
    processing.resolve();
    expect(await isSettled(keptAlive())).toBe(true);
  });

  it("handles concurrent events independently", async () => {
    const first = deferred();
    const second = deferred();
    const app = {
      processEvent: vi
        .fn<App["processEvent"]>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    const wrapped = initWith(app);
    const [a, b] = [makeEvent(), makeEvent()];

    expect(wrapped.processEvent(a)).toBe(first.promise);
    expect(wrapped.processEvent(b)).toBe(second.promise);
    expect(app.processEvent.mock.calls[1][0]).toBe(b);
    expect(waitUntil).toHaveBeenCalledTimes(2);

    second.resolve();
    expect(await isSettled(keptAlive(0))).toBe(false);
    expect(await isSettled(keptAlive(1))).toBe(true);
  });

  it("rejects to the caller but never rejects the promise kept alive", async () => {
    const error = new Error("listener failed");
    const wrapped = initWith({ processEvent: () => Promise.reject(error) });

    await expect(wrapped.processEvent(makeEvent())).rejects.toBe(error);
    await expect(keptAlive()).resolves.toBeUndefined();
  });
});

describe("deferred initialization", () => {
  /** An App created with deferInitialization: true, whose init waits for `initializing`. */
  function deferredApp(initializing: () => Promise<void>) {
    const app = {
      initialized: false,
      // Like Bolt's, it marks itself initialized up front and resets on failure.
      init: vi.fn(async () => {
        app.initialized = true;
        try {
          await initializing();
        } catch (error) {
          app.initialized = false;
          throw error;
        }
      }),
      processEvent: vi.fn<App["processEvent"]>(async () => {}),
    };
    return app;
  }

  it("runs app.init() once, before the first events, and keeps it alive", async () => {
    const initialized = deferred();
    const app = deferredApp(() => initialized.promise);
    const wrapped = initWith(app as unknown as Partial<App>);
    const [a, b] = [makeEvent(), makeEvent()];

    const results = [wrapped.processEvent(a), wrapped.processEvent(b)];

    expect(app.init).toHaveBeenCalledOnce();
    expect(app.init.mock.contexts[0]).toBe(app);
    expect(waitUntil).toHaveBeenCalledTimes(2);
    expect(await isSettled(keptAlive(0))).toBe(false);
    expect(app.processEvent).not.toHaveBeenCalled();

    initialized.resolve();
    await Promise.all(results);
    expect(app.processEvent.mock.calls.map(([event]) => event)).toEqual([a, b]);
    expect(app.processEvent.mock.contexts).toEqual([app, app]);
    expect(await isSettled(keptAlive(1))).toBe(true);
  });

  it("retries app.init() on the next event when it fails", async () => {
    const error = new Error("auth.test failed");
    const attempt = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);
    const app = deferredApp(attempt);
    const wrapped = initWith(app as unknown as Partial<App>);

    await expect(wrapped.processEvent(makeEvent())).rejects.toBe(error);
    expect(app.processEvent).not.toHaveBeenCalled();

    await wrapped.processEvent(makeEvent());
    expect(app.init).toHaveBeenCalledTimes(2);
    expect(app.processEvent).toHaveBeenCalledOnce();
  });

  it("logs why app.init() failed through the receiver's logger, once per attempt", async () => {
    const error = new Error("invalid_auth");
    const app = deferredApp(() => Promise.reject(error));
    const logger = { error: vi.fn() };
    const wrapped = initWith(app as unknown as Partial<App>, {
      logger: logger as unknown as HTTPReceiverOptions["logger"],
    });

    const results = [
      wrapped.processEvent(makeEvent()),
      wrapped.processEvent(makeEvent()),
    ];

    await expect(results[0]).rejects.toBe(error);
    await expect(results[1]).rejects.toBe(error);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(INIT_FAILED, error);
  });

  it("doesn't call app.init() once the app is initialized", async () => {
    const app = deferredApp(async () => {});
    const wrapped = initWith(app as unknown as Partial<App>);

    await wrapped.processEvent(makeEvent());
    await wrapped.processEvent(makeEvent());

    expect(app.init).toHaveBeenCalledOnce();
    expect(app.processEvent).toHaveBeenCalledTimes(2);
  });
});

describe("app proxy", () => {
  it("leaves the app itself untouched", () => {
    const processEvent = vi.fn<App["processEvent"]>();
    const app = { processEvent };

    initWith(app);

    expect(app.processEvent).toBe(processEvent);
  });

  it("returns the app's own values for other properties", () => {
    const client = { chat: {} };
    const start = vi.fn();
    const wrapped = initWith({
      processEvent: vi.fn(),
      client,
      start,
    } as unknown as Partial<App>);

    expect(wrapped.client).toBe(client);
    expect(wrapped.start).toBe(start);
  });
});

describe("fetch", () => {
  /** Sends a request through fetch and returns what requestListener saw. */
  async function routed(
    method: string,
    url: string,
    options: VercelReceiverOptions = {},
  ) {
    const receiver = new VercelReceiver({
      signingSecret: "secret",
      ...options,
    });
    const body = method === "POST" ? "{}" : undefined;
    const response = await receiver.fetch(new Request(url, { method, body }));
    return response.text();
  }

  it("sends POST requests at any path to the events endpoint", async () => {
    await expect(routed("POST", "https://x/api/slack?a=1")).resolves.toBe(
      "POST /slack/events?a=1",
    );
  });

  it("keeps Bolt's endpoint even if JavaScript passes endpoints", () => {
    new VercelReceiver({
      signingSecret: "secret",
      // @ts-expect-error endpoints is set by the receiver
      endpoints: "/events",
    });

    expect(superCalls).toEqual([
      expect.objectContaining({ endpoints: "/slack/events" }),
    ]);
  });

  it("doesn't accept options for Bolt's own server", () => {
    const signingSecret = "secret";
    // @ts-expect-error customRoutes don't apply to fetch
    new VercelReceiver({ signingSecret, customRoutes: [] });
    // @ts-expect-error port doesn't apply to fetch
    new VercelReceiver({ signingSecret, port: 3000 });
    // @ts-expect-error dispatchErrorHandler doesn't apply to fetch
    new VercelReceiver({ signingSecret, dispatchErrorHandler: () => {} });
  });

  it("sends other methods to the endpoint too, so Bolt answers them", async () => {
    await expect(routed("GET", "https://x/api/slack?a=1")).resolves.toBe(
      "GET /slack/events?a=1",
    );
  });

  it("sends GET requests to the install page with the OAuth options", async () => {
    await expect(routed("GET", "https://x/api/slack?a=1", oauth)).resolves.toBe(
      "GET /slack/install?a=1",
    );
  });

  it.each(["code=c&state=s", "error=access_denied&state=s", "code=c"])(
    "sends GET requests with %s to the OAuth callback",
    async (query) => {
      await expect(
        routed("GET", `https://x/api/slack?${query}`, oauth),
      ).resolves.toBe(`GET /slack/oauth_redirect?${query}`);
    },
  );

  it("sends the OAuth callback to the path redirectUri gives Bolt", async () => {
    await expect(
      routed("GET", "https://x/api/slack?code=c", {
        ...oauth,
        redirectUri: "https://x/api/slack",
      }),
    ).resolves.toBe("GET /api/slack?code=c");
  });

  it("still sends POST requests to the events endpoint with the OAuth options", async () => {
    await expect(
      routed("POST", "https://x/api/slack?code=c", oauth),
    ).resolves.toBe("POST /slack/events?code=c");
  });

  it("restores the request's URL after Bolt has routed it", async () => {
    const receiver = new VercelReceiver({ signingSecret: "secret" });
    const seen: (string | undefined)[] = [];
    const listener = (receiver as unknown as { requestListener: unknown })
      .requestListener as (req: IncomingMessage, res: ServerResponse) => void;
    Object.assign(receiver, {
      requestListener: (req: IncomingMessage, res: ServerResponse) => {
        seen.push(req.url);
        res.once("finish", () => seen.push(req.url));
        listener(req, res);
      },
    });

    await (await receiver.fetch(new Request("https://x/api/slack?a=1"))).text();

    expect(seen).toEqual(["/slack/events?a=1", "/api/slack?a=1"]);
  });

  it("responds 404 with an empty body when Bolt defers the request", async () => {
    const receiver = new VercelReceiver({ signingSecret: "secret" });
    Object.assign(receiver, {
      requestListener: (req: IncomingMessage, res: ServerResponse) => {
        throw new HTTPReceiverDeferredRequestError("unhandled", req, res);
      },
    });

    const response = await receiver.fetch(new Request("https://x/"));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("");
  });

  it("answers 500 and logs other errors through the receiver's logger", async () => {
    const logger = { error: vi.fn() };
    const receiver = new VercelReceiver({
      signingSecret: "secret",
      logger: logger as unknown as HTTPReceiverOptions["logger"],
    });
    const error = new Error("boom");
    Object.assign(receiver, {
      requestListener: () => {
        throw error;
      },
    });

    const response = await receiver.fetch(new Request("https://x/"));

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("");
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      "Couldn't handle the Slack request.",
      error,
    );
  });

  it("rejects a request whose body was already read", async () => {
    const receiver = new VercelReceiver({ signingSecret: "secret" });
    const request = new Request("https://x/", { method: "POST", body: "{}" });
    await request.text();

    await expect(receiver.fetch(request)).rejects.toThrow(
      new TypeError(
        "Request body already read. Bolt needs the raw body to verify Slack's signature, so pass request.clone() to fetch instead.",
      ),
    );
  });

  it("works unbound", async () => {
    const { fetch } = new VercelReceiver({ signingSecret: "secret" });

    const response = await fetch(
      new Request("https://x/api/slack", { method: "POST", body: "{}" }),
    );

    await expect(response.text()).resolves.toBe("POST /slack/events");
  });

  it("exposes POST as an unbound handler that calls fetch", async () => {
    const receiver = new VercelReceiver({ signingSecret: "secret" });
    const fetch = vi.spyOn(receiver, "fetch");
    const { POST } = receiver;
    const request = new Request("https://x/api/slack", {
      method: "POST",
      body: "{}",
    });

    const response = await POST(request);

    await expect(response.text()).resolves.toBe("POST /slack/events");
    expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("exposes GET as an unbound handler that calls fetch", async () => {
    const receiver = new VercelReceiver({ signingSecret: "secret" });
    const fetch = vi.spyOn(receiver, "fetch");
    const { GET } = receiver;
    const request = new Request("https://x/api/slack");

    const response = await GET(request);

    await expect(response.text()).resolves.toBe("GET /slack/events");
    expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
  });
});
