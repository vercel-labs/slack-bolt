import { afterEach, describe, expect, it, vi } from "vitest";
import { logTo } from "./log";
import { forgetSecrets, scrub, scrubError, secret, token } from "./secrets";

afterEach(forgetSecrets);

describe("scrub", () => {
  it("takes out every value it was told is secret", () => {
    secret("signing-secret-value");

    expect(scrub("got signing-secret-value, twice: signing-secret-value")).toBe(
      "got [redacted], twice: [redacted]",
    );
  });

  it("takes out a secret that contains another whole", () => {
    secret("abcdefgh");
    secret("abcdefgh-and-more");

    expect(scrub("abcdefgh-and-more")).toBe("[redacted]");
  });

  it("doesn't take a short value for a secret: it would match ordinary words", () => {
    expect(secret("preview")).toBe("preview");
    expect(secret(undefined)).toBeUndefined();

    expect(scrub("a preview deployment")).toBe("a preview deployment");
  });

  it.each([
    ["a bot token", "xoxb-123-456-abc"],
    ["a user token", "xoxp-123-456-abc"],
    ["an app-level token", "xapp-1-A123-456-abc"],
    ["a configuration token", "xoxe.xoxp-1-abc"],
    ["a refresh token", "xoxe-1-abc"],
    ["a Vercel token", "vcp_0123456789abcdef0123"],
  ])("takes out %s it was never told about", (_, value) => {
    expect(scrub(`sent "${value}" to it`)).toBe('sent "[redacted]" to it');
  });

  it("takes the bypass secret out of a URL", () => {
    expect(
      scrub(
        'url "https://x.vercel.app/a?b=1&x-vercel-protection-bypass=s3cret&c=2"',
      ),
    ).toBe(
      'url "https://x.vercel.app/a?b=1&x-vercel-protection-bypass=[redacted]&c=2"',
    );
  });

  it("leaves everything else as it was", () => {
    const text = "Created Slack app A0123 (Acme (feature-login)) for prj_1";

    expect(scrub(text)).toBe(text);
  });
});

describe("token", () => {
  it("drops what a paste leaves around a token, and keeps both out of print", () => {
    expect(token("NAME", "  vercel-api-token-0001\n")).toBe(
      "vercel-api-token-0001",
    );
    expect(scrub("  vercel-api-token-0001\n|vercel-api-token-0001")).toBe(
      "[redacted]|[redacted]",
    );
  });

  it("has nothing to say about a token that isn't set", () => {
    expect(token("NAME", undefined)).toBeUndefined();
    expect(token("NAME", "")).toBeUndefined();
  });

  it.each([
    ["a space", "vercel api token"],
    ["a line break", "vercel-api\ntoken"],
    ["a character outside ASCII", "vercel-tökën-0001"],
  ])("refuses a token with %s in it, without repeating it", (_, value) => {
    expect(() => token("VERCEL_API_TOKEN", value)).toThrow(
      "VERCEL_API_TOKEN has a space, line break or non-ASCII character in it, so it isn't a valid token\nCopy it again in one piece and save it.",
    );
    expect(scrub(value)).toBe("[redacted]");
  });
});

describe("scrubError", () => {
  it("scrubs an error and everything that caused it", () => {
    secret("hunter2-hunter2");
    const root = new Error("root hunter2-hunter2");
    const middle = new Error("middle hunter2-hunter2", { cause: root });
    const error = new Error("top hunter2-hunter2", { cause: middle });

    expect(scrubError(error)).toBe(error);
    expect([error.message, middle.message, root.message]).toEqual([
      "top [redacted]",
      "middle [redacted]",
      "root [redacted]",
    ]);
  });

  it("stops at a cause that isn't an error, and at one it has seen", () => {
    const loop = new Error("loop");
    loop.cause = loop;

    expect(scrubError(loop)).toBe(loop);
    expect(scrubError(new Error("text", { cause: "why" }))).toBeInstanceOf(
      Error,
    );
    expect(scrubError("thrown")).toBe("thrown");
  });
});

describe("logTo", () => {
  it("scrubs what it passes on, and puts details under their line", () => {
    secret("hunter2-hunter2");
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const log = logTo(logger);

    log.ok("did hunter2-hunter2");
    log.note("about hunter2-hunter2");
    log.warn("careful hunter2-hunter2");
    log.debug("sent hunter2-hunter2");

    expect(logger.info.mock.calls).toEqual([
      ["did [redacted]"],
      ["  about [redacted]"],
    ]);
    expect(logger.warn).toHaveBeenCalledWith("careful [redacted]");
    expect(logger.debug).toHaveBeenCalledWith("sent [redacted]");
  });

  it("says nothing without a logger, or without one that takes debug lines", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };

    expect(() => {
      logTo(undefined).ok("nobody hears this");
      logTo(logger).debug("nor this");
    }).not.toThrow();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
