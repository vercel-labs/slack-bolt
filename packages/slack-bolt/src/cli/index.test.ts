import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAndBuildParams } from "../internal/schemas";
import { executeBuild } from "./build";
import { run } from "./index";

vi.mock("./build", () => ({ executeBuild: vi.fn() }));
vi.mock("../internal/schemas", () => ({
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
