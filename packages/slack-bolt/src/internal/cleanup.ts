import type { CleanupResult } from "../preview";
import type { CleanupContext } from "./context";
import {
  isAppMissing,
  isAppUnreachable,
  isTokenRefused,
  isTransient,
  messageOf,
  problem,
} from "./errors";
import { APP_ID, appIdOf, listVariables, variablesOf } from "./records";
import { createSlack, type Slack } from "./slack";
import { usableConfigToken } from "./tokens";
import { createVercel, type StoredEnv, type Vercel } from "./vercel";

const SETTINGS = "https://api.slack.com/apps";

/** What to do when the branches that are gone can't be worked out. */
const NAME_ONE =
  "Nothing was removed. To remove one branch's app, name it: vercel-slack cleanup --branch <name>";

/**
 * The branches Vercel still has, checked for what would make the answer
 * dangerous to act on. Every branch that isn't in it loses its app.
 */
async function activeBranches(
  vercel: Vercel,
  building: string | undefined,
): Promise<Set<string>> {
  let active: Set<string>;
  try {
    active = await vercel.activeBranches();
  } catch (error) {
    throw problem(
      `Couldn't tell which branches are still active: ${messageOf(error)}`,
      NAME_ONE,
      error,
    );
  }
  // No branches at all can't be told from an answer that went wrong.
  if (active.size === 0) {
    throw problem("Vercel lists no active branches", NAME_ONE);
  }
  if (building && !active.has(building)) {
    throw problem(
      `Vercel's list of active branches doesn't have ${building}, the branch being built, so it may not be complete`,
      NAME_ONE,
    );
  }
  return active;
}

/** Deletes an app. Resolves with whether it was there to delete. */
async function deleteApp(
  slack: Slack,
  token: string,
  appId: string,
): Promise<"deleted" | "gone"> {
  try {
    await slack.deleteApp(token, appId);
    return "deleted";
  } catch (error) {
    if (isAppMissing(error)) return "gone";
    // Slack refuses to delete an app that's already deleted the same way it
    // refuses one the token may not delete, so ask for the app to tell them
    // apart.
    if (
      isAppUnreachable(error) &&
      !(await slack.appExists(token, appId).catch(() => true))
    ) {
      return "gone";
    }
    throw error;
  }
}

/**
 * Deletes the Slack apps and the variables of branches that are gone: the
 * ones named, or else every branch with a preview app that Vercel no longer
 * lists as active.
 *
 * A branch's app goes first and its `SLACK_APP_ID` last. That variable is
 * the only record of the app, so whatever fails on the way is found and
 * tried again by the next run, and nothing is left where no run can find it.
 *
 * @throws When the branches that are gone can't be worked out, or there's no
 * usable configuration token. Nothing is removed then.
 */
export async function cleanUp(ctx: CleanupContext): Promise<CleanupResult> {
  const { log, dryRun } = ctx;
  const slack = createSlack(log);
  const vercel = createVercel({
    token: ctx.vercelToken,
    projectId: ctx.projectId,
    teamId: ctx.teamId,
    log,
  });
  const result: CleanupResult = { dryRun, removed: [], failed: [] };

  const envs = await listVariables(vercel);

  let branches: string[];
  if (ctx.branches) {
    branches = [...new Set(ctx.branches)];
    // Its deployment is running with the app, and saving its variables.
    if (ctx.building && branches.includes(ctx.building)) {
      branches = branches.filter((branch) => branch !== ctx.building);
      log.note(`Skipped ${ctx.building}: it's the branch being built`);
    }
  } else {
    // A branch has a preview app when it has a SLACK_APP_ID of its own.
    const recorded = new Set(
      envs.flatMap((env) =>
        env.key === APP_ID && env.gitBranch ? [env.gitBranch] : [],
      ),
    );
    recorded.delete(ctx.building ?? "");
    if (recorded.size > 0) {
      const active = await activeBranches(vercel, ctx.building);
      for (const branch of active) recorded.delete(branch);
    }
    branches = [...recorded];
  }

  let configToken: string | undefined;
  for (const branch of branches) {
    const variables = variablesOf(envs, branch);
    if (variables.length === 0) {
      log.note(`${branch} has no preview app`);
      continue;
    }
    const record = variables.find((item) => item.key === APP_ID);
    const fail = (reason: string, next: string, appId?: string) => {
      log.warn(`Couldn't remove ${branch}'s preview app: ${reason}`);
      log.note(next);
      result.failed.push({ branch, ...(appId && { appId }), reason });
    };

    let appId: string | undefined;
    if (record) {
      let shown: string | null;
      try {
        shown = await appIdOf(vercel, record);
      } catch (error) {
        fail(
          `couldn't read its ${APP_ID} from Vercel: ${messageOf(error)}`,
          "Kept its app and variables. The next cleanup tries again.",
        );
        continue;
      }
      // Without the ID the app can't be deleted, and deleting the variables
      // would lose track of it.
      if (!shown) {
        fail(
          `Vercel doesn't show the value of its ${APP_ID}`,
          `Delete the app (${SETTINGS}) and the branch's SLACK_ variables yourself.`,
        );
        continue;
      }
      appId = shown;
    }
    const app = appId ? `Slack app ${appId}` : "the variables";

    if (dryRun) {
      log.ok(`Would remove ${app} of ${branch}`);
      result.removed.push({ branch, ...(appId && { appId }) });
      continue;
    }

    if (appId) {
      // Fetched for the first app there is to delete, not before: rotating
      // an expired token is a change too.
      configToken ??= await usableConfigToken({
        slack,
        vercel,
        log,
        envs,
        token: ctx.slackConfigToken,
        refreshToken: ctx.slackConfigRefreshToken,
      });
      try {
        await deleteApp(slack, configToken, appId);
      } catch (error) {
        // An outage or a refused token passes. A refusal for this app gets
        // the same answer every time, until someone steps in.
        fail(
          messageOf(error),
          isTransient(error) || isTokenRefused(error)
            ? "Kept its app and variables. The next cleanup tries again."
            : `Slack will refuse again. Delete the app yourself (${SETTINGS}/${appId}), or if it isn't yours, delete the branch's SLACK_ variables in Vercel.`,
          appId,
        );
        continue;
      }
    }

    const others = variables.filter((item: StoredEnv) => item !== record);
    try {
      await vercel.deleteEnv(others.map((item) => item.id));
      if (record) await vercel.deleteEnv([record.id]);
    } catch (error) {
      fail(
        `deleted the app, but not its variables: ${messageOf(error)}`,
        "The next cleanup tries again.",
        appId,
      );
      continue;
    }
    log.ok(`Removed ${app} of ${branch}`);
    result.removed.push({ branch, ...(appId && { appId }) });
  }

  if (result.removed.length === 0 && result.failed.length === 0) {
    log.ok("No preview apps to clean up");
  }
  return result;
}
