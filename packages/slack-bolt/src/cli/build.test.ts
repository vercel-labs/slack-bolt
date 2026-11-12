import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPError } from "../internal/http-error";
import { provisionPreview } from "../internal/provision";
import { authTest, rotateConfigToken, SlackAPIError } from "../internal/slack";
import {
  addEnvironmentVariables,
  cancelDeployment,
  createDeployment,
  getDeploymentMeta,
  getEnvironmentVariable,
  getEnvironmentVariables,
  getProject,
} from "../internal/vercel";
import type { CreateProjectEnv } from "../internal/vercel/types";
import { wait } from "../internal/wait";
import type { PreviewParams } from "../preview";
import { executeBuild } from "./build";
import { cleanupOrphanedApps } from "./cleanup";

vi.mock("../internal/provision", () => ({ provisionPreview: vi.fn() }));
vi.mock("./cleanup", () => ({ cleanupOrphanedApps: vi.fn() }));
// Keep the real error classes and checks; only the calls to Slack are fake.
vi.mock("../internal/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../internal/slack")>()),
  authTest: vi.fn(),
  rotateConfigToken: vi.fn(),
}));
vi.mock("../internal/vercel", () => ({
  addEnvironmentVariables: vi.fn(),
  cancelDeployment: vi.fn(),
  createDeployment: vi.fn(),
  getDeploymentMeta: vi.fn(),
  getEnvironmentVariable: vi.fn(),
  getEnvironmentVariables: vi.fn(),
  getProject: vi.fn(),
}));
vi.mock("../internal/wait", () => ({ wait: vi.fn() }));

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
  installStatus: "installed" as const,
  app: { ok: true, app_id: "A1", permissions_updated: false },
  changedEnv: [] as string[],
};
/** An app that existed, and that this build's install got a token for. */
const installedLate = { ...updated, changedEnv: ["SLACK_BOT_TOKEN"] };
const created = {
  isNew: true,
  installStatus: "installed" as const,
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
  changedEnv: [
    "SLACK_APP_ID",
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "SLACK_SIGNING_SECRET",
    "SLACK_BOT_TOKEN",
  ],
};

