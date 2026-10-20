import {
  type App,
  AppInitializationError,
  type HTTPReceiverOptions,
  type ReceiverEvent,
} from "@slack/bolt";
import { waitUntil } from "@vercel/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelReceiver, type VercelReceiverOptions } from "./index-v2";

const superCalls = vi.hoisted((): unknown[] => []);

// Stub HTTPReceiver so only our subclass logic runs. Like Bolt's, init()
// stores the app it is given (Bolt then calls `this.app.processEvent`), and
// the logger defaults when none is passed; the constructor records what our
// subclass passes to super().
vi.mock("@slack/bolt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slack/bolt")>();
  class HTTPReceiver {
    public app: unknown;
    public logger: unknown;
    public constructor(options: { logger?: unknown }) {
      superCalls.push(options);
      this.logger = options.logger ?? { error: vi.fn() };
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

const MISSING_SECRET =
  "Missing signing secret. Set the SLACK_SIGNING_SECRET environment variable or pass the signingSecret option.";

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

    expect(superCalls).toEqual([{ signingSecret: "env-signing" }]);
  });

  it("prefers the signingSecret option over the environment variable", () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "env-signing");

    new VercelReceiver({ signingSecret: "opt-signing" });

    expect(superCalls).toEqual([{ signingSecret: "opt-signing" }]);
  });

  it("passes every other option to HTTPReceiver unchanged", () => {
    const options: VercelReceiverOptions = {
      signingSecret: "secret",
      endpoints: "/api/slack/events",
      processBeforeResponse: true,
      logger: { info: vi.fn() } as unknown as HTTPReceiverOptions["logger"],
    };

    new VercelReceiver(options);

    expect(superCalls).toEqual([options]);
  });

  it("does not require a secret when signatureVerification is false", () => {
    new VercelReceiver({ signatureVerification: false });

    expect(superCalls).toEqual([
      { signatureVerification: false, signingSecret: "" },
    ]);
  });

  it.each<[string, VercelReceiverOptions, string | undefined]>([
    ["neither the option nor the env var is set", {}, undefined],
    ["the option is an empty string", { signingSecret: "" }, undefined],
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
