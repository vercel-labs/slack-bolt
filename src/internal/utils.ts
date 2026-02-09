import type { Manifest } from "@slack/web-api/dist/types/request/manifest";
import { Vercel } from "@vercel/sdk";
import { SlackAppApprovalError, SlackAppNotFoundError } from "./errors";
import { log, redact } from "./logger";
import { deleteSlackApp } from "./slack";
import type { InstallResult, SlackOps, UpsertResult, VercelOps } from "./types";
import { deleteVercelEnvVars, getActiveBranches } from "./vercel";

interface VercelPreviewEnv {
  branch: string;
  projectId: string;
  branchUrl: string;
  teamId: string | null;
}

export function validatePreviewEnvironment(): VercelPreviewEnv | string {
  const branch = process.env.VERCEL_GIT_COMMIT_REF;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const branchUrl = process.env.VERCEL_BRANCH_URL;
  const teamId = process.env.VERCEL_TEAM_ID || null;

  log.debug(`Current environment snapshot:`);
  log.debug(`  SLACK_APP_ID = ${redact(process.env.SLACK_APP_ID)}`);
  log.debug(`  SLACK_CLIENT_ID = ${redact(process.env.SLACK_CLIENT_ID)}`);
  log.debug(
    `  SLACK_CLIENT_SECRET = ${redact(process.env.SLACK_CLIENT_SECRET)}`,
  );
  log.debug(
    `  SLACK_SIGNING_SECRET = ${redact(process.env.SLACK_SIGNING_SECRET)}`,
  );
  log.debug(`  SLACK_BOT_TOKEN = ${redact(process.env.SLACK_BOT_TOKEN)}`);
  log.debug(
    `  SLACK_SERVICE_TOKEN = ${redact(process.env.SLACK_SERVICE_TOKEN)}`,
  );
  log.debug(`  VERCEL_GIT_COMMIT_REF = ${branch ?? "<not set>"}`);
  log.debug(`  VERCEL_PROJECT_ID = ${projectId ?? "<not set>"}`);
  log.debug(`  VERCEL_BRANCH_URL = ${branchUrl ?? "<not set>"}`);
  log.debug(`  VERCEL_TEAM_ID = ${teamId ?? "<not set>"}`);
  log.debug(`  VERCEL_ENV = ${process.env.VERCEL_ENV ?? "<not set>"}`);
  log.debug(
    `  VERCEL_AUTOMATION_BYPASS_SECRET = ${redact(
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
    )}`,
  );

  if (process.env.VERCEL_ENV === "production") {
    return "Skipping production deployment";
  }
  if (!branch) {
    return "Missing VERCEL_GIT_COMMIT_REF";
  }
  if (!projectId) {
    return "Missing VERCEL_PROJECT_ID";
  }
  if (!branchUrl) {
    return "Missing VERCEL_BRANCH_URL";
  }

  return {
    branch,
    projectId,
    branchUrl,
    teamId,
  };
}

export async function upsertSlackApp(
  manifest: Manifest,
  branch: string,
  slack: SlackOps,
  vercel: VercelOps,
): Promise<UpsertResult> {
  let existingAppId = await vercel.getSlackAppId(branch);

  if (existingAppId) {
    try {
      await slack.updateApp(existingAppId, manifest);
      return { appId: existingAppId, installUrl: null, isNew: false };
    } catch (error) {
      if (error instanceof SlackAppNotFoundError) {
        try {
          await vercel.deleteSlackEnvVars(branch);
        } catch {}
        existingAppId = null;
      } else {
        throw error;
      }
    }
  }

  const result = await slack.createApp(manifest);

  await vercel.setEnvVars(branch, [
    { key: "SLACK_APP_ID", value: result.appId },
    { key: "SLACK_CLIENT_ID", value: result.clientId },
    { key: "SLACK_CLIENT_SECRET", value: result.clientSecret },
    { key: "SLACK_SIGNING_SECRET", value: result.signingSecret },
  ]);

  return {
    appId: result.appId,
    installUrl: result.installUrl,
    isNew: true,
  };
}

export async function tryInstallApp(
  appId: string,
  manifest: Manifest,
  slack: SlackOps,
  vercel: VercelOps,
  branch: string,
): Promise<InstallResult> {
  try {
    const botToken = await slack.installApp(appId, manifest);
    await vercel.setEnvVars(branch, [
      { key: "SLACK_BOT_TOKEN", value: botToken },
    ]);
    return { installed: true };
  } catch (error) {
    if (error instanceof SlackAppApprovalError) {
      return { installed: false, error: error.message };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { installed: false, error: msg };
  }
}

export async function cleanupOrphanedApps(
  projectId: string,
  currentBranch: string,
  vercelToken: string,
  teamId: string | null,
  slackConfigToken: string,
): Promise<void> {
  const activeBranches = await getActiveBranches(
    projectId,
    vercelToken,
    teamId,
  );

  const vercel = new Vercel({ bearerToken: vercelToken });
  const data = await vercel.projects.filterProjectEnvs({
    idOrName: projectId,
    teamId: teamId ?? undefined,
  });
  const envs: Array<{ id?: string; key: string; gitBranch?: string }> =
    "envs" in data ? data.envs : [];

  const staleBranches = new Map<string, string | undefined>();
  for (const env of envs) {
    if (
      env.key === "SLACK_APP_ID" &&
      env.gitBranch &&
      env.gitBranch !== currentBranch &&
      !activeBranches.has(env.gitBranch)
    ) {
      staleBranches.set(env.gitBranch, env.id);
    }
  }

  if (staleBranches.size === 0) {
    return;
  }

  log.task(
    `Found ${staleBranches.size} orphaned branch(es): ${[...staleBranches.keys()].join(", ")}`,
  );

  for (const [branch, envId] of staleBranches) {
    let appId: string | null = null;
    if (envId) {
      try {
        const decrypted = await vercel.projects.getProjectEnv({
          idOrName: projectId,
          id: envId,
          teamId: teamId ?? undefined,
        });
        appId = "value" in decrypted ? (decrypted.value ?? null) : null;
      } catch {
        log.warn(`Failed to decrypt SLACK_APP_ID for branch ${branch}`);
      }
    }

    if (appId) {
      try {
        await deleteSlackApp(appId, slackConfigToken);
        log.success(`Deleted Slack app ${appId} (branch: ${branch})`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("app_not_found")) {
          log.warn(`App ${appId} already deleted (branch: ${branch})`);
        } else {
          log.warn(`Failed to delete app ${appId}: ${msg}`);
        }
      }
    }

    try {
      await deleteVercelEnvVars(projectId, branch, vercelToken, teamId);
      log.success(`Deleted env vars for branch ${branch}`);
    } catch (error) {
      log.warn(
        `Failed to delete env vars for branch ${branch}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  log.success("Finished cleaning up orphaned apps");
}
