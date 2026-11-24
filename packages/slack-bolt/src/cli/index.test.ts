import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBuild } from "./build";
import { run } from "./index";
import { validateAndBuildParams } from "./schemas";

vi.mock("./build", () => ({ executeBuild: vi.fn() }));
vi.mock("./schemas", () => ({
  validateAndBuildParams: vi.fn(() => ({})),
}));

const argv = process.argv;

beforeEach(() => {
  process.argv = ["node", "vercel-slack", "build"];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("VERCEL_ENV", "preview");
});

afterEach(() => {
  process.argv = argv;
  // Left at 1, it would fail the test run itself.
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(executeBuild).mockReset();
});

describe("vercel-slack build", () => {
  it("exits with code 1 when the build fails", async () => {
    vi.mocked(executeBuild).mockRejectedValue(
      new Error("Slack configuration token is invalid or expired."),
    );

    await run("0.0.0");

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Slack configuration token is invalid or expired.",
      ),
    );
  });

  it("prints what caused the failure, down the chain", async () => {
    vi.mocked(executeBuild).mockRejectedValue(
      new Error("Vercel API token cannot access this project.", {
        cause: new Error("Failed to access Vercel project: 403 Forbidden", {
          cause: new Error("socket hang up"),
        }),
      }),
    );

    await run("0.0.0");

    expect(vi.mocked(console.error).mock.calls.map(([line]) => line)).toEqual([
      "Vercel API token cannot access this project.",
      "  Caused by: Failed to access Vercel project: 403 Forbidden",
      "  Caused by: socket hang up",
    ]);
  });

  it("prints each problem Slack found in the manifest", async () => {
    vi.mocked(executeBuild).mockRejectedValue(
      Object.assign(new Error("invalid_manifest"), {
        errors: [
          {
            message: "Interactivity requires a Request URL",
            pointer: "/settings/interactivity",
          },
        ],
      }),
    );

    await run("0.0.0");

    expect(console.error).toHaveBeenCalledWith(
      "  /settings/interactivity: Interactivity requires a Request URL",
    );
    expect(process.exitCode).toBe(1);
  });

  it("exits with code 1 when required env vars are missing", async () => {
    vi.mocked(validateAndBuildParams).mockImplementationOnce(() => {
      throw new Error("Missing VERCEL_API_TOKEN");
    });

    await run("0.0.0");

    expect(executeBuild).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("exits with code 0 when the build succeeds", async () => {
    vi.mocked(executeBuild).mockResolvedValue();

    await run("0.0.0");

    expect(executeBuild).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ["local", undefined],
    ["development", "development"],
    ["production", "production"],
  ])("skips without failing on %s builds", async (_, env) => {
    vi.stubEnv("VERCEL_ENV", env);

    await run("0.0.0");

    expect(executeBuild).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
