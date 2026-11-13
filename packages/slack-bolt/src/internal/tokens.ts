// Slack's configuration tokens expire after 12 hours, and come with a refresh
// token that can be traded once for a new pair. Both are kept in the Vercel
// project, where a run that rotates them saves the new pair for the next.
import { isTransient, messageOf, problem, RETRY, SlackError } from "./errors";
import type { Log } from "./log";
import { secret } from "./secrets";
import type { Slack } from "./slack";
import type { EnvVar, StoredEnv, Vercel } from "./vercel";
import { wait } from "./wait";

const CONFIG = "SLACK_CONFIGURATION_TOKEN";
const REFRESH = "SLACK_CONFIG_REFRESH_TOKEN";
const APPS = "https://api.slack.com/apps";

/** How often, and how far apart, to look for a token another run is saving. */
const LOOKS = 5;
const LOOK_EVERY_MS = 1500;

/** The stored variables for a token: project-wide ones, a preview's first. */
const recordsOf = (envs: StoredEnv[], key: string): StoredEnv[] =>
  envs
    .filter((env) => env.key === key && !env.gitBranch)
    .sort(
      (a, b) =>
        Number(b.target.includes("preview")) -
        Number(a.target.includes("preview")),
    );

/** The value of the first of the variables that Vercel shows. */
async function valueOf(
  vercel: Vercel,
  records: StoredEnv[],
): Promise<string | undefined> {
  for (const record of records) {
    const value =
      record.value ??
      (await vercel.readEnv(record.id).catch((error: unknown) => {
        // An outage doesn't mean there's no value: only a refusal does.
        if (isTransient(error)) throw error;
        return null;
      }));
    if (value) return secret(value);
  }
  return undefined;
}

/**
 * Saves a rotated pair over the stored one, in the environments and with the
 * type each variable has: rotating never copies a token kept to Preview into
 * Production, or makes a Sensitive one readable. Tokens that aren't stored
 * yet are saved for Production and Preview, where this package runs.
 */
async function save(
  vercel: Vercel,
  envs: StoredEnv[],
  rotated: { token: string; refreshToken: string },
): Promise<void> {
  const pairs: [string, string][] = [
    [CONFIG, rotated.token],
    [REFRESH, rotated.refreshToken],
  ];
  const variables = pairs.flatMap(([key, value]): EnvVar[] => {
    const stored = recordsOf(envs, key).filter((env) => env.target.length > 0);
    if (stored.length === 0) {
      return [
        { key, value, type: "encrypted", target: ["production", "preview"] },
      ];
    }
    return stored.map((env) => ({
      key,
      value,
      type: env.type === "sensitive" ? "sensitive" : "encrypted",
      target: env.target,
    }));
  });

  try {
    await vercel.saveEnv(variables);
  } catch (error) {
    // Slack has issued the new pair, so the stored one is spent.
    throw problem(
      `Rotated ${CONFIG}, but couldn't save the new tokens to Vercel: ${messageOf(error)}`,
      `The stored tokens no longer work. Check that VERCEL_API_TOKEN can write environment variables, then generate both tokens again and save them: ${APPS}`,
      error,
    );
  }
}

/**
 * Resolves with a configuration token Slack accepts: the run's own, a newer
 * one stored in the project, or one this run rotates to and saves.
 *
 * @param envs The project's variables, as just listed.
 */
