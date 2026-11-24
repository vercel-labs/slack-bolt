import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authTest, rotateConfigToken } from "../internal/slack";
import {
  addEnvironmentVariables,
  cancelDeployment,
  createDeployment,
  getProject,
} from "../internal/vercel";
import { type PreviewParams, preview } from "../preview";
import { executeBuild } from "./build";
import { cleanupOrphanedApps } from "./cleanup";

vi.mock("../preview", () => ({ preview: vi.fn() }));
vi.mock("./cleanup", () => ({ cleanupOrphanedApps: vi.fn() }));
vi.mock("../internal/slack", () => ({
  authTest: vi.fn(),
  rotateConfigToken: vi.fn(),
}));
vi.mock("../internal/vercel", () => ({
  addEnvironmentVariables: vi.fn(),
  cancelDeployment: vi.fn(),
  createDeployment: vi.fn(),
  getProject: vi.fn(),
}));

let dir: string;
let log: ReturnType<typeof vi.spyOn>;

const createParams = (
  overrides: Partial<PreviewParams> = {},
): PreviewParams => ({
  branch: "feat/thing",
  projectId: "prj_123",
  teamId: "team_456",
  deploymentUrl: "my-app-abc123.vercel.app",
  deploymentId: "dpl_current",
  manifestPath: "manifest.json",
  slackConfigurationToken: "config-token",
  vercelApiToken: "vercel-token",
  ...overrides,
});

const updated = {
  isNew: false,
  installStatus: "installed",
  app: { ok: true, app_id: "A1", permissions_updated: false },
} as const;
const created = {
  isNew: true,
  installStatus: "installed",
  app: {
    ok: true,
    app_id: "A1",
    credentials: {
      client_id: "c",
      client_secret: "s",
      verification_token: "v",
      signing_secret: "ss",
    },
    oauth_authorize_url: "",
  },
} as const;