const expired = () => new SlackAPIError("auth.test", "token_expired");

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
  vi.mocked(provisionPreview).mockResolvedValue(updated);
  vi.mocked(createDeployment).mockResolvedValue({
    id: "dpl_next",
    url: "my-app-next.vercel.app",
  });
  vi.mocked(cancelDeployment).mockResolvedValue();
  vi.mocked(getDeploymentMeta).mockResolvedValue({});
  vi.mocked(getEnvironmentVariables).mockResolvedValue([]);
  vi.mocked(getEnvironmentVariable).mockResolvedValue(null);
  vi.mocked(addEnvironmentVariables).mockResolvedValue({ created: [] });
  vi.mocked(cleanupOrphanedApps).mockResolvedValue();
  vi.mocked(wait).mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("executeBuild", () => {
  it("sets up the branch's app for the CLI, with the build's environment", async () => {
    const params = createParams();
    const env = { SLACK_BOT_TOKEN: "xoxb-current" };

    await executeBuild(params, { env });

    expect(provisionPreview).toHaveBeenCalledWith(params, {
      cli: true,
      currentEnv: env,
    });
    expect(cleanupOrphanedApps).not.toHaveBeenCalled();
  });

  it("compares with process.env when it isn't given an environment", async () => {
    await executeBuild(createParams());

    expect(vi.mocked(provisionPreview).mock.calls[0][1]?.currentEnv).toBe(
      process.env,
    );
  });

  describe("redeploying", () => {
    it("starts a new deployment, then cancels this one, when the app is new", async () => {
      vi.mocked(provisionPreview).mockResolvedValue(created);

      await executeBuild(createParams());

      expect(createDeployment).toHaveBeenCalledWith({
        deploymentId: "dpl_current",
        projectId: "prj_123",
        token: "vercel-token",
        teamId: "team_456",
        // Marks the new deployment as started here, with what it replaces.
        meta: { vercelSlackRedeployOf: "dpl_current" },
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

    it("keeps this deployment when the app already existed and nothing new was saved", async () => {
      await executeBuild(createParams());

      expect(createDeployment).not.toHaveBeenCalled();
      expect(cancelDeployment).not.toHaveBeenCalled();
      expect(getDeploymentMeta).not.toHaveBeenCalled();
    });

    // This deployment was built without the token, so its app can't answer.
    it("starts a new deployment when an existing app only now got its token", async () => {
      vi.mocked(provisionPreview).mockResolvedValue(installedLate);

      await executeBuild(createParams());

      expect(createDeployment).toHaveBeenCalledTimes(1);
      expect(cancelDeployment).toHaveBeenCalledTimes(1);
    });

    it("keeps this deployment, and says so, when its ID isn't known", async () => {
      vi.mocked(provisionPreview).mockResolvedValue(created);

      await executeBuild(createParams({ deploymentId: undefined }));

      expect(createDeployment).not.toHaveBeenCalled();
      expect(cancelDeployment).not.toHaveBeenCalled();
      expect(printed()).toContain(
        "Saved SLACK_APP_ID, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN for feat/thing, but VERCEL_DEPLOYMENT_ID isn't set",
      );
    });

    it("doesn't cancel this deployment when the new one can't be created", async () => {
      vi.mocked(provisionPreview).mockResolvedValue(created);
      vi.mocked(createDeployment).mockRejectedValue(new Error("no"));

      await expect(executeBuild(createParams())).rejects.toThrow("no");

      expect(cancelDeployment).not.toHaveBeenCalled();
    });

    // Each deployment that needs replacing starts the next, and with a new
    // app each one creates a Slack app, so one this command started stops.
    describe("in a deployment this command started", () => {
      beforeEach(() => {
        vi.mocked(getDeploymentMeta).mockResolvedValue({
          vercelSlackRedeployOf: "dpl_first",
          originalDeploymentId: "dpl_first",
        });
      });

      it("fails instead of deploying again when it created another app", async () => {
        vi.mocked(provisionPreview).mockResolvedValue(created);

        await expect(executeBuild(createParams())).rejects.toThrow(
          "didn't get the app's SLACK_APP_ID, and created another app (A1)",
        );

        expect(getDeploymentMeta).toHaveBeenCalledWith({
          deploymentId: "dpl_current",
          token: "vercel-token",
          teamId: "team_456",
        });
        expect(createDeployment).not.toHaveBeenCalled();
        expect(cancelDeployment).not.toHaveBeenCalled();
      });

      it("keeps this deployment, and says so, when it only saved a token", async () => {
        vi.mocked(provisionPreview).mockResolvedValue(installedLate);

        await executeBuild(createParams());

        expect(createDeployment).not.toHaveBeenCalled();
        expect(cancelDeployment).not.toHaveBeenCalled();
        expect(printed()).toContain(
          "Saved SLACK_BOT_TOKEN for feat/thing, but this deployment already replaced one for the same reason",
        );
      });
    });

    // Redeploying from the dashboard copies the metadata, mark included.
    it("deploys again from a deployment that only inherited the mark", async () => {
      vi.mocked(provisionPreview).mockResolvedValue(installedLate);
      vi.mocked(getDeploymentMeta).mockResolvedValue({
        vercelSlackRedeployOf: "dpl_first",
        originalDeploymentId: "dpl_second",
      });

      await executeBuild(createParams());

      expect(createDeployment).toHaveBeenCalledTimes(1);
    });

    it("deploys again when the deployment's metadata can't be read", async () => {
      vi.mocked(provisionPreview).mockResolvedValue(created);
      vi.mocked(getDeploymentMeta).mockRejectedValue(new Error("403"));

      await executeBuild(createParams());

      expect(createDeployment).toHaveBeenCalledTimes(1);
      expect(cancelDeployment).toHaveBeenCalledTimes(1);
    });
  });

  describe("the configuration token", () => {
    const rotated = {
      token: "new-config-token",
      refreshToken: "new-refresh-token",
      exp: 0,
    };
    const withRefresh = () =>
      createParams({ slackConfigRefreshToken: "old-refresh-token" });
    const savedEnvs = () =>
      vi.mocked(addEnvironmentVariables).mock.calls[0][0]
        .envs as CreateProjectEnv[];

    it("fails when it's empty", async () => {
      await expect(
        executeBuild(createParams({ slackConfigurationToken: "" })),
      ).rejects.toThrow("Slack Configuration Token is not set.");

      expect(authTest).not.toHaveBeenCalled();
    });

    it("fails when it's expired and there's no refresh token", async () => {
      const refused = expired();
      vi.mocked(authTest).mockRejectedValue(refused);

      const error = await executeBuild(createParams()).catch((e: Error) => e);

      expect(error?.message).toContain(
        "Slack configuration token is invalid or expired. Provide SLACK_CONFIG_REFRESH_TOKEN",
      );
      expect(error?.cause).toBe(refused);
      expect(rotateConfigToken).not.toHaveBeenCalled();
      expect(provisionPreview).not.toHaveBeenCalled();
    });

    // Rotating spends the refresh token, so a token that may be fine isn't
    // rotated because Slack couldn't be asked.
    it.each([
      ["never answers", () => new TypeError("fetch failed")],
      ["is down", () => new HTTPError("Auth test failed", 503, "Unavailable")],
      ["is rate limiting", () => new HTTPError("Auth test failed", 429, "")],
      [
        "reports an internal error",
        () => new SlackAPIError("auth.test", "internal_error"),
      ],
    ])("fails without rotating when Slack %s", async (_, failure) => {
      const unreachable = failure();
      vi.mocked(authTest).mockRejectedValue(unreachable);

      const error = await executeBuild(withRefresh()).catch((e: Error) => e);

      expect(error?.message).toBe(
        "Couldn't reach Slack to check SLACK_CONFIGURATION_TOKEN. Redeploy to try again.",
      );
      expect(error?.cause).toBe(unreachable);
      expect(rotateConfigToken).not.toHaveBeenCalled();
      expect(provisionPreview).not.toHaveBeenCalled();
    });

    it("rotates an expired token, saves both new tokens and uses them", async () => {
      vi.mocked(authTest).mockRejectedValueOnce(expired());
      vi.mocked(rotateConfigToken).mockResolvedValue(rotated);

      await executeBuild(withRefresh());

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
      expect(vi.mocked(provisionPreview).mock.calls[0][0]).toMatchObject({
        slackConfigurationToken: "new-config-token",
        slackConfigRefreshToken: "new-refresh-token",
      });
    });

    // Rotating shouldn't copy a token kept to Preview into Production, or
    // make a Sensitive one readable.
    it("saves the new tokens with the environments and type of the stored ones", async () => {
      vi.mocked(authTest).mockRejectedValueOnce(expired());
      vi.mocked(rotateConfigToken).mockResolvedValue(rotated);
      vi.mocked(getEnvironmentVariables).mockResolvedValue([
        {
          id: "env_config",
          key: "SLACK_CONFIGURATION_TOKEN",
          type: "sensitive",
          target: ["preview"],
        },
        {
          id: "env_refresh_preview",
          key: "SLACK_CONFIG_REFRESH_TOKEN",
          type: "encrypted",
          target: ["preview"],
        },
        {
          id: "env_refresh_production",
          key: "SLACK_CONFIG_REFRESH_TOKEN",
          type: "sensitive",
          target: ["production"],
        },
        // A branch's own variables aren't the project's.
        {
          id: "env_branch",
          key: "SLACK_CONFIGURATION_TOKEN",
          type: "encrypted",
          target: ["preview"],
          gitBranch: "other",
        },
      ]);

      await executeBuild(withRefresh());

      expect(savedEnvs()).toEqual([
        {
          key: "SLACK_CONFIGURATION_TOKEN",
          value: "new-config-token",
          type: "sensitive",
          target: ["preview"],
        },
        {
          key: "SLACK_CONFIG_REFRESH_TOKEN",
          value: "new-refresh-token",
          type: "encrypted",
          target: ["preview"],
        },
        {
          key: "SLACK_CONFIG_REFRESH_TOKEN",
          value: "new-refresh-token",
          type: "sensitive",
          target: ["production"],
        },
      ]);
    });

    it("saves the new tokens for every environment when the stored ones can't be listed", async () => {
      vi.mocked(authTest).mockRejectedValueOnce(expired());
      vi.mocked(rotateConfigToken).mockResolvedValue(rotated);
      vi.mocked(getEnvironmentVariables).mockRejectedValue(new Error("500"));

      await executeBuild(withRefresh());

      expect(savedEnvs().map((env) => env.target)).toEqual([
        ["production", "preview", "development"],
        ["production", "preview", "development"],
      ]);
    });

    // Slack's refresh tokens are single-use, so the stored one is spent.
    it("tries again when Vercel doesn't save the new tokens at first", async () => {
      vi.mocked(authTest).mockRejectedValueOnce(expired());
      vi.mocked(rotateConfigToken).mockResolvedValue(rotated);
      vi.mocked(addEnvironmentVariables)
        .mockRejectedValueOnce(new HTTPError("Failed", 502, "Bad Gateway"))
        .mockResolvedValueOnce({ created: [] });

      await executeBuild(withRefresh());

      expect(addEnvironmentVariables).toHaveBeenCalledTimes(2);
      expect(rotateConfigToken).toHaveBeenCalledTimes(1);
      expect(provisionPreview).toHaveBeenCalled();
    });

    it("says the new tokens weren't saved when Vercel keeps failing", async () => {
      const down = new HTTPError("Failed", 502, "Bad Gateway");
      vi.mocked(authTest).mockRejectedValue(expired());
      vi.mocked(rotateConfigToken).mockResolvedValue(rotated);
      vi.mocked(addEnvironmentVariables).mockRejectedValue(down);

      const error = await executeBuild(withRefresh()).catch((e: Error) => e);

      expect(error?.message).toContain(
        "couldn't save the new tokens to your Vercel project",
      );
      expect(error?.cause).toBe(down);
      expect(addEnvironmentVariables).toHaveBeenCalledTimes(3);
      expect(provisionPreview).not.toHaveBeenCalled();
    });

    it("says the new tokens weren't saved, without trying again, when Vercel refuses them", async () => {
      const forbidden = new HTTPError(
        "Failed to create environment variables",
        403,
        "Forbidden",
      );
      vi.mocked(authTest).mockRejectedValue(expired());
      vi.mocked(rotateConfigToken).mockResolvedValue(rotated);
      vi.mocked(addEnvironmentVariables).mockRejectedValue(forbidden);

      const error = await executeBuild(withRefresh()).catch((e: Error) => e);

      expect(error?.message).toContain(
        "couldn't save the new tokens to your Vercel project",
      );
      expect(error?.message).not.toContain("refresh token may be invalid");
      expect(error?.message).not.toContain("new-config-token");
      expect(error?.cause).toBe(forbidden);
      expect(addEnvironmentVariables).toHaveBeenCalledTimes(1);
      expect(provisionPreview).not.toHaveBeenCalled();
    });

    it("says the refresh token may be invalid when Slack refuses to rotate", async () => {
      const refused = new SlackAPIError(
        "tooling.tokens.rotate",
        "invalid_refresh_token",
      );
      vi.mocked(authTest).mockRejectedValue(expired());
      vi.mocked(rotateConfigToken).mockRejectedValue(refused);

      const error = await executeBuild(withRefresh()).catch((e: Error) => e);

      expect(error?.message).toContain(
        "Failed to rotate configuration token — refresh token may be invalid.",
      );
      expect(error?.cause).toBe(refused);
      expect(addEnvironmentVariables).not.toHaveBeenCalled();
    });

    it("fails without looking for another token when Slack can't be reached to rotate", async () => {
      const down = new HTTPError("Failed to rotate", 503, "Unavailable");
      vi.mocked(authTest).mockRejectedValue(expired());
      vi.mocked(rotateConfigToken).mockRejectedValue(down);

      const error = await executeBuild(withRefresh()).catch((e: Error) => e);

      expect(error?.message).toBe(
        "Couldn't reach Slack to rotate SLACK_CONFIGURATION_TOKEN. Redeploy to try again.",
      );
      expect(error?.cause).toBe(down);
      // Only the look before rotating.
      expect(getEnvironmentVariables).toHaveBeenCalledTimes(1);
      expect(wait).not.toHaveBeenCalled();
    });

    // A build gets its variables when its deployment is created. One that
    // waited in the queue, like the last of a batch of Dependabot pull
    // requests, still has the expired token after an earlier build rotated it.
    describe("when another build rotated it first", () => {
      const stored = {
        id: "env_config",
        key: "SLACK_CONFIGURATION_TOKEN",
        type: "encrypted",
        target: ["production", "preview", "development"],
      };

      beforeEach(() => {
        // The token this build started with is expired; any other is fine.
        vi.mocked(authTest).mockImplementation(async ({ token }) => {
          if (token === "config-token") throw expired();
          return { userId: "U1", teamId: "T1" };
        });
        vi.mocked(rotateConfigToken).mockResolvedValue(rotated);
        vi.mocked(getEnvironmentVariables).mockResolvedValue([stored]);
      });

      // Rotating again would revoke the token the other build is using.
      it("uses the token the other build saved, without rotating again", async () => {
        vi.mocked(getEnvironmentVariable).mockResolvedValue("rotated-by-other");

        await executeBuild(withRefresh());

        expect(getEnvironmentVariable).toHaveBeenCalledWith({
          projectId: "prj_123",
          token: "vercel-token",
          teamId: "team_456",
          envId: "env_config",
        });
        expect(vi.mocked(provisionPreview).mock.calls[0][0]).toMatchObject({
          slackConfigurationToken: "rotated-by-other",
        });
        expect(rotateConfigToken).not.toHaveBeenCalled();
        expect(addEnvironmentVariables).not.toHaveBeenCalled();
        expect(printed()).toContain(
          "Using the configuration token another build rotated",
        );
      });

      it("uses it even without a refresh token of its own", async () => {
        vi.mocked(getEnvironmentVariable).mockResolvedValue("rotated-by-other");

        await executeBuild(createParams());

        expect(vi.mocked(provisionPreview).mock.calls[0][0]).toMatchObject({
          slackConfigurationToken: "rotated-by-other",
        });
      });

      it("rotates when the project still has the token this build started with", async () => {
        vi.mocked(getEnvironmentVariable).mockResolvedValue("config-token");

        await executeBuild(withRefresh());

        expect(rotateConfigToken).toHaveBeenCalledTimes(1);
        expect(wait).not.toHaveBeenCalled();
        expect(vi.mocked(provisionPreview).mock.calls[0][0]).toMatchObject({
          slackConfigurationToken: "new-config-token",
        });
      });

      it("rotates when the project's token can't be read", async () => {
        vi.mocked(getEnvironmentVariables).mockRejectedValue(new Error("500"));

        await executeBuild(withRefresh());

        expect(rotateConfigToken).toHaveBeenCalledTimes(1);
      });

      it("ignores a branch's own token, and one that isn't for previews", async () => {
        vi.mocked(getEnvironmentVariables).mockResolvedValue([
          { ...stored, id: "env_branch", gitBranch: "other" },
          { ...stored, id: "env_production", target: ["production"] },
        ]);
        vi.mocked(getEnvironmentVariable).mockResolvedValue("rotated-by-other");

        await executeBuild(withRefresh());

        expect(getEnvironmentVariable).not.toHaveBeenCalled();
        expect(rotateConfigToken).toHaveBeenCalledTimes(1);
      });

      it("doesn't use a saved token Slack refuses too", async () => {
        vi.mocked(getEnvironmentVariable).mockResolvedValue("also-expired");
        vi.mocked(authTest).mockRejectedValue(expired());

        await executeBuild(withRefresh());

        expect(rotateConfigToken).toHaveBeenCalledTimes(1);
        expect(vi.mocked(provisionPreview).mock.calls[0][0]).toMatchObject({
          slackConfigurationToken: "new-config-token",
        });
      });

      // Slack stops accepting a refresh token soon after it's used, and the
      // build that used it saves the new token right after.
      describe("and Slack refuses the refresh token", () => {
        beforeEach(() => {
          vi.mocked(rotateConfigToken).mockRejectedValue(
            new SlackAPIError("tooling.tokens.rotate", "invalid_refresh_token"),
          );
        });

        it("waits for the other build to save its token", async () => {
          vi.mocked(getEnvironmentVariable)
            .mockResolvedValueOnce("config-token")
            .mockResolvedValueOnce("config-token")
            .mockResolvedValueOnce("config-token")
            .mockResolvedValueOnce("rotated-by-other");

          await executeBuild(withRefresh());

          expect(rotateConfigToken).toHaveBeenCalledTimes(1);
          expect(wait).toHaveBeenCalledTimes(2);
          expect(vi.mocked(provisionPreview).mock.calls[0][0]).toMatchObject({
            slackConfigurationToken: "rotated-by-other",
          });
        });

        it("says the refresh token may be invalid when no working token turns up", async () => {
          vi.mocked(getEnvironmentVariable).mockResolvedValue("config-token");

          const error = await executeBuild(withRefresh()).catch(
            (e: Error) => e,
          );

          expect(error?.message).toContain(
            "Failed to rotate configuration token — refresh token may be invalid.",
          );
          expect(error?.cause).toMatchObject({ code: "invalid_refresh_token" });
          // Once before rotating, then five times after.
          expect(getEnvironmentVariables).toHaveBeenCalledTimes(6);
          expect(wait).toHaveBeenCalledTimes(4);
          expect(addEnvironmentVariables).not.toHaveBeenCalled();
          expect(provisionPreview).not.toHaveBeenCalled();
        });
      });
    });
  });

  it("warns and carries on when the service token is invalid", async () => {
    vi.mocked(authTest)
      .mockResolvedValueOnce({ userId: "U1", teamId: "T1" })
      .mockRejectedValueOnce(new SlackAPIError("auth.test", "invalid_auth"));

    await executeBuild(createParams({ slackServiceToken: "bad-service" }));

    expect(authTest).toHaveBeenNthCalledWith(2, { token: "bad-service" });
    expect(printed()).toContain("SLACK_SERVICE_TOKEN is invalid");
    expect(provisionPreview).toHaveBeenCalled();
  });

  it("fails when the branch isn't known", async () => {
    await expect(executeBuild(createParams({ branch: "" }))).rejects.toThrow(
      "VERCEL_GIT_COMMIT_REF is not set",
    );

    expect(provisionPreview).not.toHaveBeenCalled();
  });

  it("fails when the Vercel token can't read the project", async () => {
    const forbidden = new Error("Failed to access Vercel project: 403");
    vi.mocked(getProject).mockRejectedValue(forbidden);

    const error = await executeBuild(createParams()).catch((e: Error) => e);

    expect(error?.message).toContain(
      "Vercel API token cannot access this project.",
    );
    expect(error?.cause).toBe(forbidden);
    expect(provisionPreview).not.toHaveBeenCalled();
  });

  it("fails before touching Slack when the manifest is missing", async () => {
    await expect(
      executeBuild(createParams({ manifestPath: "missing.json" })),
    ).rejects.toThrow("No manifest found at missing.json.");

    expect(provisionPreview).not.toHaveBeenCalled();
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
      ).toBeLessThan(vi.mocked(provisionPreview).mock.invocationCallOrder[0]);
    });

    it("warns and carries on when cleanup fails", async () => {
      vi.mocked(cleanupOrphanedApps).mockRejectedValue(
        new Error("Failed to fetch active branches: 500"),
      );

      await executeBuild(createParams(), { cleanup: true });

      expect(printed()).toContain(
        "Orphan cleanup failed: Failed to fetch active branches: 500",
      );
      expect(provisionPreview).toHaveBeenCalled();
    });
  });
});
