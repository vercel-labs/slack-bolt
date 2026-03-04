import { deleteSlackApp } from "./internal/slack";
import {
  deleteEnvironmentVariable,
  getActiveBranches,
  getEnvironmentVariable,
  getEnvironmentVariables,
} from "./internal/vercel";
import { log } from "./logger";

const SLACK_ENV_VAR_KEYS = [
  "SLACK_APP_ID",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
];

export async function cleanupOrphanedApps({
  projectId,
  currentBranch,
  vercelApiToken,
  teamId,
  slackConfigurationToken,
}: {
  projectId: string;
  currentBranch: string;
  vercelApiToken: string;
  teamId?: string;
  slackConfigurationToken: string;
}): Promise<void> {
  const activeBranches = await getActiveBranches({
    projectId,
    token: vercelApiToken,
    teamId,
  });

  const envs = await getEnvironmentVariables({
    projectId,
    token: vercelApiToken,
    teamId,
  });

  const staleBranches = new Map<string, string>();
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
    log.info("No orphaned preview apps found");
    return;
  }

  log.step(
    `Found ${staleBranches.size} orphaned ${staleBranches.size === 1 ? "branch" : "branches"}`,
  );

  for (const [branch, envId] of staleBranches) {
    let appId: string | null = null;
    try {
      appId = await getEnvironmentVariable({
        projectId,
        envId,
        token: vercelApiToken,
        teamId,
      });
    } catch {
      log.warning(`Failed to decrypt SLACK_APP_ID for branch ${branch}`);
    }

    if (appId) {
      try {
        await deleteSlackApp({
          token: slackConfigurationToken,
          appId,
        });
        log.info(`${appId} deleted (branch: ${branch})`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("app_not_found")) {
          log.info(`${appId} already deleted (branch: ${branch})`);
        } else {
          log.warning(`Failed to delete app ${appId}: ${msg}`);
        }
      }
    }

    for (const env of envs) {
      if (
        env.id &&
        env.gitBranch === branch &&
        SLACK_ENV_VAR_KEYS.includes(env.key)
      ) {
        try {
          await deleteEnvironmentVariable({
            projectId,
            envId: env.id,
            token: vercelApiToken,
            teamId,
          });
        } catch (error) {
          log.warning(
            `Failed to delete env var ${env.key} for branch ${branch}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }
  }

  log.success("Orphan cleanup completed");
}
