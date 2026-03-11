import fs from "node:fs";
import path from "node:path";
import { createNewManifest } from "./internal/manifest";
import { parseManifest, stringifyManifest } from "./internal/manifest/parse";
import { installApp, upsertSlackApp } from "./internal/slack";
import type {
  SlackManifestCreateResponse,
  SlackManifestUpdateResponse,
} from "./internal/slack/types";
import {
  addEnvironmentVariables,
  updateProtectionBypass,
} from "./internal/vercel";
import type { CreateProjectEnv } from "./internal/vercel/types";
import { log } from "./logger";

export type PreviewParams = {
  slackConfigRefreshToken?: string;
  automationBypassSecret?: string;
  branch: string;
  branchUrl?: string;
  commitAuthor?: string;
  commitMessage?: string;
  commitSha?: string;
  deploymentId?: string;
  deploymentUrl: string;
  manifestPath: string;
  projectId: string;
  slackAppId?: string;
  slackConfigurationToken: string;
  slackServiceToken?: string;
  teamId?: string;
  vercelApiToken: string;
};

export type PreviewResult = {
  isNew: boolean;
  installStatus: string;
  app: SlackManifestCreateResponse | SlackManifestUpdateResponse;
};

export const preview = async (
  params: PreviewParams,
  context?: "cli",
): Promise<PreviewResult> => {
  const {
    branch,
    projectId,
    deploymentUrl,
    teamId,
    commitAuthor,
    commitMessage: commitMsg,
    commitSha,
    slackAppId,
    slackConfigurationToken,
    slackServiceToken,
    manifestPath,
    vercelApiToken,
  } = params;

  const cli = context === "cli";
  const branchUrl = params.branchUrl ?? deploymentUrl;
  let bypassSecret = params.automationBypassSecret;

  if (!bypassSecret) {
    if (cli) log.step("Generating automation bypass secret");
    bypassSecret = await updateProtectionBypass({
      projectId,
      token: vercelApiToken,
      teamId,
    });
    if (cli) log.success("Automation bypass secret generated");
  }

  if (cli) log.step(`Reading manifest from ${manifestPath}`);
  const rawFileManifest = fs.readFileSync(
    path.join(process.cwd(), manifestPath),
    "utf8",
  );
  const manifest = parseManifest(rawFileManifest, manifestPath);

  const newManifest = createNewManifest({
    originalManifest: manifest,
    branchUrl,
    bypassSecret,
    branch,
    commitSha,
    commitMessage: commitMsg,
    commitAuthor,
  });

  // write new manifest so user-land imports of manifest.json see the updated version
  fs.writeFileSync(
    path.join(process.cwd(), manifestPath),
    stringifyManifest(newManifest, manifestPath),
    "utf8",
  );
  if (cli) log.success(`Manifest updated for ${branchUrl}`);

  if (cli) log.step("Creating or updating Slack app");
  const { isNew, app } = await upsertSlackApp({
    token: slackConfigurationToken,
    appId: slackAppId,
    manifest: newManifest,
  });

  if (isNew) {
    const credentialEnvs: CreateProjectEnv[] = [];
    if (app.app_id) {
      credentialEnvs.push({
        key: "SLACK_APP_ID",
        value: app.app_id,
        type: "encrypted",
        target: ["preview"],
        gitBranch: branch,
        comment: `Created by @vercel/slack-bolt for app ${app.app_id} on branch ${branch}`,
      });
    }
    if (app.credentials?.client_id) {
      credentialEnvs.push({
        key: "SLACK_CLIENT_ID",
        value: app.credentials.client_id,
        type: "encrypted",
        target: ["preview"],
        gitBranch: branch,
        comment: `Created by @vercel/slack-bolt for app ${app.app_id} on branch ${branch}`,
      });
    }
    if (app.credentials?.client_secret) {
      credentialEnvs.push({
        key: "SLACK_CLIENT_SECRET",
        value: app.credentials.client_secret,
        type: "encrypted",
        target: ["preview"],
        gitBranch: branch,
        comment: `Created by @vercel/slack-bolt for app ${app.app_id} on branch ${branch}`,
      });
    }
    if (app.credentials?.signing_secret) {
      credentialEnvs.push({
        key: "SLACK_SIGNING_SECRET",
        value: app.credentials.signing_secret,
        type: "encrypted",
        target: ["preview"],
        gitBranch: branch,
        comment: `Created by @vercel/slack-bolt for app ${app.app_id} on branch ${branch}`,
      });
    }
    if (credentialEnvs.length > 0) {
      await addEnvironmentVariables({
        projectId,
        token: vercelApiToken,
        teamId,
        envs: credentialEnvs,
      });
    }
  }

  if (cli)
    log.success(`${isNew ? "Created" : "Updated"} Slack app ${app.app_id}`);

  if (cli) log.step("Installing Slack app");
  const { status, botToken, appLevelToken, userToken } = await installApp({
    serviceToken: slackServiceToken,
    appId: app.app_id,
    botScopes: manifest.oauth_config?.scopes?.bot ?? [],
  });

  if (isNew) {
    const tokenEnvs: CreateProjectEnv[] = [];
    if (botToken) {
      tokenEnvs.push({
        key: "SLACK_BOT_TOKEN",
        value: botToken,
        type: "encrypted",
        target: ["preview"],
        gitBranch: branch,
        comment: `Created by @vercel/slack-bolt for app ${app.app_id} on branch ${branch}`,
      });
    }
    if (appLevelToken) {
      tokenEnvs.push({
        key: "SLACK_APP_LEVEL_TOKEN",
        value: appLevelToken,
        type: "encrypted",
        target: ["preview"],
        gitBranch: branch,
        comment: `Created by @vercel/slack-bolt for app ${app.app_id} on branch ${branch}`,
      });
    }
    if (userToken) {
      tokenEnvs.push({
        key: "SLACK_USER_TOKEN",
        value: userToken,
        type: "encrypted",
        target: ["preview"],
        gitBranch: branch,
        comment: `Created by @vercel/slack-bolt for app ${app.app_id} on branch ${branch}`,
      });
    }
    if (tokenEnvs.length > 0) {
      await addEnvironmentVariables({
        projectId,
        token: vercelApiToken,
        teamId,
        envs: tokenEnvs,
      });
    }
  }

  if (cli) {
    switch (status) {
      case "missing_service_token":
        log.warning(
          "SLACK_SERVICE_TOKEN is not set — app must be installed manually",
        );
        log.info("https://docs.slack.dev/authentication/tokens/#service");
        break;
      case "installed":
        log.success(`Installed Slack app ${app.app_id}`);
        break;
      case "app_approval_request_eligible":
        log.warning("App requires approval before it can be installed");
        break;
      case "app_approval_request_pending":
        log.warning("App is pending approval before it can be installed");
        break;
      case "app_approval_request_denied":
        log.warning("App approval request was denied");
        break;
      case "no_access":
        log.warning(
          `SLACK_SERVICE_TOKEN does not have access to app ${app.app_id}. ` +
            "This usually means the service token and configuration token were created by different users. " +
            "Ensure both tokens are generated by the same Slack user.\n" +
            "https://docs.slack.dev/authentication/tokens/#service",
        );
        break;
      case "slack_api_error":
        log.warning("Slack API error while installing the app");
        break;
      case "unknown_error":
        log.warning("Unknown error while installing the app");
        break;
    }
    console.log();
    if (app.app_id) {
      log.info(`View app: https://api.slack.com/apps/${app.app_id}`);
    }
    if (isNew && app.oauth_authorize_url) {
      log.info(`Install URL: ${app.oauth_authorize_url}`);
    }
    console.log();
  }

  return {
    isNew,
    installStatus: status,
    app,
  };
};
