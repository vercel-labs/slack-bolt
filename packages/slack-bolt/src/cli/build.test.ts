import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBuild } from "./build";

vi.mock("../internal/slack", () => ({
  authTest: vi.fn(),
  rotateConfigToken: vi.fn(),
}));

vi.mock("../internal/vercel", () => ({
  addEnvironmentVariables: vi.fn(),
  getProject: vi.fn(),
  createDeployment: vi.fn(),
  cancelDeployment: vi.fn(),
}));

vi.mock("../preview", () => ({
  preview: vi.fn().mockResolvedValue({ isNew: false }),
}));

vi.mock("../cleanup", () => ({
  cleanupOrphanedApps: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: { existsSync: vi.fn().mockReturnValue(true) },
}));

import { authTest, rotateConfigToken } from "../internal/slack";
import { addEnvironmentVariables, getProject } from "../internal/vercel";
import { preview } from "../preview";

const mockAuthTest = vi.mocked(authTest);
const mockRotate = vi.mocked(rotateConfigToken);
const mockAddEnvVars = vi.mocked(addEnvironmentVariables);
const mockGetProject = vi.mocked(getProject);
const mockPreview = vi.mocked(preview);

function baseParams() {
  return {
    slackConfigurationToken: "xoxe.xoxp-old-token",
    slackConfigRefreshToken: "xoxe-old-refresh",
    branch: "feat/test",
    projectId: "prj_123",
    deploymentUrl: "test.vercel.app",
    manifestPath: "manifest.json",
    vercelApiToken: "vat_123",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetProject.mockResolvedValue(
    {} as unknown as ReturnType<typeof getProject> extends Promise<infer T>
      ? T
      : never,
  );
  mockPreview.mockResolvedValue({ isNew: false } as ReturnType<
    typeof preview
  > extends Promise<infer T>
    ? T
    : never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("executeBuild token rotation", () => {
  it("should proceed normally when authTest succeeds", async () => {
    mockAuthTest.mockResolvedValueOnce(undefined);
    const params = baseParams();

    await executeBuild(params);

    expect(mockAuthTest).toHaveBeenCalledWith({
      token: "xoxe.xoxp-old-token",
    });
    expect(mockRotate).not.toHaveBeenCalled();
    expect(mockPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        slackConfigurationToken: "xoxe.xoxp-old-token",
      }),
      "cli",
    );
  });

  it("should rotate token when authTest fails and refresh token is available", async () => {
    mockAuthTest.mockRejectedValueOnce(new Error("token_expired"));
    mockRotate.mockResolvedValueOnce({
      token: "xoxe.xoxp-fresh-token",
      refreshToken: "xoxe-fresh-refresh",
      exp: 9999999999,
    });
    mockAddEnvVars.mockResolvedValueOnce({} as never);

    const params = baseParams();
    await executeBuild(params);

    expect(mockRotate).toHaveBeenCalledWith({
      refreshToken: "xoxe-old-refresh",
    });
  });

  it("should use the rotated token for the rest of the build", async () => {
    mockAuthTest.mockRejectedValueOnce(new Error("token_expired"));
    mockRotate.mockResolvedValueOnce({
      token: "xoxe.xoxp-fresh-token",
      refreshToken: "xoxe-fresh-refresh",
      exp: 9999999999,
    });
    mockAddEnvVars.mockResolvedValueOnce({} as never);

    const params = baseParams();
    await executeBuild(params);

    expect(mockPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        slackConfigurationToken: "xoxe.xoxp-fresh-token",
      }),
      "cli",
    );
  });

  it("should persist both new tokens to Vercel env vars", async () => {
    mockAuthTest.mockRejectedValueOnce(new Error("token_expired"));
    mockRotate.mockResolvedValueOnce({
      token: "xoxe.xoxp-fresh-token",
      refreshToken: "xoxe-fresh-refresh",
      exp: 9999999999,
    });
    mockAddEnvVars.mockResolvedValueOnce({} as never);

    const params = baseParams();
    await executeBuild(params);

    expect(mockAddEnvVars).toHaveBeenCalledWith({
      projectId: "prj_123",
      token: "vat_123",
      teamId: undefined,
      envs: [
        {
          key: "SLACK_CONFIGURATION_TOKEN",
          value: "xoxe.xoxp-fresh-token",
          type: "encrypted",
          target: ["production", "preview", "development"],
        },
        {
          key: "SLACK_CONFIG_REFRESH_TOKEN",
          value: "xoxe-fresh-refresh",
          type: "encrypted",
          target: ["production", "preview", "development"],
        },
      ],
    });
  });

  it("should throw when authTest fails and no refresh token is available", async () => {
    mockAuthTest.mockRejectedValueOnce(new Error("token_expired"));

    const params = baseParams();
    params.slackConfigRefreshToken = undefined as unknown as string;

    await expect(executeBuild(params)).rejects.toThrow(
      "Provide SLACK_CONFIG_REFRESH_TOKEN for automatic rotation",
    );
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it("should throw when token rotation itself fails", async () => {
    mockAuthTest.mockRejectedValueOnce(new Error("token_expired"));
    mockRotate.mockRejectedValueOnce(new Error("invalid_refresh_token"));

    const params = baseParams();

    await expect(executeBuild(params)).rejects.toThrow(
      "Failed to rotate configuration token",
    );
  });

  it("should pass rotated token to cleanup when --cleanup is used", async () => {
    const { cleanupOrphanedApps } = await import("../cleanup");
    const mockCleanup = vi.mocked(cleanupOrphanedApps);
    mockCleanup.mockResolvedValueOnce(undefined as never);

    mockAuthTest.mockRejectedValueOnce(new Error("token_expired"));
    mockRotate.mockResolvedValueOnce({
      token: "xoxe.xoxp-fresh-token",
      refreshToken: "xoxe-fresh-refresh",
      exp: 9999999999,
    });
    mockAddEnvVars.mockResolvedValueOnce({} as never);

    const params = baseParams();
    await executeBuild(params, { cleanup: true });

    expect(mockCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        slackConfigurationToken: "xoxe.xoxp-fresh-token",
      }),
    );
  });
});
