import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { c, log, redact } from "./logger";

// ---------------------------------------------------------------------------
// redact
// ---------------------------------------------------------------------------

describe("redact", () => {
  it('returns "<not set>" for undefined', () => {
    expect(redact(undefined)).toBe("<not set>");
  });

  it('returns "<not set>" for null', () => {
    expect(redact(null)).toBe("<not set>");
  });

  it('returns "<not set>" for empty string', () => {
    expect(redact("")).toBe("<not set>");
  });

  it('returns "***" for strings with 4 or fewer characters', () => {
    expect(redact("abcd")).toBe("***");
    expect(redact("abc")).toBe("***");
    expect(redact("a")).toBe("***");
  });

  it("shows last 4 chars and length for longer strings", () => {
    expect(redact("xoxb-my-secret-token")).toBe("...oken (20 chars)");
  });

  it("works with exactly 5 characters", () => {
    expect(redact("abcde")).toBe("...bcde (5 chars)");
  });
});

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

describe("log", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    log._debug = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("header() logs the Vercel Slack Bolt banner", () => {
    log.header();
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0]).toContain("Vercel Slack Bolt");
  });

  it("task() logs with a 2-space prefix for alignment", () => {
    log.task("Loading manifest...");
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0]).toBe("  Loading manifest...");
  });

  it("info() logs a label: value pair", () => {
    log.info("Branch", "main");
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0]).toContain("Branch");
    expect(logSpy.mock.calls[0][0]).toContain("main");
  });

  it("success() logs with a check mark", () => {
    log.success("Done");
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0]).toContain("✓");
    expect(logSpy.mock.calls[0][0]).toContain("Done");
  });

  it("warn() logs with a warning symbol", () => {
    log.warn("Careful");
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0]).toContain("⚠");
    expect(logSpy.mock.calls[0][0]).toContain("Careful");
  });

  it("error() writes to stderr", () => {
    log.error("Something broke");
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain("Something broke");
  });

  it("skip() logs with a skip indicator", () => {
    log.skip("Skipped step");
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0]).toContain("○");
    expect(logSpy.mock.calls[0][0]).toContain("Skipped step");
  });

  // ── debug ───────────────────────────────────────────────────────────────

  it("debug() is silent when _debug is false", () => {
    log._debug = false;
    log.debug("should not appear");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("debug() logs when _debug is true with aligned prefix", () => {
    log._debug = true;
    log.debug("verbose info");
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0]).toContain("  [debug]");
    expect(logSpy.mock.calls[0][0]).toContain("verbose info");
  });

  // ── tree ────────────────────────────────────────────────────────────────

  it("tree() logs one line per item with box-drawing prefixes", () => {
    log.tree([
      { label: "App ID", value: "A123" },
      { label: "Branch", value: "main" },
      { label: "URL", value: "https://example.com" },
    ]);
    expect(logSpy).toHaveBeenCalledTimes(3);
    expect(logSpy.mock.calls[0][0]).toContain("┌");
    expect(logSpy.mock.calls[0][0]).toContain("A123");
    expect(logSpy.mock.calls[1][0]).toContain("├");
    expect(logSpy.mock.calls[1][0]).toContain("main");
    expect(logSpy.mock.calls[2][0]).toContain("└");
    expect(logSpy.mock.calls[2][0]).toContain("https://example.com");
  });

  it("tree() with a single item uses ┌ prefix", () => {
    log.tree([{ label: "Only", value: "one" }]);
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0][0]).toContain("┌");
    expect(logSpy.mock.calls[0][0]).toContain("one");
  });

  it("tree() pads labels to align values", () => {
    log.tree([
      { label: "A", value: "short" },
      { label: "Longer label", value: "val" },
    ]);
    // The shorter label should be padded to match the longer one
    const firstLine = logSpy.mock.calls[0][0] as string;
    // "A" is padded to 12 chars to match "Longer label"
    expect(firstLine).toContain("A           ");
  });
});

// ---------------------------------------------------------------------------
// c (color constants)
// ---------------------------------------------------------------------------

describe("c", () => {
  it("exports the expected color keys", () => {
    expect(c).toHaveProperty("reset");
    expect(c).toHaveProperty("bold");
    expect(c).toHaveProperty("dim");
    expect(c).toHaveProperty("green");
    expect(c).toHaveProperty("yellow");
    expect(c).toHaveProperty("cyan");
  });
});
