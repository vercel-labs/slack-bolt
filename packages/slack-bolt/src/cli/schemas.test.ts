import { describe, expect, it } from "vitest";
import { validateAndBuildParams } from "./schemas";

/** What Vercel and the project provide on a preview build. */
const env = {
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "feat/thing",
  VERCEL_PROJECT_ID: "prj_123",
  VERCEL_URL: "my-app-abc123.vercel.app",
  VERCEL_BRANCH_URL: "my-app-git-feat-thing.vercel.app",
  VERCEL_TEAM_ID: "team_456",
  VERCEL_GIT_COMMIT_SHA: "abcdef1234567890",
  VERCEL_GIT_COMMIT_MESSAGE: "Add thing",
  VERCEL_GIT_COMMIT_AUTHOR_LOGIN: "octocat",
  VERCEL_DEPLOYMENT_ID: "dpl_1",
  VERCEL_AUTOMATION_BYPASS_SECRET: "bypass",
  SLACK_APP_ID: "A1",
  SLACK_CONFIGURATION_TOKEN: "config-token",
  SLACK_SERVICE_TOKEN: "service-token",
  SLACK_CONFIG_REFRESH_TOKEN: "refresh-token",
  MANIFEST_PATH: "slack/manifest.yaml",
  VERCEL_API_TOKEN: "vercel-token",
};

const without = (...keys: (keyof typeof env)[]) =>
  Object.fromEntries(
    Object.entries(env).filter(([key]) => !keys.includes(key as never)),
  );

describe("validateAndBuildParams", () => {
  it("maps every environment variable to its preview parameter", () => {
    expect(validateAndBuildParams(env)).toEqual({
      branch: "feat/thing",
      projectId: "prj_123",
      deploymentUrl: "my-app-abc123.vercel.app",
      branchUrl: "my-app-git-feat-thing.vercel.app",
      teamId: "team_456",
      commitSha: "abcdef1234567890",
      commitMessage: "Add thing",
      commitAuthor: "octocat",
      deploymentId: "dpl_1",
      automationBypassSecret: "bypass",
      slackAppId: "A1",
      slackConfigurationToken: "config-token",
      slackConfigRefreshToken: "refresh-token",
      slackServiceToken: "service-token",
      manifestPath: "slack/manifest.yaml",
      vercelApiToken: "vercel-token",
    });
  });

  it("only needs the required variables, and defaults the manifest path", () => {
    expect(
      validateAndBuildParams({
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "feat/thing",
        VERCEL_PROJECT_ID: "prj_123",
        VERCEL_URL: "my-app-abc123.vercel.app",
        SLACK_CONFIGURATION_TOKEN: "config-token",
        VERCEL_API_TOKEN: "vercel-token",
      }),
    ).toMatchObject({
      manifestPath: "manifest.json",
      slackAppId: undefined,
      slackServiceToken: undefined,
      deploymentId: undefined,
    });
  });

  // Joined to the working directory, an empty path names the directory.
  it("defaults the manifest path when MANIFEST_PATH is empty", () => {
    expect(
      validateAndBuildParams({ ...env, MANIFEST_PATH: "" }).manifestPath,
    ).toBe("manifest.json");
  });

  it("names the missing Vercel system variables", () => {
    expect(() =>
      validateAndBuildParams(without("VERCEL_GIT_COMMIT_REF", "VERCEL_URL")),
    ).toThrow(
      'Missing system environment variables: VERCEL_GIT_COMMIT_REF, VERCEL_URL\nTurn on "Automatically expose System Environment Variables" in your Vercel project: https://vercel.com/docs/projects/environment-variables/system-environment-variables',
    );
  });

  it("names the missing Slack variable", () => {
    expect(() =>
      validateAndBuildParams(without("SLACK_CONFIGURATION_TOKEN")),
    ).toThrow(
      "Missing SLACK_CONFIGURATION_TOKEN\nGenerate a configuration token and add it to your Vercel project: https://api.slack.com/apps",
    );
  });

  it("names the missing Vercel API token", () => {
    expect(() => validateAndBuildParams(without("VERCEL_API_TOKEN"))).toThrow(
      "Missing VERCEL_API_TOKEN\nCreate a token and add it to your Vercel project: https://vercel.com/account/settings/tokens",
    );
  });

  it("never puts a variable's value in the error", () => {
    expect(() =>
      validateAndBuildParams({ ...without("VERCEL_API_TOKEN") }),
    ).not.toThrow(/config-token|service-token|refresh-token/);
  });
});
