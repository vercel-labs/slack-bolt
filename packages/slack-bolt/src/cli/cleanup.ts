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

const plural = (count: number) =>
  `${count} ${count === 1 ? "branch" : "branches"}`;

/** What a branch is left with when its cleanup can't finish. */
const KEPT = "Kept its app and variables; the next build tries again.";

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
    log.info("Nothing to clean up");
    return;
  }

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
        `Couldn't read SLACK_APP_ID of branch ${branch}: ${message(error)}`,
      );
      log.info(KEPT);
      continue;
    }

    // Vercel returns no value for a Sensitive variable. Without the ID the
    // app can't be deleted, and deleting the variables would lose it.
    if (!appId) {
      leftBehind++;
      log.warning(
        `Couldn't read SLACK_APP_ID of branch ${branch}: Vercel returned no value`,
      );
      log.info(
        "Kept the branch's variables. If SLACK_APP_ID is Sensitive, delete the branch's app and SLACK_ variables yourself.",
      );
      continue;
    }

    const removed = await removeSlackApp({
      token: slackConfigurationToken,
      appId,
    });
    if (removed.status === "failed") {
      leftBehind++;
      log.warning(
        `Couldn't delete app ${appId} of branch ${branch}: ${message(removed.error)}`,
      );
      // An outage or a refused token passes. A refusal for this app gets
      // the same answer on every build, until someone steps in.
      log.info(
        isTransient(removed.error) || isTokenError(removed.error)
          ? KEPT
          : `Slack will refuse again. Delete the app (https://api.slack.com/apps/${appId}), or if it isn't yours, the branch's SLACK_ variables in Vercel.`,
      );
      continue;
    }
    log.info(
      removed.status === "gone"
        ? `App ${appId} of branch ${branch} was already deleted`
        : `Deleted app ${appId} of branch ${branch}`,
    );

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
            `Couldn't delete ${env.key} of branch ${branch}: ${message(error)}`,
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
        `Couldn't delete SLACK_APP_ID of branch ${branch}: ${message(error)}`,
      );
    }
  }

  // Each branch that was left has said why, and what happens to it next.
  if (leftBehind > 0) return;
  log.success(`Cleaned up ${plural(staleBranches.size)}`);
}
