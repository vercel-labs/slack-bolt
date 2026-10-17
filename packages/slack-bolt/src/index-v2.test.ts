import {
  type App,
  AppInitializationError,
  type HTTPReceiverOptions,
  type ReceiverEvent,
} from "@slack/bolt";
import { waitUntil } from "@vercel/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelReceiver } from "./index-v2";

const constructorCalls = vi.hoisted((): unknown[] => []);

// Stub HTTPReceiver so only our subclass logic runs. It records what the
// subclass passes to super() and super.init().
vi.mock("@slack/bolt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slack/bolt")>();
  class HTTPReceiver {
    public options: unknown;
    public app: unknown;
    public constructor(options: unknown) {
      constructorCalls.push(options);
      this.options = options;
    }
    public init(app: unknown): void {
      this.app = app;
    }
  }
  return { ...actual, HTTPReceiver };
});

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

type StubbedReceiver = { options: HTTPReceiverOptions; app: App };
const stub = (receiver: VercelReceiver) =>
  receiver as unknown as StubbedReceiver;

const ENV_KEYS = [
  "SLACK_SIGNING_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_STATE_SECRET",
] as const;

const MISSING_SECRET =
  "Missing signing secret. Set the SLACK_SIGNING_SECRET environment variable or pass the signingSecret option.";

const event = { body: {}, ack: vi.fn() } as unknown as ReceiverEvent;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function initWith(app: Partial<App>) {
  const receiver = new VercelReceiver({ signingSecret: "secret" });
  receiver.init(app as App);
  return stub(receiver).app;
}

