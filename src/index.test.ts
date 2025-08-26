import type { App } from "@slack/bolt";
import { LogLevel } from "@slack/logger";
import { waitUntil } from "@vercel/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler, VercelReceiver } from "./index";

vi.mock("@slack/logger", () => ({
  ConsoleLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    getLevel: vi.fn(),
  })),
  LogLevel: {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3,
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

describe("VercelReceiver", () => {
  describe("constructor", () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.SLACK_SIGNING_SECRET;
    });

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env.SLACK_SIGNING_SECRET = originalEnv;
      } else {
        delete process.env.SLACK_SIGNING_SECRET;
      }
    });

    it("should assign signingSecret from options", () => {
      const receiver = new VercelReceiver({ signingSecret: "test-secret" });

      expect(receiver).toHaveProperty("signingSecret", "test-secret");
    });

    it("should assign signingSecret from environment variable when not provided", () => {
      process.env.SLACK_SIGNING_SECRET = "env-secret";

      const receiver = new VercelReceiver();

      expect(receiver).toHaveProperty("signingSecret", "env-secret");
    });

    it("should assign signatureVerification to true by default", () => {
      const receiver = new VercelReceiver({ signingSecret: "test-secret" });

      expect(receiver).toHaveProperty("signatureVerification", true);
    });

    it("should assign signatureVerification from options when provided", () => {
      const receiver = new VercelReceiver({
        signingSecret: "test-secret",
        signatureVerification: false,
      });

      expect(receiver).toHaveProperty("signatureVerification", false);
    });

    it("should assign ackTimeoutMs to default value of 3001", () => {
      const receiver = new VercelReceiver({ signingSecret: "test-secret" });

      expect(receiver).toHaveProperty("ackTimeoutMs", 3001);
    });

    it("should assign ackTimeoutMs from options when provided", () => {
      const receiver = new VercelReceiver({
        signingSecret: "test-secret",
        ackTimeoutMs: 5000,
      });

      expect(receiver).toHaveProperty("ackTimeoutMs", 5000);
    });

    it("should assign customPropertiesExtractor from options when provided", () => {
      const extractor = () => ({ custom: "property" });
      const receiver = new VercelReceiver({
        signingSecret: "test-secret",
        customPropertiesExtractor: extractor,
      });

      expect(receiver).toHaveProperty("customPropertiesExtractor", extractor);
    });

    it("should assign customPropertiesExtractor to undefined when not provided", () => {
      const receiver = new VercelReceiver({ signingSecret: "test-secret" });

      expect(receiver).toHaveProperty("customPropertiesExtractor", undefined);
    });

    it("should throw error when signingSecret is not provided", () => {
      expect(() => new VercelReceiver()).toThrow(
        "SLACK_SIGNING_SECRET is required for VercelReceiver",
      );
    });
  });

  describe("getLogger", () => {
    it("should return the logger instance", () => {
      const receiver = new VercelReceiver({ signingSecret: "test-secret" });

      const logger = receiver.getLogger();

      expect(logger).toBeDefined();
      expect(logger).toHaveProperty("debug");
      expect(logger).toHaveProperty("info");
      expect(logger).toHaveProperty("warn");
      expect(logger).toHaveProperty("error");
      expect(logger).toHaveProperty("setLevel");
      expect(logger).toHaveProperty("getLevel");
    });

    it("should return the same logger instance on multiple calls", () => {
      const receiver = new VercelReceiver({ signingSecret: "test-secret" });

      const logger1 = receiver.getLogger();
      const logger2 = receiver.getLogger();

      expect(logger1).toBe(logger2);
    });

    it("should return a scoped logger with correct prefix", () => {
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        setLevel: vi.fn(),
        getLevel: vi.fn(),
        setName: vi.fn(),
      };

      const receiver = new VercelReceiver({
        signingSecret: "test-secret",
        logger: mockLogger,
      });

      const logger = receiver.getLogger();
      logger.info("test message");

      // The scoped logger should call the original logger with the prefix
      expect(mockLogger.info).toHaveBeenCalledWith(
        "[@vercel/slack-bolt]",
        "test message",
      );
    });
  });

  describe("init", () => {
    it("should assign the app instance to this.app", () => {
      const receiver = new VercelReceiver({ signingSecret: "test-secret" });
      const mockApp = { processEvent: vi.fn() } as unknown as App;

      receiver.init(mockApp);

      expect(receiver).toHaveProperty("app", mockApp);
    });

    it("should log debug message when log level is debug", () => {
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        setLevel: vi.fn(),
        getLevel: vi.fn(),
        setName: vi.fn(),
      };

      const receiver = new VercelReceiver({
        signingSecret: "test-secret",
        logger: mockLogger,
        logLevel: LogLevel.DEBUG,
      });

      const mockApp = { processEvent: vi.fn() } as unknown as App;

      receiver.init(mockApp);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        "[@vercel/slack-bolt]",
        "App initialized in VercelReceiver",
      );
    });

    it("should not throw error when called multiple times", () => {
      const receiver = new VercelReceiver({ signingSecret: "test-secret" });
      const mockApp1 = { processEvent: vi.fn() } as unknown as App;
      const mockApp2 = { processEvent: vi.fn() } as unknown as App;

      expect(() => {
        receiver.init(mockApp1);
        receiver.init(mockApp2);
      }).not.toThrow();

      // Should have the latest app instance
      expect(receiver).toHaveProperty("app", mockApp2);
    });
  });

  describe("start", () => {
    it("should return a VercelHandler function", async () => {
      const receiver = new VercelReceiver({ signingSecret: "test-secret" });

      const handler = await receiver.start();

      expect(handler).toBeDefined();
      expect(typeof handler).toBe("function");
      expect(handler.length).toBe(1); // Should accept one parameter (Request)
    });

    it("should log debug message when log level is debug", async () => {
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        setLevel: vi.fn(),
        getLevel: vi.fn(),
        setName: vi.fn(),
      };

      const receiver = new VercelReceiver({
        signingSecret: "test-secret",
        logger: mockLogger,
        logLevel: LogLevel.DEBUG,
      });

      await receiver.start();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        "[@vercel/slack-bolt]",
        "VercelReceiver started",
      );
    });

    it("should return the same handler as toHandler", async () => {
      const receiver = new VercelReceiver({ signingSecret: "test-secret" });

      const startHandler = await receiver.start();
      const toHandler = receiver.toHandler();

      // Both should be functions with the same signature
      expect(typeof startHandler).toBe("function");
      expect(typeof toHandler).toBe("function");
      expect(startHandler.length).toBe(toHandler.length);
    });

    it("should return a handler that can be called multiple times", async () => {
      const receiver = new VercelReceiver({ signingSecret: "test-secret" });

      const handler1 = await receiver.start();
      const handler2 = await receiver.start();

      expect(handler1).toBeDefined();
      expect(handler2).toBeDefined();
      expect(typeof handler1).toBe("function");
      expect(typeof handler2).toBe("function");
    });
  });

  describe("stop", () => {
    it("should return a void promise", async () => {
      const receiver = new VercelReceiver({ signingSecret: "test-secret" });

      const result = await receiver.stop();

      expect(result).toBeUndefined();
    });

    it("should log debug message when log level is debug", async () => {
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        setLevel: vi.fn(),
        getLevel: vi.fn(),
        setName: vi.fn(),
      };

      const receiver = new VercelReceiver({
        signingSecret: "test-secret",
        logger: mockLogger,
        logLevel: LogLevel.DEBUG,
      });

      await receiver.stop();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        "[@vercel/slack-bolt]",
        "VercelReceiver stopped",
      );
    });
  });

  describe("toHandler", () => {
    describe("Signature Verification", () => {
      it("should call verifyRequest when it defaults to true", async () => {
        const receiver = new VercelReceiver({ signingSecret: "test-secret" });
        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the verifyRequest method
        const verifyRequestSpy = vi.spyOn(receiver as any, "verifyRequest");

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event" }),
          headers: {
            "content-type": "application/json",
            "x-slack-signature": "v0=test-signature",
            "x-slack-request-timestamp": "1234567890",
          },
        });

        try {
          await handler(request);
        } catch (_error) {
          // Ignore verification errors for this test
        }

        expect(verifyRequestSpy).toHaveBeenCalled();
      });

      it("should call verifyRequest when explicitly set to true", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: true,
        });
        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the verifyRequest method
        const verifyRequestSpy = vi.spyOn(receiver as any, "verifyRequest");

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event" }),
          headers: {
            "content-type": "application/json",
            "x-slack-signature": "v0=test-signature",
            "x-slack-request-timestamp": "1234567890",
          },
        });

        try {
          await handler(request);
        } catch (_error) {
          // Ignore verification errors for this test
        }

        expect(verifyRequestSpy).toHaveBeenCalled();
      });

      it("should not call verifyRequest when set to false", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });
        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the verifyRequest method
        const verifyRequestSpy = vi.spyOn(receiver as any, "verifyRequest");

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event" }),
          headers: {
            "content-type": "application/json",
          },
        });

        await handler(request);

        expect(verifyRequestSpy).not.toHaveBeenCalled();
      });
    });

    it("should call parseRequestBody with request and raw body", async () => {
      const receiver = new VercelReceiver({
        signingSecret: "test-secret",
        signatureVerification: false,
      });
      // biome-ignore lint/suspicious/noExplicitAny: we're mocking the parseRequestBody method
      const parseRequestBodySpy = vi.spyOn(receiver as any, "parseRequestBody");

      const handler = receiver.toHandler();
      const testBody = JSON.stringify({ type: "event" });
      const request = new Request("http://localhost", {
        method: "POST",
        body: testBody,
        headers: {
          "content-type": "application/json",
        },
      });

      try {
        await handler(request);
      } catch (_error) {
        // Ignore parsing errors for this test
      }

      expect(parseRequestBodySpy).toHaveBeenCalledWith(request, testBody);
    });

    describe("URL Verification Challenge", () => {
      it("should respond with challenge when body.type is url_verification", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });

        const handler = receiver.toHandler();
        const challenge = "test-challenge-value";
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({
            type: "url_verification",
            challenge: challenge,
          }),
          headers: {
            "content-type": "application/json",
          },
        });

        const response = await handler(request);

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.challenge).toBe(challenge);
      });

      it("should return early when body.type is url_verification", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });

        const handleSlackEventSpy = vi.spyOn(
          // biome-ignore lint/suspicious/noExplicitAny: we're mocking the handleSlackEvent method
          receiver as any,
          "handleSlackEvent",
        );

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({
            type: "url_verification",
            challenge: "test-challenge",
          }),
          headers: {
            "content-type": "application/json",
          },
        });

        const response = await handler(request);

        expect(response.status).toBe(200);
        expect(handleSlackEventSpy).not.toHaveBeenCalled();
      });
    });

    describe("verifyRequest", () => {
      it("should return 401 when x-slack-signature header is missing", async () => {
        const receiver = new VercelReceiver({ signingSecret: "test-secret" });

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event" }),
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": "1234567890",
            // Missing x-slack-signature
          },
        });

        const response = await handler(request);

        expect(response.status).toBe(401);
        const body = await response.json();
        expect(body.error).toContain(
          "Missing required header: x-slack-signature",
        );
      });

      it("should return 401 when x-slack-request-timestamp header is missing", async () => {
        const receiver = new VercelReceiver({ signingSecret: "test-secret" });

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event" }),
          headers: {
            "content-type": "application/json",
            "x-slack-signature": "v0=test-signature",
            // Missing x-slack-request-timestamp
          },
        });

        const response = await handler(request);

        expect(response.status).toBe(401);
        const body = await response.json();
        expect(body.error).toContain(
          "Missing required header: x-slack-request-timestamp",
        );
      });

      it("should return 401 when signature verification fails", async () => {
        const receiver = new VercelReceiver({ signingSecret: "test-secret" });

        const handler = receiver.toHandler();
        const currentTimestamp = Math.floor(Date.now() / 1000).toString();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event" }),
          headers: {
            "content-type": "application/json",
            "x-slack-signature": "v0=invalid-signature",
            "x-slack-request-timestamp": currentTimestamp,
          },
        });

        const response = await handler(request);

        expect(response.status).toBe(401);
      });

      it("should return 401 when timestamp is stale (over 5 minutes old)", async () => {
        const receiver = new VercelReceiver({ signingSecret: "test-secret" });

        const handler = receiver.toHandler();
        // Create a timestamp that's 5 minutes and 1 second old
        const staleTimestamp = Math.floor(
          (Date.now() - 5 * 60 * 1000 - 1000) / 1000,
        ).toString();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event" }),
          headers: {
            "content-type": "application/json",
            "x-slack-signature": "v0=valid-signature-format",
            "x-slack-request-timestamp": staleTimestamp,
          },
        });

        const response = await handler(request);

        expect(response.status).toBe(401);
      });

      it("should proceed normally when signature verification is disabled", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event" }),
          headers: {
            "content-type": "application/json",
            // No signature headers required when verification is disabled
          },
        });

        const response = await handler(request);

        // Should not be 401 - signature verification is disabled
        expect(response.status).not.toBe(401);
      });
    });

    describe("parseRequestBody", () => {
      it("should warn and attempt JSON parse for unexpected content-type, success case", async () => {
        const mockLogger = {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          setLevel: vi.fn(),
          getLevel: vi.fn(),
          setName: vi.fn(),
        };

        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
          // biome-ignore lint/suspicious/noExplicitAny: we're mocking the logger
          logger: mockLogger as any,
        });

        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the handleSlackEvent method
        let capturedBody: any;
        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the handleSlackEvent method
        vi.spyOn(receiver as any, "handleSlackEvent").mockImplementation(
          // biome-ignore lint/suspicious/noExplicitAny: we're mocking the handleSlackEvent method
          async (_req: unknown, body: any) => {
            capturedBody = body;
            return new Response("", { status: 200 });
          },
        );

        const handler = receiver.toHandler();
        const payload = { type: "event_callback", ok: true };
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify(payload),
          headers: {
            "content-type": "text/plain",
          },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(capturedBody).toEqual(payload);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          "[@vercel/slack-bolt]",
          "Unexpected content-type detected: text/plain",
        );
      });

      it("should warn and return 400 for unexpected content-type with invalid JSON", async () => {
        const mockLogger = {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          setLevel: vi.fn(),
          getLevel: vi.fn(),
          setName: vi.fn(),
        };

        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
          // biome-ignore lint/suspicious/noExplicitAny: we're mocking the logger
          logger: mockLogger as any,
        });

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: "{invalid",
          headers: {
            "content-type": "text/plain",
          },
        });

        const response = await handler(request);
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.type).toBe("RequestParsingError");
        expect(body.error).toContain("text/plain");
        expect(mockLogger.warn).toHaveBeenCalledWith(
          "[@vercel/slack-bolt]",
          "Unexpected content-type detected: text/plain",
        );
      });
      it("should parse application/json and pass object to handleSlackEvent", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });

        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the handleSlackEvent method
        let capturedBody: any;
        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the handleSlackEvent method
        vi.spyOn(receiver as any, "handleSlackEvent").mockImplementation(
          // biome-ignore lint/suspicious/noExplicitAny: we're mocking the handleSlackEvent method
          async (_req: unknown, body: any) => {
            capturedBody = body;
            return new Response("", { status: 200 });
          },
        );

        const requestBody = { type: "event_callback", hello: "world" };
        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify(requestBody),
          headers: {
            "content-type": "application/json",
          },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(capturedBody).toEqual(requestBody);
      });

      it("should return 400 RequestParsingError for invalid JSON body", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          // malformed JSON
          body: '{"type": "event_callback", invalid}',
          headers: {
            "content-type": "application/json",
          },
        });

        const response = await handler(request);
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.type).toBe("RequestParsingError");
        expect(body.error).toContain("Failed to parse body as JSON data");
        expect(body.error).toContain("application/json");
      });
      it("should parse x-www-form-urlencoded with JSON payload", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });

        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the handleSlackEvent method
        let capturedBody: any;
        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the handleSlackEvent method
        vi.spyOn(receiver as any, "handleSlackEvent").mockImplementation(
          // biome-ignore lint/suspicious/noExplicitAny: we're mocking the handleSlackEvent method
          async (_req: unknown, body: any) => {
            capturedBody = body;
            return new Response("", { status: 200 });
          },
        );

        const payload = { type: "block_actions", foo: "bar" };
        const form = new URLSearchParams({ payload: JSON.stringify(payload) });

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: form.toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(capturedBody).toEqual(payload);
      });

      it("should parse x-www-form-urlencoded without payload as key/value map", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });

        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the handleSlackEvent method
        let capturedBody: any;
        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the handleSlackEvent method
        vi.spyOn(receiver as any, "handleSlackEvent").mockImplementation(
          // biome-ignore lint/suspicious/noExplicitAny: we're mocking the handleSlackEvent method
          async (_req: unknown, body: any) => {
            capturedBody = body;
            return new Response("", { status: 200 });
          },
        );

        const form = new URLSearchParams({ token: "x", team_id: "T123" });

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: form.toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(capturedBody).toEqual({ token: "x", team_id: "T123" });
      });

      it("should return 400 for x-www-form-urlencoded when payload is invalid JSON", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });

        const handler = receiver.toHandler();
        const form = new URLSearchParams({ payload: "{invalid" });
        const request = new Request("http://localhost", {
          method: "POST",
          body: form.toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
        });

        const response = await handler(request);
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.type).toBe("RequestParsingError");
        expect(body.error).toContain("application/x-www-form-urlencoded");
      });
    });

    describe("handleSlackEvent", () => {
      it("should return 500 when app is not initialized", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });

        // Don't call receiver.init() - app remains undefined

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event_callback" }),
          headers: {
            "content-type": "application/json",
          },
        });

        const response = await handler(request);

        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body.error).toBe("App not initialized");
      });

      it("should respond 200 with empty body when ack(undefined) is called", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });

        const mockApp = {
          processEvent: vi.fn(async (event) => {
            await event.ack(undefined);
          }),
        } as unknown as App;

        receiver.init(mockApp);

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event_callback" }),
          headers: {
            "content-type": "application/json",
          },
        });

        const response = await handler(request);

        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toBe("");
      });

      it("should respond 200 with string body when ack(string) is called", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });

        const mockApp = {
          processEvent: vi.fn(async (event) => {
            await event.ack("ok");
          }),
        } as unknown as App;

        receiver.init(mockApp);

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event_callback" }),
          headers: {
            "content-type": "application/json",
          },
        });

        const response = await handler(request);

        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toBe("ok");
      });

      it("should respond 200 with JSON string when ack(object) is called", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });

        const ackBody = { success: true, data: { a: 1 } };
        const mockApp = {
          processEvent: vi.fn(async (event) => {
            await event.ack(ackBody);
          }),
        } as unknown as App;

        receiver.init(mockApp);

        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event_callback" }),
          headers: {
            "content-type": "application/json",
          },
        });

        const response = await handler(request);

        expect(response.status).toBe(200);
        const text = await response.text();
        expect(JSON.parse(text)).toEqual(ackBody);
      });

      it("should create ReceiverEvent with body and retry headers", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });

        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the processEvent method
        let capturedEvent: any;
        const mockApp = {
          processEvent: vi.fn(async (event) => {
            capturedEvent = event;
            await event.ack();
          }),
        } as unknown as App;

        receiver.init(mockApp);

        const handler = receiver.toHandler();
        const requestBody = { type: "event_callback", foo: "bar" };
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify(requestBody),
          headers: {
            "content-type": "application/json",
            "x-slack-retry-num": "2",
            "x-slack-retry-reason": "http_error",
          },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(capturedEvent).toBeDefined();
        expect(typeof capturedEvent.ack).toBe("function");
        expect(capturedEvent.body).toEqual(requestBody);
        expect(capturedEvent.retryNum).toBe(2);
        expect(capturedEvent.retryReason).toBe("http_error");
        expect(capturedEvent.customProperties).toEqual({});
      });

      it("should respond from ack while event continues processing in background", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
        });

        let resolveDeferred!: () => void;
        let backgroundPending = false;
        const mockApp = {
          processEvent: vi.fn(async (event) => {
            await event.ack("ok");
            backgroundPending = true;
            await new Promise<void>((resolve) => {
              resolveDeferred = resolve;
            });
            backgroundPending = false;
          }),
        } as unknown as App;

        receiver.init(mockApp);
        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event_callback" }),
          headers: { "content-type": "application/json" },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toBe("ok");
        // The background work should still be pending at this point
        expect(backgroundPending).toBe(true);
        // Clean up: allow background to finish
        resolveDeferred();
      });

      it("should log background error and resolve the background promise when it rejects", async () => {
        const mockLogger = {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          setLevel: vi.fn(),
          getLevel: vi.fn(),
        };

        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
          // biome-ignore lint/suspicious/noExplicitAny: we're mocking the logger
          logger: mockLogger as any,
        });

        let bgDone!: () => void;
        const bgPromise = new Promise<void>((resolve) => {
          bgDone = resolve;
        });

        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the waitUntil function
        (waitUntil as any).mockImplementation(async (p: any) => {
          try {
            await p;
          } finally {
            bgDone();
          }
        });

        const mockApp = {
          processEvent: vi.fn(async (event) => {
            await event.ack("ok");
            throw new Error("boom");
          }),
        } as unknown as App;

        receiver.init(mockApp);
        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event_callback" }),
          headers: { "content-type": "application/json" },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);

        await bgPromise;
        expect(mockLogger.error).toHaveBeenCalled();
      });

      it("should include customProperties from customPropertiesExtractor", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
          customPropertiesExtractor: (req) => ({
            ua: req.headers.get("user-agent") || "",
            tag: "test",
          }),
        });

        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the processEvent method
        let capturedEvent: any;
        const mockApp = {
          processEvent: vi.fn(async (event) => {
            capturedEvent = event;
            await event.ack();
          }),
        } as unknown as App;

        receiver.init(mockApp);

        const handler = receiver.toHandler();
        const requestBody = { type: "event_callback" };
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify(requestBody),
          headers: {
            "content-type": "application/json",
            "user-agent": "vitest",
          },
        });

        const response = await handler(request);
        expect(response.status).toBe(200);
        expect(capturedEvent).toBeDefined();
        expect(capturedEvent.customProperties).toEqual({
          ua: "vitest",
          tag: "test",
        });
      });

      it("should return 408 when ack is not called within timeout", async () => {
        const receiver = new VercelReceiver({
          signingSecret: "test-secret",
          signatureVerification: false,
          ackTimeoutMs: 10,
        });

        const mockApp = {
          processEvent: vi.fn(async () => {
            // Simulate long-running background work without calling ack
            await new Promise((resolve) => setTimeout(resolve, 50));
          }),
        } as unknown as App;

        receiver.init(mockApp);
        const handler = receiver.toHandler();
        const request = new Request("http://localhost", {
          method: "POST",
          body: JSON.stringify({ type: "event_callback" }),
          headers: { "content-type": "application/json" },
        });

        const response = await handler(request);
        expect(response.status).toBe(408);
        const body = await response.json();
        expect(body.error).toBe("Request timeout");
      });
    });
  });
  describe("integration", () => {
    it("should handle request via createHandler with parsed body and ack", async () => {
      const receiver = new VercelReceiver({
        signingSecret: "test-secret",
        signatureVerification: false,
      });

      // biome-ignore lint/suspicious/noExplicitAny: we're mocking the processEvent method
      let capturedEvent: any;
      const app = {
        init: vi.fn(async () => {}),
        // biome-ignore lint/suspicious/noExplicitAny: we're mocking the processEvent method
        processEvent: vi.fn(async (event: any) => {
          capturedEvent = event;
          await event.ack({ ok: true });
        }),
      } as unknown as App;

      const handler = createHandler(app, receiver);

      const payload = { type: "event_callback", hello: "world" };
      const request = new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
      });

      const response = await handler(request);

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ ok: true });
      expect(capturedEvent?.body).toEqual(payload);
      expect(app.processEvent).toHaveBeenCalledTimes(1);
      expect(app.init).toHaveBeenCalledTimes(1);
    });
  });

  it("falls back to console.error when createHandler init fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const receiver = new VercelReceiver({
      signingSecret: "test-secret",
      signatureVerification: false,
    });

    const app = {
      init: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as App;

    const handler = createHandler(app, receiver);

    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ type: "event_callback" }),
      headers: { "content-type": "application/json" },
    });

    const response = await handler(request);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json).toHaveProperty("type", "HandlerError");

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const args = consoleSpy.mock.calls[0] ?? [];
    expect(typeof args[0]).toBe("string");
    expect(String(args[0])).toContain("createHandler");
    expect(args[1]).toBeInstanceOf(Error);

    consoleSpy.mockRestore();
  });
});
