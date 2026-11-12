import { log } from "../internal/logger";
import { isTokenError, isTransient, removeSlackApp } from "../internal/slack";
import {
  deleteEnvironmentVariable,
  getActiveBranches,
  getEnvironmentVariable,
  getEnvironmentVariables,
} from "../internal/vercel";

/**
 * Every branch-scoped variable `preview` can create for a branch's Slack app.
 * Cleanup deletes all of them, so a stale branch leaves no credentials behind.
 */
const SLACK_ENV_VAR_KEYS = [
  "SLACK_APP_ID",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_LEVEL_TOKEN",
  "SLACK_USER_TOKEN",
];

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

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

  let leftBehind = 0;
  for (const [branch, appIdEnvId] of staleBranches) {
    // SLACK_APP_ID is the only record of the branch's app, and how the next
    // cleanup finds the branch. So the branch's variables are only deleted
    // once its app is gone, and SLACK_APP_ID last of all: whatever fails
    // here is tried again on the next build, not left behind for good.
    let appId: string | null;
    try {
      appId = await getEnvironmentVariable({
        projectId,
        envId: appIdEnvId,
        token: vercelApiToken,
        teamId,
      });
    } catch (error) {
      leftBehind++;
      log.warning(
        `Failed to read SLACK_APP_ID for branch ${branch}, so its app and variables stay for now: ${message(error)}`,
      );
      continue;
    }

    if (appId) {
      const removed = await removeSlackApp({
        token: slackConfigurationToken,
        appId,
      });
      if (removed.status === "failed") {
        leftBehind++;
        log.warning(
          `Failed to delete app ${appId} (branch: ${branch}), so it and the branch's variables stay for now: ${message(removed.error)}`,
        );
        // An outage or a refused token passes. A refusal for this app gets
        // the same answer on every build, until someone steps in.
        if (!isTransient(removed.error) && !isTokenError(removed.error)) {
          log.info(
            `Slack will refuse again on the next build. Delete the app at https://api.slack.com/apps/${appId}, or if it isn't yours to delete, the branch's Slack variables in your Vercel project.`,
          );
        }
        continue;
      }
      log.info(
        `${appId} ${removed.status === "gone" ? "already deleted" : "deleted"} (branch: ${branch})`,
      );
    }

    let deletedAll = true;
    for (const env of envs) {
      if (
        env.id &&
        env.id !== appIdEnvId &&
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
          deletedAll = false;
          log.warning(
            `Failed to delete env var ${env.key} for branch ${branch}: ${message(error)}`,
          );
        }
      }
    }

    if (!deletedAll) {
      leftBehind++;
      continue;
    }
    try {
      await deleteEnvironmentVariable({
        projectId,
        envId: appIdEnvId,
        token: vercelApiToken,
        teamId,
      });
    } catch (error) {
      leftBehind++;
      log.warning(
        `Failed to delete env var SLACK_APP_ID for branch ${branch}: ${message(error)}`,
      );
    }
  }

  if (leftBehind > 0) {
    log.warning(
      `Orphan cleanup left ${leftBehind} of ${staleBranches.size} ${staleBranches.size === 1 ? "branch" : "branches"} for the next build`,
    );
    return;
  }
  log.success("Orphan cleanup completed");
}