export async function usableConfigToken({
  slack,
  vercel,
  log,
  envs,
  token,
  refreshToken,
}: {
  slack: Slack;
  vercel: Vercel;
  log: Log;
  envs: StoredEnv[];
  token?: string;
  refreshToken?: string;
}): Promise<string> {
  let refusal: unknown;
  if (token) {
    try {
      await slack.authTest(token);
      return token;
    } catch (error) {
      // An outage says nothing about the token, and rotating spends the
      // refresh token. Don't replace a token that may be fine.
      if (isTransient(error)) {
        throw problem(
          `Couldn't check ${CONFIG}: ${messageOf(error)}`,
          RETRY,
          error,
        );
      }
      refusal = error;
    }
  }

  /**
   * A stored token that isn't this run's, when Slack accepts it.
   *
   * @throws When Slack or Vercel gives no verdict: the stored token may be
   * fine, and rotating would spend its refresh token.
   */
  const newer = async (list: StoredEnv[]): Promise<string | undefined> => {
    const stored = await valueOf(vercel, recordsOf(list, CONFIG));
    if (!stored || stored === token) return undefined;
    try {
      await slack.authTest(stored);
      return stored;
    } catch (error) {
      if (isTransient(error)) throw error;
      return undefined;
    }
  };

  /** Runs a check that has to finish before rotating, or stops the run. */
  const beforeRotating = async <T>(check: () => Promise<T>): Promise<T> => {
    try {
      return await check();
    } catch (error) {
      if (!isTransient(error)) throw error;
      throw problem(
        `Couldn't check the stored ${CONFIG}: ${messageOf(error)}`,
        RETRY,
        error,
      );
    }
  };

  // A run gets its variables when its deployment is created. One that
  // waited in the queue, like the last of a batch of dependency updates,
  // can start with tokens an earlier run has replaced since.
  const found = await beforeRotating(() => newer(envs));
  if (found) {
    if (token) log.ok(`Using the ${CONFIG} another build rotated to`);
    return found;
  }

  // The stored refresh token is the newest there is.
  const storedRefresh = recordsOf(envs, REFRESH);
  const readable = await beforeRotating(() => valueOf(vercel, storedRefresh));
  const refresh = readable ?? refreshToken;
  // Vercel won't show a Sensitive one, so this run has to go with what its
  // deployment was created with, which another run may have spent since.
  const unreadable = !readable && storedRefresh.length > 0;
  if (!refresh) {
    throw token
      ? problem(
          `Slack refused ${CONFIG} (${refusal instanceof SlackError ? refusal.code : messageOf(refusal)})`,
          `Configuration tokens expire after 12 hours. Generate a new one and save it in Vercel, with its refresh token as ${REFRESH} so it's rotated from then on: ${APPS}`,
          refusal,
        )
      : problem(
          `${CONFIG} is not set`,
          `Generate a configuration token and save it in Vercel, with its refresh token as ${REFRESH}: ${APPS}`,
        );
  }

  let rotated: { token: string; refreshToken: string };
  try {
    rotated = await slack.rotate(refresh);
  } catch (error) {
    if (isTransient(error)) {
      throw problem(
        `Couldn't rotate ${CONFIG}: ${messageOf(error)}`,
        RETRY,
        error,
      );
    }
    // Slack refused the refresh token. When that's because another run just
    // used it, that run saves its new token right after, so look for it for
    // a moment.
    for (let look = 0; look < LOOKS; look++) {
      await wait(LOOK_EVERY_MS);
      const saved = await vercel
        .listEnv()
        .then(newer)
        .catch(() => undefined);
      if (saved) {
        log.ok(`Using the ${CONFIG} another build rotated to`);
        return saved;
      }
    }
    const refused = `Slack refused ${REFRESH} (${error instanceof SlackError ? error.code : messageOf(error)}), so ${CONFIG} can't be rotated`;
    throw unreadable
      ? problem(
          `${refused}. Another build has probably rotated the tokens since this deployment was created, and Vercel doesn't show Sensitive values, so this one can't read the new ones`,
          `Redeploy to pick them up. If that fails too, generate both tokens again and save them in Vercel: ${APPS}`,
          error,
        )
      : problem(
          refused,
          `Generate both tokens again and save them in Vercel: ${APPS}`,
          error,
        );
  }

  await save(vercel, envs, rotated);
  log.ok(`Rotated ${CONFIG} and saved it to Vercel`);
  return rotated.token;
}