describe("VercelReceiver (v2)", () => {
  const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    constructorCalls.length = 0;
    vi.mocked(waitUntil).mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe("environment defaults", () => {
    it("reads credentials from SLACK_* environment variables", () => {
      process.env.SLACK_SIGNING_SECRET = "env-signing";
      process.env.SLACK_CLIENT_ID = "env-id";
      process.env.SLACK_CLIENT_SECRET = "env-client-secret";
      process.env.SLACK_STATE_SECRET = "env-state";

      expect(stub(new VercelReceiver()).options).toMatchObject({
        signingSecret: "env-signing",
        clientId: "env-id",
        clientSecret: "env-client-secret",
        stateSecret: "env-state",
      });
    });

    it("prefers options over environment variables", () => {
      process.env.SLACK_SIGNING_SECRET = "env-signing";
      process.env.SLACK_CLIENT_ID = "env-id";
      process.env.SLACK_CLIENT_SECRET = "env-client-secret";
      process.env.SLACK_STATE_SECRET = "env-state";

      const receiver = new VercelReceiver({
        signingSecret: "opt-signing",
        clientId: "opt-id",
        clientSecret: "opt-client-secret",
        stateSecret: "opt-state",
      });

      expect(stub(receiver).options).toMatchObject({
        signingSecret: "opt-signing",
        clientId: "opt-id",
        clientSecret: "opt-client-secret",
        stateSecret: "opt-state",
      });
    });

    it("leaves OAuth credentials undefined when neither is set", () => {
      const receiver = new VercelReceiver({ signingSecret: "secret" });

      expect(stub(receiver).options).toMatchObject({
        clientId: undefined,
        clientSecret: undefined,
        stateSecret: undefined,
      });
    });

    it("passes other options through unchanged", () => {
      const logger = {
        info: vi.fn(),
      } as unknown as HTTPReceiverOptions["logger"];
      const receiver = new VercelReceiver({
        signingSecret: "secret",
        endpoints: "/api/slack/events",
        processBeforeResponse: true,
        logger,
      });

      expect(stub(receiver).options).toMatchObject({
        endpoints: "/api/slack/events",
        processBeforeResponse: true,
        logger,
      });
    });
  });

  describe("missing signing secret", () => {
    it("throws when neither the option nor the environment variable is set", () => {
      let error: unknown;
      try {
        new VercelReceiver();
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(AppInitializationError);
      expect((error as Error).message).toBe(MISSING_SECRET);
      expect(constructorCalls).toHaveLength(0);
    });

    it("throws when the option is an empty string", () => {
      expect(() => new VercelReceiver({ signingSecret: "" })).toThrow(
        MISSING_SECRET,
      );
    });

    it("throws when the environment variable is an empty string", () => {
      process.env.SLACK_SIGNING_SECRET = "";

      expect(() => new VercelReceiver()).toThrow(MISSING_SECRET);
    });

    it("does not require a secret when signatureVerification is false", () => {
      const receiver = new VercelReceiver({ signatureVerification: false });

      expect(stub(receiver).options).toMatchObject({
        signatureVerification: false,
        signingSecret: "",
      });
    });
  });

  describe("OAuth configuration", () => {
    it("treats an empty client ID as missing", () => {
      expect(
        () =>
          new VercelReceiver({
            signingSecret: "secret",
            installerOptions: { stateVerification: true },
            clientId: "",
            clientSecret: "client-secret",
          }),
      ).toThrow(
        "Missing OAuth settings. Set the SLACK_CLIENT_ID and SLACK_STATE_SECRET environment variables or pass the clientId and stateSecret options.",
      );
    });

    const installationStore = {
      storeInstallation: vi.fn(),
      fetchInstallation: vi.fn(),
    } as unknown as HTTPReceiverOptions["installationStore"];

    it("throws and names every missing credential", () => {
      process.env.SLACK_CLIENT_ID = "id";

      expect(() => new VercelReceiver({ signingSecret: "secret" })).toThrow(
        "Missing OAuth settings. Set the SLACK_CLIENT_SECRET and SLACK_STATE_SECRET environment variables or pass the clientSecret and stateSecret options.",
      );
      expect(constructorCalls).toHaveLength(0);
    });

    it("throws when only the client ID is missing", () => {
      expect(
        () =>
          new VercelReceiver({
            signingSecret: "secret",
            clientSecret: "client-secret",
            stateSecret: "state",
          }),
      ).toThrow(
        "Missing OAuth settings. Set the SLACK_CLIENT_ID environment variable or pass the clientId option.",
      );
    });

    it("accepts a stateStore instead of a state secret", () => {
      const stateStore = {
        generateStateParam: vi.fn(),
        verifyStateParam: vi.fn(),
      };

      expect(
        () =>
          new VercelReceiver({
            signingSecret: "secret",
            clientId: "id",
            clientSecret: "client-secret",
            installationStore,
            installerOptions: { stateStore },
          }),
      ).not.toThrow();
    });

    it("accepts stateVerification: false instead of a state secret", () => {
      expect(
        () =>
          new VercelReceiver({
            signingSecret: "secret",
            clientId: "id",
            clientSecret: "client-secret",
            installationStore,
            installerOptions: { stateVerification: false },
          }),
      ).not.toThrow();
    });

    it("ignores a lone state secret", () => {
      process.env.SLACK_STATE_SECRET = "state";

      expect(
        () => new VercelReceiver({ signingSecret: "secret" }),
      ).not.toThrow();
      expect(console.warn).not.toHaveBeenCalled();
    });

    it("warns through the configured logger when there is no installationStore", () => {
      const logger = {
        warn: vi.fn(),
      } as unknown as HTTPReceiverOptions["logger"];

      new VercelReceiver({
        signingSecret: "secret",
        clientId: "id",
        clientSecret: "client-secret",
        stateSecret: "state",
        logger,
      });

      expect(logger?.warn).toHaveBeenCalledExactlyOnceWith(
        "OAuth is enabled without an installationStore. Installations are kept in memory and lost when the function restarts. Pass the installationStore option.",
      );
    });

    it("warns through console when no logger is configured", () => {
      new VercelReceiver({
        signingSecret: "secret",
        clientId: "id",
        clientSecret: "client-secret",
        stateSecret: "state",
      });

      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it("does not warn when an installationStore is provided", () => {
      new VercelReceiver({
        signingSecret: "secret",
        clientId: "id",
        clientSecret: "client-secret",
        stateSecret: "state",
        installationStore,
      });

      expect(console.warn).not.toHaveBeenCalled();
    });

    it("does nothing when OAuth is not configured", () => {
      expect(
        () => new VercelReceiver({ signingSecret: "secret" }),
      ).not.toThrow();
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  describe("redirect URI path", () => {
    it("defaults redirectUriPath to the redirectUri's path", () => {
      const receiver = new VercelReceiver({
        signingSecret: "secret",
        redirectUri: "https://example.com/api/slack/oauth?x=1",
        installerOptions: { directInstall: true },
      });

      expect(stub(receiver).options.installerOptions).toEqual({
        directInstall: true,
        redirectUriPath: "/api/slack/oauth",
      });
    });

    it("keeps an explicit redirectUriPath", () => {
      const receiver = new VercelReceiver({
        signingSecret: "secret",
        redirectUri: "https://example.com/slack/oauth_redirect",
        installerOptions: { redirectUriPath: "/oauth_redirect" },
      });

      expect(stub(receiver).options.installerOptions?.redirectUriPath).toBe(
        "/oauth_redirect",
      );
    });

    it("leaves an invalid redirectUri for Bolt to report", () => {
      const receiver = new VercelReceiver({
        signingSecret: "secret",
        redirectUri: "not a url",
      });

      expect(stub(receiver).options.installerOptions).toBeUndefined();
    });

    it("leaves installerOptions alone without a redirectUri", () => {
      const installerOptions = { directInstall: true };
      const receiver = new VercelReceiver({
        signingSecret: "secret",
        installerOptions,
      });

      expect(stub(receiver).options.installerOptions).toBe(installerOptions);
    });
  });

  describe("processEvent wrapper", () => {
    it("calls the app's processEvent and returns its promise", () => {
      const processing = Promise.resolve();
      const processEvent = vi.fn(() => processing);
      const wrapped = initWith({ processEvent });

      const result = wrapped.processEvent(event);

      expect(processEvent).toHaveBeenCalledExactlyOnceWith(event);
      expect(result).toBe(processing);
    });

    it("registers processing with waitUntil until it settles", async () => {
      const processing = deferred();
      const wrapped = initWith({ processEvent: () => processing.promise });

      void wrapped.processEvent(event);

      expect(waitUntil).toHaveBeenCalledTimes(1);
      let settled = false;
      const kept = vi.mocked(waitUntil).mock.calls[0][0].then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      processing.resolve();
      await kept;
      expect(settled).toBe(true);
    });

    it("rejects to the caller but resolves the waitUntil promise on failure", async () => {
      const error = new Error("listener failed");
      const wrapped = initWith({
        processEvent: () => Promise.reject(error),
      });

      const result = wrapped.processEvent(event);

      await expect(result).rejects.toBe(error);
      await expect(
        vi.mocked(waitUntil).mock.calls[0][0],
      ).resolves.toBeUndefined();
    });

    it("tolerates a processEvent that does not return a promise", async () => {
      const wrapped = initWith({
        processEvent: (() => undefined) as unknown as App["processEvent"],
      });

      expect(() => wrapped.processEvent(event)).not.toThrow();
      expect(waitUntil).toHaveBeenCalledTimes(1);
      await expect(
        vi.mocked(waitUntil).mock.calls[0][0],
      ).resolves.toBeUndefined();
    });
  });

  describe("app proxy", () => {
    it("returns the app's own values for other properties", () => {
      const client = { chat: {} };
      const start = vi.fn();
      const app = { processEvent: vi.fn(), client, start };
      const wrapped = initWith(app as unknown as Partial<App>);

      expect(wrapped).not.toBe(app);
      expect(wrapped.client).toBe(client);
      expect(wrapped.start).toBe(start);
    });

    it("writes through to the app", () => {
      const app = { processEvent: vi.fn() } as Partial<App> &
        Record<string, unknown>;
      const wrapped = initWith(app) as App & Record<string, unknown>;

      wrapped.extra = "value";

      expect(app.extra).toBe("value");
    });
  });
});
