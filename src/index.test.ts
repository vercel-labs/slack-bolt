import { VercelReceiver } from "./index.js";
import { expect, vi, describe, afterEach, it } from "vitest";

describe("VercelReceiver", () => {
  const ENV_TEST_SECRET = "env-test-secret";
  const PARAM_TEST_SECRET = "param-test-secret";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("constructor", () => {
    it("Instantiates with signing secret provided in constructor", () => {
      vi.stubEnv("SLACK_SIGNING_SECRET", PARAM_TEST_SECRET);

      const receiver = new VercelReceiver({
        signingSecret: process.env.SLACK_SIGNING_SECRET,
      });

      expect(receiver).toBeInstanceOf(VercelReceiver);
    });

    it("Instantiates with signing secret from environment variable", () => {
      vi.stubEnv("SLACK_SIGNING_SECRET", ENV_TEST_SECRET);

      const receiver = new VercelReceiver();

      expect(receiver).toBeInstanceOf(VercelReceiver);
    });

    it("Throws an error when no signing secret is provided", () => {
      vi.stubEnv("SLACK_SIGNING_SECRET", "");

      expect(() => {
        new VercelReceiver();
      }).toThrow("SLACK_SIGNING_SECRET is required");
    });

    it("Overrides the signing secret with the one provided in the constructor", () => {
      vi.stubEnv("SLACK_SIGNING_SECRET", ENV_TEST_SECRET);

      const receiver = new VercelReceiver({
        signingSecret: PARAM_TEST_SECRET,
      });

      // biome-ignore lint/suspicious/noExplicitAny: this is a private property, but we need to test it
      expect((receiver as any).signingSecret).toBe(PARAM_TEST_SECRET);
      expect(process.env.SLACK_SIGNING_SECRET).toBe(ENV_TEST_SECRET);
      expect(receiver).toBeInstanceOf(VercelReceiver);
    });
  });

  describe("start", () => {
    it("returns a Promise that resolves to a handler function", async () => {
      vi.stubEnv("SLACK_SIGNING_SECRET", ENV_TEST_SECRET);
      const receiver = new VercelReceiver();

      const result = receiver.start();

      expect(result).toBeInstanceOf(Promise);

      const handler = await result;
      expect(handler).toBeInstanceOf(Function);
      expect(handler.length).toBe(2);
    });
  });

  describe("stop", () => {
    it("returns a resolved Promise when stop() is called", async () => {
      vi.stubEnv("SLACK_SIGNING_SECRET", ENV_TEST_SECRET);
      const receiver = new VercelReceiver();

      const result = receiver.stop();

      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });
  });

  describe("toHandler", () => {
    it("returns a function that accepts 2 parameters: req, res", () => {
      vi.stubEnv("SLACK_SIGNING_SECRET", ENV_TEST_SECRET);
      const receiver = new VercelReceiver();

      const result = receiver.toHandler();

      expect(result).toBeInstanceOf(Function);
      expect(result.length).toBe(2);
    });
  });
});
