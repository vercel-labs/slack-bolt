// A branch's preview app is recorded in the Vercel project, as preview
// variables scoped to the branch. `SLACK_APP_ID` says which app is the
// branch's; the others are what the branch's deployments run with.
//
// The project is read to find a branch's app, never the build's own
// environment: a variable there can come from anywhere, like a
// `SLACK_APP_ID` set for every preview, or production's.
import {
  isAccessDenied,
  isTransient,
  messageOf,
  problem,
  RETRY,
} from "./errors";
import type { EnvVar, StoredEnv, Vercel } from "./vercel";

export const APP_ID = "SLACK_APP_ID";

/** What an installation's tokens are saved as. */
export const TOKEN_KEYS = [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_LEVEL_TOKEN",
  "SLACK_USER_TOKEN",
];

/** Every variable saved for a branch's app. */
const MANAGED = new Set([
  APP_ID,
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  ...TOKEN_KEYS,
]);

/**
 * Identifiers that anyone who can see the app can see. They're saved
 * readable, so the app can be found again and deleted.
 */
const IDENTIFIERS = new Set([APP_ID, "SLACK_CLIENT_ID"]);

/** The variables of a branch's app, among the project's. */
export const variablesOf = (envs: StoredEnv[], branch: string): StoredEnv[] =>
  envs.filter((env) => env.gitBranch === branch && MANAGED.has(env.key));

/** A variable of a branch's app, ready to save. */
export function variable(
  key: string,
  value: string,
  app: { id: string; branch: string; sensitive: boolean },
): EnvVar {
  return {
    key,
    value,
    type: IDENTIFIERS.has(key)
      ? "plain"
      : app.sensitive
        ? "sensitive"
        : "encrypted",
    target: ["preview"],
    gitBranch: app.branch,
    comment: `Slack app ${app.id} for the ${app.branch} preview. Managed by @vercel/slack-bolt.`,
  };
}

/**
 * The app ID a `SLACK_APP_ID` variable holds, or `null` when Vercel won't
 * show it, like a Sensitive one's.
 */
export async function appIdOf(
  vercel: Vercel,
  record: StoredEnv,
): Promise<string | null> {
  return record.value ?? (await vercel.readEnv(record.id));
}

/**
 * The project's variables. The first thing a run asks Vercel, so this is
 * also where a token that can't reach the project is found out.
 */
export async function listVariables(vercel: Vercel): Promise<StoredEnv[]> {
  try {
    return await vercel.listEnv();
  } catch (error) {
    if (isAccessDenied(error)) {
      throw problem(
        "VERCEL_API_TOKEN can't read this project's environment variables",
        "Check that it's valid, hasn't expired, and covers the project's team. For a team's project, VERCEL_TEAM_ID has to be set too: https://vercel.com/account/settings/tokens",
        error,
      );
    }
    throw problem(
      `Couldn't list the project's environment variables: ${messageOf(error)}`,
      isTransient(error)
        ? RETRY
        : "This looks like a bug in @vercel/slack-bolt. Please report it: https://github.com/vercel-labs/slack-bolt/issues",
      error,
    );
  }
}
