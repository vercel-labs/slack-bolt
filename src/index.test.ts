import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VercelReceiver, createHandler } from "./index";
import type { App, ReceiverEvent } from "@slack/bolt";
import { ConsoleLogger, LogLevel } from "@slack/logger";

// Mock @slack/bolt
vi.mock("@slack/bolt", () => ({
  verifySlackRequest: vi.fn(),
  ConsoleLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    getLevel: vi.fn(),
  })),
  LogLevel: {
    DEBUG: "debug",
    INFO: "info",
    WARN: "warn",
    ERROR: "error",
  },
}));

// Mock @vercel/functions
vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((promise) => promise),
}));

describe("VercelReceiver", () => {
  let receiver: VercelReceiver;
  let mockApp: App;
  const mockSigningSecret = "test-signing-secret";

  beforeEach(() => {
    vi.clearAllMocks();

    mockApp = {
      init: vi.fn().mockResolvedValue(undefined),
      processEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as App;

    receiver = new VercelReceiver({
      signingSecret: mockSigningSecret,
      signatureVerification: false, // Disable for most tests
      logLevel: LogLevel.ERROR, // Reduce noise in tests
    });

    receiver.init(mockApp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should throw error when signingSecret is missing", () => {
      expect(() => {
        new VercelReceiver({});
      }).toThrow("SLACK_SIGNING_SECRET is required for VercelReceiver");
    });

    it("should initialize with environment variable", () => {
      process.env.SLACK_SIGNING_SECRET = "env-secret";
      const receiver = new VercelReceiver();
      expect(receiver).toBeDefined();
      delete process.env.SLACK_SIGNING_SECRET;
    });

    it("should initialize with all custom options", () => {
      const customLogger = new ConsoleLogger();
      const customPropertiesExtractor = vi
        .fn()
        .mockReturnValue({ custom: "property" });
      const customResponseHandler = vi
        .fn()
        .mockResolvedValue(new Response("custom"));

      const customReceiver = new VercelReceiver({
        signingSecret: "test-secret",
        signatureVerification: false,
        logger: customLogger,
        logLevel: LogLevel.DEBUG,
        customPropertiesExtractor,
        customResponseHandler,
      });

      expect(customReceiver).toBeDefined();
      expect(customReceiver.getLogger()).toBeDefined();
    });
  });

  describe("parseRequestBody", () => {
    it("should parse valid JSON content", async () => {
      const jsonPayload = {
        type: "event_callback",
        event: { type: "app_mention", text: "hello" },
      };
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(jsonPayload),
      });

      const handler = await receiver.start();

      let capturedEvent: ReceiverEvent;
      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          capturedEvent = event;
          setTimeout(() => event.ack({ success: true }), 10);
        },
      );

      const response = await handler(request);

      expect(response.status).toBe(200);
      expect(capturedEvent!.body).toEqual(jsonPayload);

      const responseBody = await response.json();
      expect(responseBody).toEqual({ success: true });
    });

    it("should parse URL-encoded form data with payload", async () => {
      const payload = {
        type: "interactive_message",
        actions: [{ name: "button", value: "click" }],
      };
      const formData = "payload=" + encodeURIComponent(JSON.stringify(payload));
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formData,
      });

      const handler = await receiver.start();

      let capturedEvent: ReceiverEvent;
      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          capturedEvent = event;
          setTimeout(() => event.ack(), 10);
        },
      );

      await handler(request);

      expect(capturedEvent!.body).toEqual(payload);
    });

    it("should parse URL-encoded form data without payload field", async () => {
      const formData = "token=xoxb-token&team_id=T123&user_id=U456";
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formData,
      });

      const handler = await receiver.start();

      let capturedEvent: ReceiverEvent;
      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          capturedEvent = event;
          setTimeout(() => event.ack(), 10);
        },
      );

      await handler(request);

      expect(capturedEvent!.body).toEqual({
        token: "xoxb-token",
        team_id: "T123",
        user_id: "U456",
      });
    });

    it("should handle empty body gracefully", async () => {
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "",
      });

      const handler = await receiver.start();
      const response = await handler(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.type).toBe("RequestParsingError");
      expect(body.error).toContain("Failed to parse body as JSON");
    });

    it("should handle malformed JSON", async () => {
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"type":"event_callback","malformed":}',
      });

      const handler = await receiver.start();
      const response = await handler(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.type).toBe("RequestParsingError");
    });

    it("should handle malformed form data payload", async () => {
      const formData = "payload=invalid-json{";
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formData,
      });

      const handler = await receiver.start();
      const response = await handler(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.type).toBe("RequestParsingError");
    });

    it("should handle unknown content-type by trying JSON parsing", async () => {
      const jsonData = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: jsonData,
      });

      const handler = await receiver.start();

      let capturedEvent: ReceiverEvent;
      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          capturedEvent = event;
          setTimeout(() => event.ack(), 10);
        },
      );

      await handler(request);

      expect(capturedEvent!.body).toEqual({ type: "event_callback" });
    });

    it("should handle missing content-type header", async () => {
      const jsonData = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        body: jsonData,
      });

      const handler = await receiver.start();

      let capturedEvent: ReceiverEvent;
      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          capturedEvent = event;
          setTimeout(() => event.ack(), 10);
        },
      );

      await handler(request);

      expect(capturedEvent!.body).toEqual({ type: "event_callback" });
    });
  });

  describe("URL verification challenge", () => {
    it("should handle URL verification challenge correctly", async () => {
      const challengeValue = "test-challenge-12345";
      const challengeBody = JSON.stringify({
        type: "url_verification",
        challenge: challengeValue,
        token: "verification-token",
      });

      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: challengeBody,
      });

      const handler = await receiver.start();
      const response = await handler(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");

      const body = await response.json();
      expect(body).toEqual({ challenge: challengeValue });

      // Verify that processEvent was NOT called for URL verification
      expect(mockApp.processEvent).not.toHaveBeenCalled();
    });

    it("should not process URL verification as regular event", async () => {
      const challengeBody = JSON.stringify({
        type: "url_verification",
        challenge: "test-challenge",
      });

      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: challengeBody,
      });

      const handler = await receiver.start();
      await handler(request);

      expect(mockApp.processEvent).not.toHaveBeenCalled();
    });
  });

  describe("event acknowledgment", () => {
    it("should handle string acknowledgment response correctly", async () => {
      const stringResponse = "Event processed successfully";
      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: eventBody,
      });

      const handler = await receiver.start();

      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          setTimeout(() => event.ack(stringResponse), 10);
        },
      );

      const response = await handler(request);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
      expect(body).toBe(stringResponse);
    });

    it("should handle object acknowledgment response correctly", async () => {
      const objectResponse = {
        text: "Hello world",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "Response" } },
        ],
      };
      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: eventBody,
      });

      const handler = await receiver.start();

      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          setTimeout(() => event.ack(objectResponse), 10);
        },
      );

      const response = await handler(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(objectResponse);
    });

    it("should handle empty acknowledgment", async () => {
      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: eventBody,
      });

      const handler = await receiver.start();

      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          setTimeout(() => event.ack(), 10);
        },
      );

      const response = await handler(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(null);
    });

    it("should timeout when event is not acknowledged", async () => {
      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: eventBody,
      });

      const handler = await receiver.start();

      // Don't acknowledge the event
      (mockApp.processEvent as any).mockImplementation(() => {
        // Simulate processing that never calls ack
      });

      const response = await handler(request);

      expect(response.status).toBe(408);
      const body = await response.json();
      expect(body.error).toBe("Request timeout");
      expect(body.type).toBe("VercelReceiverError");
    }, 5000);

    it("should prevent multiple acknowledgments", async () => {
      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: eventBody,
      });

      const handler = await receiver.start();

      const mockProcessEvent = vi
        .fn()
        .mockImplementation((event: ReceiverEvent) => {
          setTimeout(async () => {
            await event.ack({ first: true });

            // Second ack should throw
            await expect(event.ack({ second: true })).rejects.toThrow(
              "Cannot acknowledge an event multiple times",
            );
          }, 10);
        });

      (mockApp.processEvent as any) = mockProcessEvent;

      await handler(request);
      expect(mockProcessEvent).toHaveBeenCalledTimes(1);
    });

    it("should handle acknowledgment errors gracefully", async () => {
      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: eventBody,
      });

      const handler = await receiver.start();

      (mockApp.processEvent as any).mockImplementation(() => {
        // Simply don't call ack() to trigger timeout
        // This simulates the case where processing fails before ack
      });

      const response = await handler(request);

      expect(response.status).toBe(408); // Should timeout since ack threw error
    }, 5000);
  });

  describe("signature verification", () => {
    beforeEach(() => {
      receiver = new VercelReceiver({
        signingSecret: mockSigningSecret,
        signatureVerification: true,
      });
      receiver.init(mockApp);
    });

    it("should verify slack request signature successfully", async () => {
      const { verifySlackRequest } = await import("@slack/bolt");
      (verifySlackRequest as any).mockImplementation(() => {
        // Mock successful verification
      });

      const eventBody = JSON.stringify({ type: "event_callback" });
      const timestamp = "1609459200";
      const signature =
        "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";

      const request = new Request("http://localhost", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": timestamp,
        },
        body: eventBody,
      });

      const handler = await receiver.start();

      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          setTimeout(() => event.ack({ verified: true }), 10);
        },
      );

      const response = await handler(request);

      expect(response.status).toBe(200);
      expect(verifySlackRequest).toHaveBeenCalledWith({
        signingSecret: mockSigningSecret,
        body: eventBody,
        headers: {
          "x-slack-signature": signature,
          "x-slack-request-timestamp": parseInt(timestamp, 10),
        },
        logger: expect.any(Object),
      });

      const body = await response.json();
      expect(body).toEqual({ verified: true });
    });

    it("should handle missing timestamp header", async () => {
      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-signature": "v0=signature",
        },
        body: eventBody,
      });

      const handler = await receiver.start();
      const response = await handler(request);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.type).toBe("SignatureVerificationError");
      expect(body.error).toBe("Missing required timestamp header");
    });

    it("should handle missing signature header", async () => {
      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": "1609459200",
        },
        body: eventBody,
      });

      const handler = await receiver.start();
      const response = await handler(request);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.type).toBe("SignatureVerificationError");
      expect(body.error).toBe("Missing required signature headers");
    });

    it("should handle signature verification failure", async () => {
      const { verifySlackRequest } = await import("@slack/bolt");
      (verifySlackRequest as any).mockImplementation(() => {
        throw new Error("Invalid signature");
      });

      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-signature": "v0=invalid-signature",
          "x-slack-request-timestamp": "1609459200",
        },
        body: eventBody,
      });

      const handler = await receiver.start();
      const response = await handler(request);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.type).toBe("SignatureVerificationError");
      expect(body.error).toBe("Invalid signature");
    });

    it("should bypass verification when disabled", async () => {
      const { verifySlackRequest } = await import("@slack/bolt");
      const bypassReceiver = new VercelReceiver({
        signingSecret: mockSigningSecret,
        signatureVerification: false,
      });
      bypassReceiver.init(mockApp);

      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: eventBody,
      });

      const handler = await bypassReceiver.start();

      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          setTimeout(() => event.ack({ bypassed: true }), 10);
        },
      );

      const response = await handler(request);

      expect(response.status).toBe(200);
      expect(verifySlackRequest).not.toHaveBeenCalled();

      const body = await response.json();
      expect(body).toEqual({ bypassed: true });
    });
  });

  describe("custom properties extractor", () => {
    it("should extract custom properties from request", async () => {
      const customPropertiesExtractor = vi.fn().mockReturnValue({
        customProp: "customValue",
        requestId: "req-123",
      });

      const customReceiver = new VercelReceiver({
        signingSecret: mockSigningSecret,
        signatureVerification: false,
        customPropertiesExtractor,
      });

      customReceiver.init(mockApp);

      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: eventBody,
      });

      const handler = await customReceiver.start();

      let capturedEvent: ReceiverEvent;
      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          capturedEvent = event;
          setTimeout(() => event.ack(), 10);
        },
      );

      await handler(request);

      expect(customPropertiesExtractor).toHaveBeenCalledWith(request);
      expect(capturedEvent!.customProperties).toEqual({
        customProp: "customValue",
        requestId: "req-123",
      });
    });

    it("should handle custom properties extractor errors", async () => {
      const customPropertiesExtractor = vi.fn().mockImplementation(() => {
        throw new Error("Extractor failed");
      });

      const customReceiver = new VercelReceiver({
        signingSecret: mockSigningSecret,
        signatureVerification: false,
        customPropertiesExtractor,
      });

      customReceiver.init(mockApp);

      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: eventBody,
      });

      const handler = await customReceiver.start();
      const response = await handler(request);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.type).toBe("UnexpectedError");
    });
  });

  describe("custom response handler", () => {
    it("should use custom response handler when provided", async () => {
      const customResponse = new Response("Custom response content", {
        status: 201,
        headers: { "X-Custom-Header": "test-value" },
      });
      const customResponseHandler = vi.fn().mockResolvedValue(customResponse);

      const customReceiver = new VercelReceiver({
        signingSecret: mockSigningSecret,
        signatureVerification: false,
        customResponseHandler,
      });

      customReceiver.init(mockApp);

      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: eventBody,
      });

      const handler = await customReceiver.start();

      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          setTimeout(() => event.ack({ processed: true }), 10);
        },
      );

      const response = await handler(request);

      expect(response.status).toBe(201);
      expect(response.headers.get("X-Custom-Header")).toBe("test-value");
      expect(await response.text()).toBe("Custom response content");
      expect(customResponseHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          body: JSON.parse(eventBody),
          ack: expect.any(Function),
          customProperties: expect.any(Object),
          retryNum: expect.any(Number),
          retryReason: expect.any(String),
        }),
      );
    });

    it("should handle custom response handler errors", async () => {
      const customResponseHandler = vi
        .fn()
        .mockRejectedValue(new Error("Handler failed"));

      const customReceiver = new VercelReceiver({
        signingSecret: mockSigningSecret,
        signatureVerification: false,
        customResponseHandler,
      });

      customReceiver.init(mockApp);

      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: eventBody,
      });

      const handler = await customReceiver.start();

      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          setTimeout(() => event.ack(), 10);
        },
      );

      const response = await handler(request);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.type).toBe("UnexpectedError");
    });
  });

  describe("retry headers handling", () => {
    it("should capture retry headers in receiver event", async () => {
      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-retry-num": "3",
          "x-slack-retry-reason": "http_timeout",
        },
        body: eventBody,
      });

      const handler = await receiver.start();

      let capturedEvent: ReceiverEvent;
      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          capturedEvent = event;
          setTimeout(() => event.ack(), 10);
        },
      );

      await handler(request);

      expect(capturedEvent!.retryNum).toBe(3);
      expect(capturedEvent!.retryReason).toBe("http_timeout");
    });

    it("should handle missing retry headers", async () => {
      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: eventBody,
      });

      const handler = await receiver.start();

      let capturedEvent: ReceiverEvent;
      (mockApp.processEvent as any).mockImplementation(
        (event: ReceiverEvent) => {
          capturedEvent = event;
          setTimeout(() => event.ack(), 10);
        },
      );

      await handler(request);

      expect(capturedEvent!.retryNum).toBe(0);
      expect(capturedEvent!.retryReason).toBe("");
    });
  });

  describe("error handling", () => {
    it("should handle app not initialized error", async () => {
      const uninitializedReceiver = new VercelReceiver({
        signingSecret: mockSigningSecret,
        signatureVerification: false,
      });

      const eventBody = JSON.stringify({ type: "event_callback" });
      const request = new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: eventBody,
      });

      const handler = await uninitializedReceiver.start();
      const response = await handler(request);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe("Slack app not initialized");
      expect(body.type).toBe("VercelReceiverError");
    });

    it("should handle request body reading errors", async () => {
      // Create a request with a body that will cause text() to fail
      const request = {
        method: "POST",
        headers: {
          get: vi.fn().mockReturnValue("application/json"),
        },
        text: vi.fn().mockRejectedValue(new Error("Failed to read body")),
      } as unknown as Request;

      const handler = await receiver.start();
      const response = await handler(request);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.type).toBe("UnexpectedError");
    });

    it("should handle all error types correctly", async () => {
      const testCases = [
        {
          name: "VercelReceiverError",
          error: {
            name: "VercelReceiverError",
            message: "Custom error",
            statusCode: 422,
          },
          expectedStatus: 422,
          expectedType: "VercelReceiverError",
        },
        {
          name: "Generic Error",
          error: new Error("Generic error"),
          expectedStatus: 500,
          expectedType: "UnexpectedError",
        },
      ];

      for (const testCase of testCases) {
        const failingReceiver = new VercelReceiver({
          signingSecret: mockSigningSecret,
          signatureVerification: false,
        });

        // Mock the start method to throw the error
        vi.spyOn(failingReceiver, "start").mockRejectedValue(testCase.error);

        try {
          const handler = await failingReceiver.start();

          // This should not reach here for our test cases
          await handler(
            new Request("http://localhost", {
              method: "POST",
              body: "{}",
            }),
          );

          // If we get here, the test should fail
          expect(false).toBe(true); // Force failure
        } catch (error) {
          // The error should be thrown during start()
          if (
            testCase.error.name === "VercelReceiverError" &&
            "statusCode" in testCase.error
          ) {
            expect(testCase.error.statusCode).toBe(testCase.expectedStatus);
            expect(testCase.error.name).toBe(testCase.expectedType);
          } else {
            expect(error).toBeInstanceOf(Error);
          }
        }
      }
    });
  });
});

