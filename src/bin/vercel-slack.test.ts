import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks – these are available inside vi.mock() factories which are
// hoisted above imports by vitest.
// ---------------------------------------------------------------------------

const { mockSetupSlackPreview, mockExistsSync } = vi.hoisted(() => ({
  mockSetupSlackPreview: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: { existsSync: mockExistsSync },
}));

vi.mock("../preview.js", () => ({
  setupSlackPreview: mockSetupSlackPreview,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Import the CLI module (which immediately calls `main()`) and wait for the
 *  async `.catch()` chain to settle. Each call should be preceded by
 *  `vi.resetModules()` so the module re-executes from scratch. */
async function runCLI(args: string[]) {
  process.argv = ["node", "vercel-slack", ...args];
  await import("./vercel-slack.js");
  // Flush the microtask queue so `main().catch(…)` settles.
  await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("vercel-slack CLI", () => {
  let originalArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let loadEnvFileSpy: ReturnType<typeof vi.fn>;

  // Each dynamic import adds SIGTERM/SIGINT listeners; raise the limit to
  // avoid the MaxListenersExceededWarning during the test run.
  const originalMaxListeners = process.getMaxListeners();
  process.setMaxListeners(50);

  afterAll(() => {
    process.setMaxListeners(originalMaxListeners);
  });

  beforeEach(() => {
    vi.resetModules();
    originalArgv = process.argv;

    // Provide the build-time constant that tsup normally injects.
    vi.stubGlobal("__PKG_VERSION__", "1.0.0-test");

    // Mock process.exit as a no-op so we can inspect calls without killing
    // the test runner.  Code after process.exit() will continue to run;
    // assertions target the *first* call.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    processOnSpy = vi.spyOn(process, "on");

    // process.loadEnvFile may not exist in all Node versions; ensure it's
    // always mockable.
    loadEnvFileSpy = vi.fn();
    (process as unknown as Record<string, unknown>).loadEnvFile =
      loadEnvFileSpy;

    // Default: .env.local does not exist, setupSlackPreview resolves.
    mockExistsSync.mockReturnValue(false);
    mockSetupSlackPreview.mockReset().mockResolvedValue({
      status: "updated",
      appId: "A_DEFAULT",
      warnings: [],
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // =========================================================================
  // 1. .env.local loading
  // =========================================================================

  describe(".env.local loading", () => {
    it("calls process.loadEnvFile when .env.local exists", async () => {
      mockExistsSync.mockReturnValue(true);
      await runCLI(["--help"]);

      expect(mockExistsSync).toHaveBeenCalledWith(".env.local");
      expect(loadEnvFileSpy).toHaveBeenCalledWith(".env.local");
    });

    it("does not call process.loadEnvFile when .env.local is missing", async () => {
      mockExistsSync.mockReturnValue(false);
      await runCLI(["--help"]);

      expect(mockExistsSync).toHaveBeenCalledWith(".env.local");
      expect(loadEnvFileSpy).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. Signal handlers
  // =========================================================================

  describe("signal handlers", () => {
    it("registers a SIGTERM handler", async () => {
      await runCLI(["--help"]);

      expect(processOnSpy).toHaveBeenCalledWith(
        "SIGTERM",
        expect.any(Function),
      );
    });

    it("registers a SIGINT handler", async () => {
      await runCLI(["--help"]);

      expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    });

    it("SIGTERM handler calls process.exit(0)", async () => {
      await runCLI(["--help"]);

      // Find the SIGTERM handler that was registered
      const sigtermCall = processOnSpy.mock.calls.find(
        (call) => call[0] === "SIGTERM",
      );
      expect(sigtermCall).toBeDefined();

      // Reset exit spy to isolate the handler's call
      exitSpy.mockClear();
      const handler = sigtermCall?.[1] as () => void;
      handler();

      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("SIGINT handler calls process.exit(0)", async () => {
      await runCLI(["--help"]);

      const sigintCall = processOnSpy.mock.calls.find(
        (call) => call[0] === "SIGINT",
      );
      expect(sigintCall).toBeDefined();

      exitSpy.mockClear();
      const handler = sigintCall?.[1] as () => void;
      handler();

      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  // =========================================================================
  // 3. --version / -v
  // =========================================================================

  describe("--version / -v", () => {
    it("prints the version string and exits 0 for --version", async () => {
      await runCLI(["--version"]);

      expect(logSpy).toHaveBeenCalledWith("1.0.0-test");
      expect(exitSpy).toHaveBeenCalledWith(0);
      // The first exit call should be 0 (not 1 from fall-through)
      expect(exitSpy.mock.calls[0]?.[0]).toBe(0);
    });

    it("prints the version string and exits 0 for -v", async () => {
      await runCLI(["-v"]);

      expect(logSpy).toHaveBeenCalledWith("1.0.0-test");
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(exitSpy.mock.calls[0]?.[0]).toBe(0);
    });

    it("does not call setupSlackPreview", async () => {
      await runCLI(["--version"]);

      expect(mockSetupSlackPreview).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. --help / -h / no args
  // =========================================================================

  describe("--help / -h / no args", () => {
    it("prints help text and exits 0 for --help", async () => {
      await runCLI(["--help"]);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Usage: vercel-slack"),
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(exitSpy.mock.calls[0]?.[0]).toBe(0);
    });

    it("prints help text and exits 0 for -h", async () => {
      await runCLI(["-h"]);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Usage: vercel-slack"),
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(exitSpy.mock.calls[0]?.[0]).toBe(0);
    });

    it("prints help text and exits 0 when no command is given", async () => {
      await runCLI([]);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Usage: vercel-slack"),
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(exitSpy.mock.calls[0]?.[0]).toBe(0);
    });

    it("help text documents the build command", async () => {
      await runCLI(["--help"]);

      const helpOutput = logSpy.mock.calls[0]?.[0] as string;
      expect(helpOutput).toContain("build");
    });

    it("help text documents key options", async () => {
      await runCLI(["--help"]);

      const helpOutput = logSpy.mock.calls[0]?.[0] as string;
      expect(helpOutput).toContain("--manifest");
      expect(helpOutput).toContain("--debug");
      expect(helpOutput).toContain("--version");
      expect(helpOutput).toContain("--help");
    });

    it("does not call setupSlackPreview", async () => {
      await runCLI(["--help"]);

      expect(mockSetupSlackPreview).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. build command
  // =========================================================================

  describe("build command", () => {
    it("calls setupSlackPreview with default options", async () => {
      await runCLI(["build"]);

      expect(mockSetupSlackPreview).toHaveBeenCalledWith({
        manifestPath: undefined,
        debug: false,
      });
    });

    it("passes --manifest path to setupSlackPreview", async () => {
      await runCLI(["build", "--manifest", "custom/manifest.json"]);

      expect(mockSetupSlackPreview).toHaveBeenCalledWith(
        expect.objectContaining({ manifestPath: "custom/manifest.json" }),
      );
    });

    it("passes --debug flag to setupSlackPreview", async () => {
      await runCLI(["build", "--debug"]);

      expect(mockSetupSlackPreview).toHaveBeenCalledWith(
        expect.objectContaining({ debug: true }),
      );
    });

    it("passes both --manifest and --debug together", async () => {
      await runCLI(["build", "--manifest", "my-manifest.json", "--debug"]);

      expect(mockSetupSlackPreview).toHaveBeenCalledWith({
        manifestPath: "my-manifest.json",
        debug: true,
      });
    });

    it("does not call process.exit on successful build (updated)", async () => {
      mockSetupSlackPreview.mockResolvedValueOnce({
        status: "updated",
        appId: "A123",
        warnings: [],
      });
      await runCLI(["build"]);

      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("calls process.exit(0) when result.status is created", async () => {
      mockSetupSlackPreview.mockResolvedValueOnce({
        status: "created",
        appId: "A123",
        warnings: [],
      });
      await runCLI(["build"]);

      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("does not call process.exit when result.status is failed", async () => {
      mockSetupSlackPreview.mockResolvedValueOnce({
        status: "failed",
        error: "Vercel API auth failed",
        warnings: [],
      });
      await runCLI(["build"]);

      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("does not call process.exit when result.status is skipped", async () => {
      mockSetupSlackPreview.mockResolvedValueOnce({
        status: "skipped",
        reason: "missing VERCEL_API_TOKEN",
        warnings: [],
      });
      await runCLI(["build"]);

      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("logs warnings from result.warnings", async () => {
      mockSetupSlackPreview.mockResolvedValueOnce({
        status: "updated",
        appId: "A1",
        warnings: [
          "Failed to configure deployment protection bypass",
          "Orphan cleanup failed",
        ],
      });
      await runCLI(["build"]);

      // log.warn calls console.log under the hood
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Failed to configure deployment protection bypass",
        ),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Orphan cleanup failed"),
      );
    });

    it("calls setupSlackPreview exactly once", async () => {
      await runCLI(["build"]);

      expect(mockSetupSlackPreview).toHaveBeenCalledTimes(1);
    });

    it("handles flags in any order", async () => {
      await runCLI(["build", "--debug", "--manifest", "reversed.json"]);

      expect(mockSetupSlackPreview).toHaveBeenCalledWith({
        manifestPath: "reversed.json",
        debug: true,
      });
    });
  });

  // =========================================================================
  // 6. Unknown command
  // =========================================================================

  describe("unknown command", () => {
    it('prints "Unknown command: <name>" to stderr', async () => {
      await runCLI(["deploy"]);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Unknown command: deploy"),
      );
    });

    it("prints the help text", async () => {
      await runCLI(["deploy"]);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Usage: vercel-slack"),
      );
    });

    it("exits with code 1", async () => {
      await runCLI(["deploy"]);

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // =========================================================================
  // 7. Error handling (.catch() branch)
  // =========================================================================

  describe("error handling", () => {
    it("formats Error instances as 'vercel-slack: <message>'", async () => {
      mockSetupSlackPreview.mockRejectedValue(new Error("boom"));
      await runCLI(["build"]);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("vercel-slack: boom"),
      );
    });

    it("stringifies non-Error throws", async () => {
      mockSetupSlackPreview.mockRejectedValue("string-error");
      await runCLI(["build"]);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("vercel-slack: string-error"),
      );
    });

    it("prints error.stack when --debug is in process.argv", async () => {
      const err = new Error("debug-boom");
      mockSetupSlackPreview.mockRejectedValue(err);
      await runCLI(["build", "--debug"]);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("vercel-slack: debug-boom"),
      );
      expect(err.stack).toBeDefined();
      expect(errorSpy).toHaveBeenCalledWith(err.stack);
    });

    it("does not print stack when --debug is absent", async () => {
      const err = new Error("no-stack");
      mockSetupSlackPreview.mockRejectedValue(err);
      await runCLI(["build"]);

      // The error message should be printed, but the stack should NOT appear
      // in any console.error call beyond the formatted message line.
      const allErrorArgs = errorSpy.mock.calls.map((c) => c[0]);
      const stackCalls = allErrorArgs.filter(
        (arg) => typeof arg === "string" && arg.includes("at "),
      );
      expect(stackCalls).toHaveLength(0);
    });

    it("exits with code 1 on error", async () => {
      mockSetupSlackPreview.mockRejectedValue(new Error("fail"));
      await runCLI(["build"]);

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // =========================================================================
  // 8. parseFlags edge cases (tested via build command)
  // =========================================================================

  describe("parseFlags edge cases", () => {
    it("--manifest without a following value does not set manifestPath", async () => {
      // --manifest is the last arg with no value after it
      await runCLI(["build", "--manifest"]);

      expect(mockSetupSlackPreview).toHaveBeenCalledWith(
        expect.objectContaining({ manifestPath: undefined }),
      );
    });

    it("unknown flags are silently ignored", async () => {
      await runCLI(["build", "--verbose", "--foo"]);

      expect(mockSetupSlackPreview).toHaveBeenCalledWith({
        manifestPath: undefined,
        debug: false,
      });
    });

    it("--manifest consumes the next arg even if it looks like a flag", async () => {
      // `--manifest --debug` should treat "--debug" as the path, not as a flag
      await runCLI(["build", "--manifest", "--debug"]);

      expect(mockSetupSlackPreview).toHaveBeenCalledWith({
        manifestPath: "--debug",
        debug: false,
      });
    });
  });
});
