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

  // Slack's errors sit on the call that failed, which a message saying what
  // to do can wrap.
  it("prints the problems Slack found when they're on a cause", async () => {
    vi.mocked(executeBuild).mockRejectedValue(
      new Error("Couldn't set up the Slack app.", {
        cause: Object.assign(
          new Error("Slack's apps.manifest.update failed: invalid_manifest"),
          {
            errors: [
              {
                message: "must be less than 36 characters",
                pointer: "/display_information/name",
              },
            ],
          },
        ),
      }),
    );

    await run("0.0.0");

    expect(vi.mocked(console.error).mock.calls.map(([line]) => line)).toEqual([
      "Couldn't set up the Slack app.",
      "  Caused by: Slack's apps.manifest.update failed: invalid_manifest",
      "  /display_information/name: must be less than 36 characters",
    ]);
  });

  it("gives the build its environment, with the command's flags applied", async () => {
    vi.mocked(executeBuild).mockResolvedValue();
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-from-env");
    vi.stubEnv("SLACK_APP_ID", "A_FROM_ENV");
    process.argv.push("--slack-app-id", "A_FROM_FLAG", "--cleanup");

    await run("0.0.0");

    const [, options] = vi.mocked(executeBuild).mock.calls[0];
    expect(options?.cleanup).toBe(true);
    expect(options?.env).toMatchObject({
      SLACK_BOT_TOKEN: "xoxb-from-env",
      SLACK_APP_ID: "A_FROM_FLAG",
    });
  });

  // An error can repeat what the build was given: Vercel's and Slack's
  // answers end up in messages.
  it("keeps the secrets the build was given out of the errors it prints", async () => {
    // Put together here, so a secret scanner doesn't take it for a real one.
    const botToken = ["xoxb", "123456789012", "abcdefghijkl"].join("-");
    vi.stubEnv("SLACK_CONFIGURATION_TOKEN", "config-token-from-env");
    vi.stubEnv("SLACK_SIGNING_SECRET", "0123456789abcdef0123456789abcdef");
    process.argv.push("--vercel-api-token", "vercel-token-from-flag");
    vi.mocked(executeBuild).mockRejectedValue(
      new Error("Request with config-token-from-env failed", {
        cause: new Error(
          `Vercel answered: vercel-token-from-flag 0123456789abcdef0123456789abcdef ${botToken}`,
        ),
      }),
    );

    await run("0.0.0");

    const printed = vi
      .mocked(console.error)
      .mock.calls.map(([line]) => line)
      .join("\n");
    for (const secret of [
      "config-token-from-env",
      "vercel-token-from-flag",
      "0123456789abcdef0123456789abcdef",
      botToken.slice(0, 17),
    ]) {
      expect(printed).not.toContain(secret);
    }
    expect(printed).toContain("Request with ****-env failed");
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
