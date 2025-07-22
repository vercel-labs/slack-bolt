import { VercelReceiver, createHandler } from "./index.js";
import { expect, vi, describe, afterEach, it, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

// Test helpers - following Slack patterns
const createMockRequest = (overrides = {}) =>
  ({
    method: "POST",
    url: "/slack/events",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": Math.floor(Date.now() / 1000).toString(),
      "x-slack-signature": "v0=test-signature",
    },
    body: { type: "event_callback", event: { type: "app_mention" } },
    ...overrides,
  } as any);

const createMockResponse = () => {
  const mockResponse = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return mockResponse as any;
};

const createMockApp = () => ({
  init: vi.fn().mockResolvedValue(undefined),
  processEvent: vi.fn().mockResolvedValue(undefined),
});

const createQuietLogger = () => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  setLevel: vi.fn(),
  getLevel: vi.fn(),
  setName: vi.fn(),
});

const generateValidSignature = (
  timestamp: string,
  body: string,
  secret: string
) => {
  const baseString = `v0:${timestamp}:${body}`;
  return `v0=${createHmac("sha256", secret)
    .update(baseString, "utf8")
    .digest("hex")}`;
};

describe("VercelReceiver", () => {
  const SIGNING_SECRET = "test-signing-secret-12345";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("Constructor", () => {
    it("should require a signing secret", () => {
      vi.stubEnv("SLACK_SIGNING_SECRET", "");

      expect(() => new VercelReceiver()).toThrow(
        "SLACK_SIGNING_SECRET is required for VercelReceiver"
      );
    });

    it("should accept signing secret from constructor", () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        logger: createQuietLogger(),
      });
      expect(receiver).toBeInstanceOf(VercelReceiver);
    });

    it("should accept signing secret from environment", () => {
      vi.stubEnv("SLACK_SIGNING_SECRET", SIGNING_SECRET);
      const receiver = new VercelReceiver();
      expect(receiver).toBeInstanceOf(VercelReceiver);
    });

    it("should allow disabling signature verification", () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        signatureVerification: false,
        logger: createQuietLogger(),
      });
      expect(receiver).toBeInstanceOf(VercelReceiver);
    });

    it("should accept custom logger", () => {
      const mockLogger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        setLevel: vi.fn(),
        getLevel: vi.fn(),
        setName: vi.fn(),
      };

      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        logger: mockLogger,
      });

      expect(receiver).toBeInstanceOf(VercelReceiver);
    });

    it("should accept custom properties extractor", () => {
      const customExtractor = vi.fn();
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        customPropertiesExtractor: customExtractor,
      });
      expect(receiver).toBeInstanceOf(VercelReceiver);
    });
  });

  describe("Receiver Lifecycle", () => {
    it("should implement init() method", () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        logger: createQuietLogger(),
      });
      const app = createMockApp() as any;

      expect(() => receiver.init(app)).not.toThrow();
    });

    it("should implement start() method that returns a handler", async () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        logger: createQuietLogger(),
      });

      const handler = await receiver.start();

      expect(handler).toBeInstanceOf(Function);
      expect(handler.length).toBe(2); // req, res
    });

    it("should implement stop() method", async () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        logger: createQuietLogger(),
      });

      await expect(receiver.stop()).resolves.toBeUndefined();
    });

    it("should provide toHandler() method", () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        logger: createQuietLogger(),
      });

      const handler = receiver.toHandler();

      expect(handler).toBeInstanceOf(Function);
      expect(handler.length).toBe(2);
    });
  });

  describe("Request Handling", () => {
    it("should handle URL verification challenge", async () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        signatureVerification: false,
        logger: createQuietLogger(),
      });
      const app = createMockApp() as any;
      receiver.init(app);

      const handler = receiver.toHandler();
      const req = createMockRequest({
        body: { type: "url_verification", challenge: "test-challenge-value" },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        challenge: "test-challenge-value",
      });
      expect(app.processEvent).not.toHaveBeenCalled();
    });

    it("should process regular Slack events", async () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        signatureVerification: false,
        logger: createQuietLogger(),
      });
      const app = createMockApp() as any;

      // Mock event processing to call ack
      app.processEvent.mockImplementation((event: any) => {
        setTimeout(() => event.ack(), 10);
        return Promise.resolve();
      });

      receiver.init(app);

      const handler = receiver.toHandler();
      const req = createMockRequest({
        body: {
          type: "event_callback",
          event: { type: "app_mention", text: "hello" },
        },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(app.processEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          body: {
            type: "event_callback",
            event: { type: "app_mention", text: "hello" },
          },
          ack: expect.any(Function),
        })
      );
    });
  });

  describe("Request Body Parsing", () => {
    let receiver: VercelReceiver;
    let app: any;

    beforeEach(() => {
      receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        signatureVerification: false,
      });
      app = createMockApp();
      app.processEvent.mockImplementation((event: any) => {
        setTimeout(() => event.ack(), 10);
        return Promise.resolve();
      });
      receiver.init(app);
    });

    it("should parse JSON request bodies", async () => {
      const handler = receiver.toHandler();
      const req = createMockRequest({
        headers: { "content-type": "application/json" },
        body: { type: "event_callback", event: { type: "message" } },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(app.processEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { type: "event_callback", event: { type: "message" } },
        })
      );
    });

    it("should parse form-encoded bodies with payload parameter", async () => {
      const handler = receiver.toHandler();
      const payload = JSON.stringify({
        type: "interactive_message",
        callback_id: "test",
      });
      const req = createMockRequest({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `payload=${encodeURIComponent(payload)}`,
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(app.processEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { type: "interactive_message", callback_id: "test" },
        })
      );
    });

    it("should parse form-encoded bodies without payload (slash commands)", async () => {
      const handler = receiver.toHandler();
      const req = createMockRequest({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "command=%2Fhello&text=world&user_id=U123",
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(app.processEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { command: "/hello", text: "world", user_id: "U123" },
        })
      );
    });

    it("should handle string bodies", async () => {
      const handler = receiver.toHandler();
      const req = createMockRequest({
        headers: { "content-type": "application/json" },
        body: '{"type":"event_callback","event":{"type":"app_mention"}}',
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(app.processEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { type: "event_callback", event: { type: "app_mention" } },
        })
      );
    });

    it("should handle buffer bodies", async () => {
      const handler = receiver.toHandler();
      const req = createMockRequest({
        headers: { "content-type": "application/json" },
        body: Buffer.from(
          '{"type":"event_callback","event":{"type":"message"}}'
        ),
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(app.processEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { type: "event_callback", event: { type: "message" } },
        })
      );
    });

    it("should handle empty bodies gracefully", async () => {
      const handler = receiver.toHandler();
      const req = createMockRequest({
        headers: { "content-type": "application/json" },
        body: "",
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "RequestParsingError",
        })
      );
    });

    it("should handle malformed JSON", async () => {
      const handler = receiver.toHandler();
      const req = createMockRequest({
        headers: { "content-type": "application/json" },
        body: "invalid-json",
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "RequestParsingError",
        })
      );
    });
  });

  describe("Signature Verification", () => {
    it("should verify valid signatures", async () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        logger: createQuietLogger(),
      });
      const app = createMockApp() as any;
      app.processEvent.mockImplementation((event: any) => {
        setTimeout(() => event.ack(), 10);
        return Promise.resolve();
      });
      receiver.init(app);

      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = JSON.stringify({
        type: "url_verification",
        challenge: "test",
      });
      const signature = generateValidSignature(timestamp, body, SIGNING_SECRET);

      const handler = receiver.toHandler();
      const req = createMockRequest({
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
        },
        body,
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ challenge: "test" });
    });

    it("should reject invalid signatures", async () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        logger: createQuietLogger(),
      });
      const app = createMockApp() as any;
      receiver.init(app);

      const handler = receiver.toHandler();
      const req = createMockRequest({
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": Math.floor(Date.now() / 1000).toString(),
          "x-slack-signature": "v0=invalid-signature",
        },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SignatureVerificationError",
        })
      );
    });

    it("should reject requests with missing signature headers", async () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        logger: createQuietLogger(),
      });
      const app = createMockApp() as any;
      receiver.init(app);

      const handler = receiver.toHandler();
      const req = createMockRequest({
        headers: { "content-type": "application/json" },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SignatureVerificationError",
        })
      );
    });

    it("should reject requests with stale timestamps", async () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        logger: createQuietLogger(),
      });
      const app = createMockApp() as any;
      receiver.init(app);

      const staleTimestamp = (Math.floor(Date.now() / 1000) - 400).toString(); // 6+ minutes old
      const body = JSON.stringify({ type: "event_callback" });
      const signature = generateValidSignature(
        staleTimestamp,
        body,
        SIGNING_SECRET
      );

      const handler = receiver.toHandler();
      const req = createMockRequest({
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": staleTimestamp,
          "x-slack-signature": signature,
        },
        body,
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SignatureVerificationError",
          error: expect.stringMatching(/stale|differ.*system time.*minutes/i),
        })
      );
    });

    it("should skip verification when disabled", async () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        signatureVerification: false,
        logger: createQuietLogger(),
      });
      const app = createMockApp() as any;
      receiver.init(app);

      const handler = receiver.toHandler();
      const req = createMockRequest({
        headers: { "content-type": "application/json" },
        body: { type: "url_verification", challenge: "test" },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ challenge: "test" });
    });
  });

  describe("Event Processing and Acknowledgment", () => {
    let receiver: VercelReceiver;
    let app: any;

    beforeEach(() => {
      receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        signatureVerification: false,
      });
      app = createMockApp();
      receiver.init(app);
    });

    it("should acknowledge events with string responses", async () => {
      app.processEvent.mockImplementation((event: any) => {
        setTimeout(() => event.ack("OK"), 10);
        return Promise.resolve();
      });

      const handler = receiver.toHandler();
      const req = createMockRequest({
        body: { type: "event_callback", event: { type: "app_mention" } },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith("OK");
    });

    it("should acknowledge events with JSON responses", async () => {
      app.processEvent.mockImplementation((event: any) => {
        setTimeout(() => event.ack({ success: true }), 10);
        return Promise.resolve();
      });

      const handler = receiver.toHandler();
      const req = createMockRequest({
        body: { type: "event_callback", event: { type: "app_mention" } },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    it("should acknowledge events with empty responses", async () => {
      app.processEvent.mockImplementation((event: any) => {
        setTimeout(() => event.ack(), 10);
        return Promise.resolve();
      });

      const handler = receiver.toHandler();
      const req = createMockRequest({
        body: { type: "event_callback", event: { type: "app_mention" } },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith("");
    });

    it("should timeout unacknowledged events", async () => {
      // Don't call ack to simulate timeout
      app.processEvent.mockImplementation(() => Promise.resolve());

      const handler = receiver.toHandler();
      const req = createMockRequest({
        body: { type: "event_callback", event: { type: "app_mention" } },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(408);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "VercelReceiverError",
          error: expect.stringContaining("timeout"),
        })
      );
    }, 5000);

    it("should prevent multiple acknowledgments", async () => {
      let ackFunction: any;
      app.processEvent.mockImplementation((event: any) => {
        ackFunction = event.ack;
        event.ack("First");
        return Promise.resolve();
      });

      const handler = receiver.toHandler();
      const req = createMockRequest({
        body: { type: "event_callback", event: { type: "app_mention" } },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith("First");

      // Attempting to acknowledge again should throw
      await expect(ackFunction("Second")).rejects.toThrow(/multiple/i);
    });

    it("should include retry information in receiver events", async () => {
      app.processEvent.mockImplementation((event: any) => {
        expect(event.retryNum).toBeDefined();
        expect(event.retryReason).toBeDefined();
        setTimeout(() => event.ack(), 10);
        return Promise.resolve();
      });

      const handler = receiver.toHandler();
      const req = createMockRequest({
        headers: {
          ...createMockRequest().headers,
          "x-slack-retry-num": "1",
          "x-slack-retry-reason": "http_timeout",
        },
        body: { type: "event_callback", event: { type: "app_mention" } },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(app.processEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          retryNum: 1,
          retryReason: "http_timeout",
        })
      );
    });
  });

  describe("Custom Properties and Response Handlers", () => {
    it("should use custom properties extractor", async () => {
      const customExtractor = vi
        .fn()
        .mockReturnValue({ userId: "U123", teamId: "T456" });
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        signatureVerification: false,
        customPropertiesExtractor: customExtractor,
        logger: createQuietLogger(),
      });
      const app = createMockApp() as any;

      app.processEvent.mockImplementation((event: any) => {
        expect(event.customProperties).toEqual({
          userId: "U123",
          teamId: "T456",
        });
        setTimeout(() => event.ack(), 10);
        return Promise.resolve();
      });

      receiver.init(app);

      const handler = receiver.toHandler();
      const req = createMockRequest({
        body: { type: "event_callback", event: { type: "app_mention" } },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(customExtractor).toHaveBeenCalledWith(req);
      expect(app.processEvent).toHaveBeenCalled();
    });

    it("should use custom response handler", async () => {
      const customResponseHandler = vi
        .fn()
        .mockResolvedValue(
          createMockResponse().status(201).json({ custom: "response" })
        );

      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        signatureVerification: false,
        customResponseHandler,
        logger: createQuietLogger(),
      });
      const app = createMockApp() as any;

      app.processEvent.mockImplementation((event: any) => {
        setTimeout(() => event.ack({ data: "test" }), 10);
        return Promise.resolve();
      });

      receiver.init(app);

      const handler = receiver.toHandler();
      const req = createMockRequest({
        body: { type: "event_callback", event: { type: "app_mention" } },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(customResponseHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { type: "event_callback", event: { type: "app_mention" } },
        }),
        res
      );
    });
  });

  describe("Error Handling", () => {
    it("should handle app not initialized", async () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        signatureVerification: false,
        logger: createQuietLogger(),
      });
      // Don't call init()

      const handler = receiver.toHandler();
      const req = createMockRequest();
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "VercelReceiverError",
          error: expect.stringContaining("not initialized"),
        })
      );
    });

    it("should handle unexpected errors gracefully", async () => {
      const receiver = new VercelReceiver({
        signingSecret: SIGNING_SECRET,
        signatureVerification: false,
        logger: createQuietLogger(),
      });
      const app = createMockApp() as any;

      // Mock processEvent to throw an error
      app.processEvent.mockRejectedValue(new Error("Unexpected error"));

      receiver.init(app);

      const handler = receiver.toHandler();
      const req = createMockRequest({
        body: { type: "event_callback", event: { type: "app_mention" } },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(408); // Should timeout when ack is never called
    }, 5000);
  });

  describe("createHandler Convenience Function", () => {
    it("should initialize app and create handler", async () => {
      const app = createMockApp() as any;

      app.processEvent.mockImplementation((event: any) => {
        setTimeout(() => event.ack(), 10);
        return Promise.resolve();
      });

      const handler = createHandler(app, {
        signingSecret: SIGNING_SECRET,
        signatureVerification: false,
        logger: createQuietLogger(),
      });

      const req = createMockRequest({
        body: { type: "url_verification", challenge: "test" },
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(app.init).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ challenge: "test" });
    });

    it("should handle app initialization errors", async () => {
      const app = createMockApp() as any;
      app.init.mockRejectedValue(new Error("Init failed"));

      const handler = createHandler(app, {
        signingSecret: SIGNING_SECRET,
        logger: createQuietLogger(),
      });
      const req = createMockRequest();
      const res = createMockResponse();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "HandlerError",
          error: "Internal Server Error",
        })
      );
    });

    it("should reuse app initialization", async () => {
      const app = createMockApp() as any;

      app.processEvent.mockImplementation((event: any) => {
        setTimeout(() => event.ack(), 10);
        return Promise.resolve();
      });

      const handler = createHandler(app, {
        signingSecret: SIGNING_SECRET,
        signatureVerification: false,
        logger: createQuietLogger(),
      });

      const req1 = createMockRequest({
        body: { type: "url_verification", challenge: "test1" },
      });
      const req2 = createMockRequest({
        body: { type: "url_verification", challenge: "test2" },
      });
      const res1 = createMockResponse();
      const res2 = createMockResponse();

      await handler(req1, res1);
      await handler(req2, res2);

      // Init should only be called once
      expect(app.init).toHaveBeenCalledTimes(1);
    });
  });
});
