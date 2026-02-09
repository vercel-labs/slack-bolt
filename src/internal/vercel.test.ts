import { describe, expect, it } from "vitest";
import { SlackAppNotFoundError, VercelApiError } from "./errors";

// ---------------------------------------------------------------------------
// VercelApiError
// ---------------------------------------------------------------------------

describe("VercelApiError", () => {
  it("is an instance of Error", () => {
    const err = new VercelApiError("test error", 403);
    expect(err).toBeInstanceOf(Error);
  });

  it("carries statusCode and message", () => {
    const err = new VercelApiError("Not authorized", 403);
    expect(err.message).toBe("Not authorized");
    expect(err.statusCode).toBe(403);
    expect(err.name).toBe("VercelApiError");
  });

  it("is distinguishable via instanceof", () => {
    const err: Error = new VercelApiError("forbidden", 403);
    expect(err instanceof VercelApiError).toBe(true);
    expect(err instanceof SlackAppNotFoundError).toBe(false);
  });

  it("handles zero statusCode for unknown errors", () => {
    const err = new VercelApiError("network failure", 0);
    expect(err.statusCode).toBe(0);
    expect(err.message).toBe("network failure");
  });
});
