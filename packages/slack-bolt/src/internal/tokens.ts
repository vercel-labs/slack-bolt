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

/** The environments a variable can be saved for. */
const TARGETS = new Set(["production", "preview", "development"]);

/**
 * The stored variables of the token pair a run uses.
 *
 * In a deployment, the ones for its environment: a project can keep a pair
 * for each, and Production's must never be read or written for Preview, or
 * the other way around. Elsewhere, or when none are for its environment,
 * every project-wide one, a preview's first, and `bound` is false: which
 * pair the run's own tokens belong to is unknown.
 */
interface Pair {
  config: StoredEnv[];
  refresh: StoredEnv[];
  bound: boolean;
}

function pairOf(envs: StoredEnv[], environment: string | undefined): Pair {
  const all = (key: string) =>
    envs
      .filter(
        (env) => env.key === key && !env.gitBranch && env.target.length > 0,
      )
      .sort(
        (a, b) =>
          Number(b.target.includes("preview")) -
          Number(a.target.includes("preview")),
      );
  const config = all(CONFIG);
  const refresh = all(REFRESH);
  if (environment) {
    const mine = (list: StoredEnv[]) =>
      list.filter((env) => env.target.includes(environment));
    const pair = { config: mine(config), refresh: mine(refresh), bound: true };
    if (pair.config.length > 0 || pair.refresh.length > 0) return pair;
  }
  return { config, refresh, bound: false };
}

const sameTargets = (a: StoredEnv, b: StoredEnv) =>
  a.target.length === b.target.length &&
  a.target.every((target) => b.target.includes(target));

/** Where a rotated pair goes, and as what. */
interface Destination {
  config: StoredEnv[];
  refresh: StoredEnv[];
  /** For a token that has no variable yet. */
  target: string[];
  type: "encrypted" | "sensitive";
}

/**
 * Where to save the pair that replaces the one `source` holds, or that the
 * run's own refresh token belongs to when it's `undefined`. Worked out before
 * rotating, which spends the refresh token: a pair that can't be saved where
 * it came from mustn't be rotated at all.
 *
 * The new pair only replaces the variables the old one came from. It's
 * Sensitive when any of them is, or when its source can't be listed, so a
 * rotation never makes a token readable that wasn't.
 *
 * @throws When the run's own refresh token can't be told apart from the
 * pairs of several environments.
 */
function destinationOf(
  pair: Pair,
  source: StoredEnv | undefined,
  environment: string | undefined,
): Destination {
  let config: StoredEnv[];
  let refresh: StoredEnv[];
  if (source) {
    config = pair.config.filter((env) => sameTargets(env, source));
    refresh = pair.refresh.filter((env) => sameTargets(env, source));
  } else if (pair.bound) {
    ({ config, refresh } = pair);
  } else {
    // One variable for each token is one pair, whatever their environments.
    if (pair.config.length > 1 || pair.refresh.length > 1) {
      throw problem(
        `The project keeps a ${CONFIG} for each of several environments, and this run can't tell which pair its own tokens belong to`,
        `Nothing was rotated. Run it in a deployment of the environment whose token expired, or with a ${CONFIG} that works.`,
      );
    }
    ({ config, refresh } = pair);
  }

  const records = [...config, ...refresh];
  const fallback =
    environment && TARGETS.has(environment)
      ? [environment]
      : ["production", "preview"];
  return {
    config,
    refresh,
    target: (source ?? records[0])?.target ?? fallback,
    // In a deployment, tokens no listed variable holds came from somewhere
    // else, like a team's shared variable, which may be Sensitive.
    type:
      records.some((env) => env.type === "sensitive") ||
      (records.length === 0 && environment !== undefined)
        ? "sensitive"
        : "encrypted",
  };
}

/** The first of the variables that Vercel shows the value of, and the value. */
async function valueOf(
  vercel: Vercel,
  records: StoredEnv[],
): Promise<{ value: string; record: StoredEnv } | undefined> {
  for (const record of records) {
    const value =
      record.value ??
      (await vercel.readEnv(record.id).catch((error: unknown) => {
        // An outage doesn't mean there's no value: only a refusal does.
        if (isTransient(error)) throw error;
        return null;
      }));
    if (value) return { value: secret(value), record };
  }
  return undefined;
}

/** Saves a rotated pair where `destination` says. */
async function save(
  vercel: Vercel,
  destination: Destination,
  rotated: { token: string; refreshToken: string },
): Promise<void> {
  const pairs: [string, string, StoredEnv[]][] = [
    [CONFIG, rotated.token, destination.config],
    [REFRESH, rotated.refreshToken, destination.refresh],
  ];
  const variables = pairs.flatMap(([key, value, stored]): EnvVar[] =>
    (stored.length > 0
      ? stored.map((env) => env.target)
      : [destination.target]
    ).map((target) => ({ key, value, type: destination.type, target })),
  );

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
 * @param environment The deployment's environment, when this runs in one.
 */
export async function usableConfigToken({
  slack,
  vercel,
  log,
  envs,
  environment,
  token,
  refreshToken,
}: {
  slack: Slack;
  vercel: Vercel;
  log: Log;
  envs: StoredEnv[];
  environment?: string;
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
    const stored = (await valueOf(vercel, pairOf(list, environment).config))
      ?.value;
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
  const pair = pairOf(envs, environment);
  const readable = await beforeRotating(() => valueOf(vercel, pair.refresh));
  const refresh = readable?.value ?? refreshToken;
  // Vercel won't show a Sensitive one, so this run has to go with what its
  // deployment was created with, which another run may have spent since.
  const unreadable = !readable && pair.refresh.length > 0;
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

  const destination = destinationOf(pair, readable?.record, environment);

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

  await save(vercel, destination, rotated);
  log.ok(`Rotated ${CONFIG} and saved it to Vercel`);
  return rotated.token;
}
