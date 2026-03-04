import fs from "node:fs";
import path from "node:path";
import type { Manifest } from "@slack/web-api/dist/types/request/manifest";
import type { CreateProjectEnv21 } from "@vercel/sdk/esm/models/createprojectenvop";
import { createNewManifest } from "./internal/manifest";
import { installApp, upsertSlackApp } from "./internal/slack";
import type {
  SlackManifestCreateResponse,
  SlackManifestUpdateResponse,
} from "./internal/slack/types";
import {
  addEnvironmentVariables,
  updateProtectionBypass,
} from "./internal/vercel";

export type PreviewParams = {
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

  const branchUrl = params.branchUrl ?? deploymentUrl;
  let bypassSecret = params.automationBypassSecret;

  // generate bypass secret if not provided
  if (!bypassSecret) {
    bypassSecret = await updateProtectionBypass({
      projectId,
      token: vercelApiToken,
      teamId,
    });
  }

  // read raw manifest from file for source of truth
  const rawFileManifest = fs.readFileSync(
    path.join(process.cwd(), manifestPath),
    "utf8",
  );
  const manifest = JSON.parse(rawFileManifest) as Manifest;

  // create new manifest for preview deployment with deployment protection bypass
  const newManifest = createNewManifest({
    originalManifest: manifest,
    branchUrl,
    bypassSecret,
    branch,
    commitSha,
    commitMessage: commitMsg,
    commitAuthor,
  });

  // write new manifest to file so user land code that imports manifest.json sees the new one
  // sometimes devs will import manifest.json so they can read scopes from manifest.json as single source of truth
  fs.writeFileSync(
    path.join(process.cwd(), manifestPath),
    JSON.stringify(newManifest, null, 2),
    "utf8",
  );

  const { isNew, app } = await upsertSlackApp({
    token: slackConfigurationToken,
    appId: slackAppId,
    manifest: newManifest,
  });

  // If new app, create env vars. These don't change when the app is updated.
  if (isNew) {
    const envs: CreateProjectEnv21[] = [];
    if (app.credentials?.client_id) {
      envs.push({
        key: "SLACK_CLIENT_ID",
        value: app.credentials.client_id,
        type: "encrypted",
        target: ["preview"],
        gitBranch: branch,
        comment: `Created by @vercel/slack-bolt for app ${app.app_id} on branch ${branch}`,
      });
    }
    if (app.credentials?.client_secret) {
      envs.push({
        key: "SLACK_CLIENT_SECRET",
        value: app.credentials.client_secret,
        type: "encrypted",
        target: ["preview"],
        gitBranch: branch,
        comment: `Created by @vercel/slack-bolt for app ${app.app_id} on branch ${branch}`,
      });
    }
    if (app.credentials?.signing_secret) {
      envs.push({
        key: "SLACK_SIGNING_SECRET",
        value: app.credentials.signing_secret,
        type: "encrypted",
        target: ["preview"],
        gitBranch: branch,
        comment: `Created by @vercel/slack-bolt for app ${app.app_id} on branch ${branch}`,
      });
    }
    await addEnvironmentVariables({
      projectId,
      token: vercelApiToken,
      teamId,
      envs,
    });
  }

  const { status, botToken, appLevelToken, userToken } = await installApp({
    serviceToken: slackServiceToken,
    appId: app.app_id,
    botScopes: manifest.oauth_config?.scopes?.bot ?? [],
  });

  const envs: CreateProjectEnv21[] = [];

  if (botToken) {
    envs.push({
      key: "SLACK_BOT_TOKEN",
      value: botToken,
      type: "encrypted",
      target: ["preview"],
      gitBranch: branch,
      comment: `Created by @vercel/slack-bolt for app ${app.app_id} on branch ${branch}`,
    });
  }

  if (appLevelToken) {
    envs.push({
      key: "SLACK_APP_LEVEL_TOKEN",
      value: appLevelToken,
      type: "encrypted",
      target: ["preview"],
      gitBranch: branch,
      comment: `Created by @vercel/slack-bolt for app ${app.app_id} on branch ${branch}`,
    });
  }

  if (userToken) {
    envs.push({
      key: "SLACK_USER_TOKEN",
      value: userToken,
      type: "encrypted",
      target: ["preview"],
      gitBranch: branch,
      comment: `Created by @vercel/slack-bolt for app ${app.app_id} on branch ${branch}`,
    });
  }

  await addEnvironmentVariables({
    projectId,
    token: vercelApiToken,
    teamId,
    envs,
  });

  return {
    isNew,
    installStatus: status,
    app,
  };
};