/** Everything the build printed with console.log. */
const printed = () =>
  log.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-bolt-build-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), "{}");
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  log = vi.spyOn(console, "log").mockImplementation(() => {});

  vi.mocked(authTest).mockResolvedValue({ userId: "U1", teamId: "T1" });
  vi.mocked(getProject).mockResolvedValue();
  vi.mocked(preview).mockResolvedValue(updated);
  vi.mocked(createDeployment).mockResolvedValue({
    id: "dpl_next",
    url: "my-app-next.vercel.app",
  });
  vi.mocked(cancelDeployment).mockResolvedValue();
  vi.mocked(addEnvironmentVariables).mockResolvedValue({ created: [] });
  vi.mocked(cleanupOrphanedApps).mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("executeBuild", () => {
  it("runs preview for the CLI with the build's parameters", async () => {
    const params = createParams();

    await executeBuild(params);

    expect(preview).toHaveBeenCalledWith(params, "cli");
    expect(cleanupOrphanedApps).not.toHaveBeenCalled();
  });

  describe("redeploying", () => {
    it("starts a new deployment, then cancels this one, when the app is new", async () => {
      vi.mocked(preview).mockResolvedValue(created);

      await executeBuild(createParams());

      expect(createDeployment).toHaveBeenCalledWith({
        deploymentId: "dpl_current",
        projectId: "prj_123",
        token: "vercel-token",
        teamId: "team_456",
      });
      expect(cancelDeployment).toHaveBeenCalledWith({
        deploymentId: "dpl_current",
        token: "vercel-token",
        teamId: "team_456",
      });
      // Cancelling first would cancel the build that creates the new one.
      expect(
        vi.mocked(createDeployment).mock.invocationCallOrder[0],
      ).toBeLessThan(vi.mocked(cancelDeployment).mock.invocationCallOrder[0]);
    });

    it("keeps this deployment when the app already existed", async () => {
      await executeBuild(createParams());

      expect(createDeployment).not.toHaveBeenCalled();
      expect(cancelDeployment).not.toHaveBeenCalled();
    });

    it("keeps this deployment when its ID isn't known", async () => {
      vi.mocked(preview).mockResolvedValue(created);

      await executeBuild(createParams({ deploymentId: undefined }));

      expect(createDeployment).not.toHaveBeenCalled();
      expect(cancelDeployment).not.toHaveBeenCalled();
    });

    it("doesn't cancel this deployment when the new one can't be created", async () => {
      vi.mocked(preview).mockResolvedValue(created);
      vi.mocked(createDeployment).mockRejectedValue(new Error("no"));

      await expect(executeBuild(createParams())).rejects.toThrow("no");

      expect(cancelDeployment).not.toHaveBeenCalled();
    });
  });

  describe("the configuration token", () => {
    it("fails when it's empty", async () => {
      await expect(
        executeBuild(createParams({ slackConfigurationToken: "" })),
      ).rejects.toThrow("Slack Configuration Token is not set.");

      expect(authTest).not.toHaveBeenCalled();
    });

    it("fails when it's expired and there's no refresh token", async () => {
      const expired = new Error("token_expired");
      vi.mocked(authTest).mockRejectedValue(expired);

      const error = await executeBuild(createParams()).catch((e: Error) => e);

      expect(error?.message).toContain(
        "Slack configuration token is invalid or expired. Provide SLACK_CONFIG_REFRESH_TOKEN",
      );
      expect(error?.cause).toBe(expired);
      expect(rotateConfigToken).not.toHaveBeenCalled();
      expect(preview).not.toHaveBeenCalled();
    });

    it("rotates an expired token, saves both new tokens and uses them", async () => {
      vi.mocked(authTest).mockRejectedValueOnce(new Error("token_expired"));
      vi.mocked(rotateConfigToken).mockResolvedValue({
        token: "new-config-token",
        refreshToken: "new-refresh-token",
        exp: 0,
      });

      await executeBuild(
        createParams({ slackConfigRefreshToken: "old-refresh-token" }),
      );

      expect(rotateConfigToken).toHaveBeenCalledWith({
        refreshToken: "old-refresh-token",
      });
      const targets = ["production", "preview", "development"];
      expect(addEnvironmentVariables).toHaveBeenCalledWith({
        projectId: "prj_123",
        token: "vercel-token",
        teamId: "team_456",
        envs: [
          {
            key: "SLACK_CONFIGURATION_TOKEN",
            value: "new-config-token",
            type: "encrypted",
            target: targets,
          },
          {
            key: "SLACK_CONFIG_REFRESH_TOKEN",
            value: "new-refresh-token",
            type: "encrypted",
            target: targets,
          },
        ],
      });
      expect(vi.mocked(preview).mock.calls[0][0]).toMatchObject({
        slackConfigurationToken: "new-config-token",
        slackConfigRefreshToken: "new-refresh-token",
      });
    });

    it("says the refresh token may be invalid when Slack refuses to rotate", async () => {
      const refused = new Error("invalid_refresh_token");
      vi.mocked(authTest).mockRejectedValue(new Error("token_expired"));
      vi.mocked(rotateConfigToken).mockRejectedValue(refused);

      const error = await executeBuild(
        createParams({ slackConfigRefreshToken: "old-refresh-token" }),
      ).catch((e: Error) => e);

      expect(error?.message).toContain(
        "Failed to rotate configuration token — refresh token may be invalid.",
      );
      expect(error?.cause).toBe(refused);
      expect(addEnvironmentVariables).not.toHaveBeenCalled();
    });

    // Slack's refresh tokens are single-use, so the stored one is spent.
    it("says the new tokens weren't saved when Vercel refuses them", async () => {
      const forbidden = new Error(
        "Failed to create environment variables: 403 Forbidden",
      );
      vi.mocked(authTest).mockRejectedValue(new Error("token_expired"));
      vi.mocked(rotateConfigToken).mockResolvedValue({
        token: "new-config-token",
        refreshToken: "new-refresh-token",
        exp: 0,
      });
      vi.mocked(addEnvironmentVariables).mockRejectedValue(forbidden);

      const error = await executeBuild(
        createParams({ slackConfigRefreshToken: "old-refresh-token" }),
      ).catch((e: Error) => e);

      expect(error?.message).toContain(
        "couldn't save the new tokens to your Vercel project",
      );
      expect(error?.message).not.toContain("refresh token may be invalid");
      expect(error?.message).not.toContain("new-config-token");
      expect(error?.cause).toBe(forbidden);
      expect(preview).not.toHaveBeenCalled();
    });
  });

  it("warns and carries on when the service token is invalid", async () => {
    vi.mocked(authTest)
      .mockResolvedValueOnce({ userId: "U1", teamId: "T1" })
      .mockRejectedValueOnce(new Error("invalid_auth"));

    await executeBuild(createParams({ slackServiceToken: "bad-service" }));

    expect(authTest).toHaveBeenNthCalledWith(2, { token: "bad-service" });
    expect(printed()).toContain("SLACK_SERVICE_TOKEN is invalid");
    expect(preview).toHaveBeenCalled();
  });

  it("fails when the branch isn't known", async () => {
    await expect(executeBuild(createParams({ branch: "" }))).rejects.toThrow(
      "VERCEL_GIT_COMMIT_REF is not set",
    );

    expect(preview).not.toHaveBeenCalled();
  });

  it("fails when the Vercel token can't read the project", async () => {
    const forbidden = new Error("Failed to access Vercel project: 403");
    vi.mocked(getProject).mockRejectedValue(forbidden);

    const error = await executeBuild(createParams()).catch((e: Error) => e);

    expect(error?.message).toContain(
      "Vercel API token cannot access this project.",
    );
    expect(error?.cause).toBe(forbidden);
    expect(preview).not.toHaveBeenCalled();
  });

  it("fails before touching Slack when the manifest is missing", async () => {
    await expect(
      executeBuild(createParams({ manifestPath: "missing.json" })),
    ).rejects.toThrow("No manifest found at missing.json.");

    expect(preview).not.toHaveBeenCalled();
  });

  describe("--cleanup", () => {
    it("cleans up other branches' apps before setting up this one", async () => {
      await executeBuild(createParams(), { cleanup: true });

      expect(cleanupOrphanedApps).toHaveBeenCalledWith({
        projectId: "prj_123",
        currentBranch: "feat/thing",
        vercelApiToken: "vercel-token",
        teamId: "team_456",
        slackConfigurationToken: "config-token",
      });
      expect(
        vi.mocked(cleanupOrphanedApps).mock.invocationCallOrder[0],
      ).toBeLessThan(vi.mocked(preview).mock.invocationCallOrder[0]);
    });

    it("warns and carries on when cleanup fails", async () => {
      vi.mocked(cleanupOrphanedApps).mockRejectedValue(
        new Error("Failed to fetch active branches: 500"),
      );

      await executeBuild(createParams(), { cleanup: true });

      expect(printed()).toContain(
        "Orphan cleanup failed: Failed to fetch active branches: 500",
      );
      expect(preview).toHaveBeenCalled();
    });
  });
});