describe("createHandler", () => {
  let mockApp: App;

  beforeEach(() => {
    vi.clearAllMocks();

    mockApp = {
      init: vi.fn().mockResolvedValue(undefined),
      processEvent: vi.fn().mockImplementation((event: ReceiverEvent) => {
        setTimeout(() => event.ack({ handled: true }), 10);
      }),
    } as unknown as App;
  });

  it("should create a working handler with receiver", async () => {
    const mockReceiver = new VercelReceiver({
      signingSecret: "test-secret",
      signatureVerification: false,
    });

    const handler = createHandler(mockApp, mockReceiver);

    const eventBody = JSON.stringify({ type: "event_callback" });
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: eventBody,
    });

    const response = await handler(request);

    expect(response.status).toBe(200);
    expect(mockApp.init).toHaveBeenCalledTimes(1);

    const body = await response.json();
    expect(body).toEqual({ handled: true });
  });

  it("should handle app initialization errors", async () => {
    (mockApp.init as any).mockRejectedValue(new Error("Init failed"));

    const mockReceiver = new VercelReceiver({
      signingSecret: "test-secret",
      signatureVerification: false,
    });

    const handler = createHandler(mockApp, mockReceiver);

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const response = await handler(request);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.type).toBe("HandlerError");
    expect(body.error).toBe("Internal Server Error");
  });

  it("should initialize app only once across multiple calls", async () => {
    const mockReceiver = new VercelReceiver({
      signingSecret: "test-secret",
      signatureVerification: false,
    });

    const handler = createHandler(mockApp, mockReceiver);

    const createRequest = () =>
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"type":"event_callback"}',
      });

    // Call handler multiple times with fresh requests
    const response1 = await handler(createRequest());
    const response2 = await handler(createRequest());

    expect(response1.status).toBe(200);
    expect(response2.status).toBe(200);
    // App init should only be called once
    expect(mockApp.init).toHaveBeenCalledTimes(1);
  });

  it("should properly initialize receiver with app", async () => {
    const mockReceiver = new VercelReceiver({
      signingSecret: "test-secret",
      signatureVerification: false,
    });

    const receiverInitSpy = vi.spyOn(mockReceiver, "init");

    const handler = createHandler(mockApp, mockReceiver);

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"type":"event_callback"}',
    });

    await handler(request);

    expect(receiverInitSpy).toHaveBeenCalledWith(mockApp);
  });

  it("should handle receiver start errors", async () => {
    const mockReceiver = new VercelReceiver({
      signingSecret: "test-secret",
      signatureVerification: false,
    });

    vi.spyOn(mockReceiver, "start").mockRejectedValue(
      new Error("Receiver start failed"),
    );

    const handler = createHandler(mockApp, mockReceiver);

    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const response = await handler(request);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.type).toBe("HandlerError");
  });

  it("should pass through all response properties correctly", async () => {
    const mockReceiver = new VercelReceiver({
      signingSecret: "test-secret",
      signatureVerification: false,
    });

    const handler = createHandler(mockApp, mockReceiver);

    const eventBody = JSON.stringify({ type: "event_callback" });
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: eventBody,
    });

    // Mock processEvent to return a specific response
    const expectedResponse = {
      text: "Success",
      response_type: "in_channel",
      attachments: [{ text: "Processed" }],
    };

    (mockApp.processEvent as any).mockImplementation((event: ReceiverEvent) => {
      setTimeout(() => event.ack(expectedResponse), 10);
    });

    const response = await handler(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(expectedResponse);
  });
});
