import type {
  CleanupOptions,
  PreviewOptions,
  PreviewSkipped,
  ProjectOptions,
} from "../preview";
import { problem } from "./errors";
import { type Log, logTo } from "./log";
import { type Commit, hostOf, type Manifest } from "./manifest";
import { secret, token } from "./secrets";

export type Env = Record<string, string | undefined>;

const ENV_DOCS = "https://vercel.com/docs/environment-variables";

/** The project, and what's needed to work on it. */
export interface Project {
  projectId: string;
  teamId?: string;
  vercelToken: string;
  /** May be missing: the project can have a stored one. */
  slackConfigToken?: string;
  slackConfigRefreshToken?: string;
  /** The environment this run sees, which is what its deployment was built with. */
  env: Env;
  /** The deployment's environment, like `production`, when this runs in one. */
  environment?: string;
  log: Log;
}

export interface PreviewContext extends Project {
  branch: string;
  host: string;
  manifest?: string | Manifest;
  cwd: string;
  deploymentId?: string;
  slackServiceToken?: string;
  bypassSecret?: string;
  commit: Commit;
  sensitive: boolean;
}

export interface CleanupContext extends Project {
  /** The branches to remove, or `undefined` for every one that's gone. */
  branches?: string[];
  /** The branch being built, when this runs in a preview deployment. */
  building?: string;
  dryRun: boolean;
}

/** An option, or else the environment variable, when either has a value. */
const pick = (option: string | undefined, env: Env, ...names: string[]) =>
  option ||
  names
    .map((name) => env[name])
    .find((value) => value !== undefined && value !== "") ||
  undefined;

/** The deployment's environment: `production`, `preview`, or a custom one's name. */
const environmentOf = (env: Env) => env.VERCEL_TARGET_ENV || env.VERCEL_ENV;

function resolveProject(options: ProjectOptions, env: Env): Project {
  const projectId = pick(options.projectId, env, "VERCEL_PROJECT_ID");
  const vercelToken = token(
    "VERCEL_API_TOKEN",
    pick(options.vercelToken, env, "VERCEL_API_TOKEN"),
  );

  if (!projectId) {
    throw problem(
      "VERCEL_PROJECT_ID is not set",
      "Vercel sets it in builds of projects that expose system environment variables. Turn that on in the project's settings, or pass the project's ID.",
    );
  }
  if (!vercelToken) {
    throw problem(
      "VERCEL_API_TOKEN is not set",
      `Create a token (https://vercel.com/account/settings/tokens) and add it to the project's environment variables: ${ENV_DOCS}`,
    );
  }

  // In a linked directory the CLI sets VERCEL_ORG_ID, which is a team's ID
  // only when it starts with `team_`.
  const org = env.VERCEL_ORG_ID?.startsWith("team_")
    ? env.VERCEL_ORG_ID
    : undefined;

  return {
    projectId,
    teamId: pick(options.teamId, env, "VERCEL_TEAM_ID") ?? org,
    vercelToken,
    slackConfigToken: token(
      "SLACK_CONFIGURATION_TOKEN",
      pick(options.slackConfigToken, env, "SLACK_CONFIGURATION_TOKEN"),
    ),
    slackConfigRefreshToken: token(
      "SLACK_CONFIG_REFRESH_TOKEN",
      pick(options.slackConfigRefreshToken, env, "SLACK_CONFIG_REFRESH_TOKEN"),
    ),
    env,
    environment: environmentOf(env) || undefined,
    log: logTo(options.logger),
  };
}

/**
 * What `preview` works with, from its options and the environment. Resolves
 * to why there's nothing to do when the deployment isn't a branch's preview.
 */
export function resolvePreview(
  options: PreviewOptions,
  env: Env,
  cwd: string,
): PreviewContext | PreviewSkipped {
  const environment = environmentOf(env);
  if (environment && environment !== "preview") {
    return {
      status: "skipped",
      reason: "not_preview",
      message: `Not a preview deployment (${environment}), so there's no preview app to set up`,
    };
  }
  const branch = pick(options.branch, env, "VERCEL_GIT_COMMIT_REF");
  if (!branch) {
    return {
      status: "skipped",
      reason: "no_branch",
      message:
        "This deployment isn't of a Git branch, so there's no preview app to set up",
    };
  }

  const url = pick(options.url, env, "VERCEL_BRANCH_URL", "VERCEL_URL");
  if (!url) {
    throw problem(
      "VERCEL_BRANCH_URL is not set",
      "Vercel sets it in builds of projects that expose system environment variables. Turn that on in the project's settings, or pass the deployment's URL.",
    );
  }

  return {
    ...resolveProject(options, env),
    branch,
    host: hostOf(url),
    manifest: options.manifest ?? (env.MANIFEST_PATH || undefined),
    cwd,
    deploymentId: pick(options.deploymentId, env, "VERCEL_DEPLOYMENT_ID"),
    slackServiceToken: token(
      "SLACK_SERVICE_TOKEN",
      pick(options.slackServiceToken, env, "SLACK_SERVICE_TOKEN"),
    ),
    bypassSecret: secret(
      pick(options.bypassSecret, env, "VERCEL_AUTOMATION_BYPASS_SECRET"),
    ),
    commit: {
      sha: pick(options.commit?.sha, env, "VERCEL_GIT_COMMIT_SHA"),
      message: pick(options.commit?.message, env, "VERCEL_GIT_COMMIT_MESSAGE"),
      author: pick(
        options.commit?.author,
        env,
        "VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
        "VERCEL_GIT_COMMIT_AUTHOR_NAME",
      ),
    },
    sensitive: options.sensitive ?? true,
  };
}

/** What `cleanup` works with, from its options and the environment. */
export function resolveCleanup(
  options: CleanupOptions,
  env: Env,
): CleanupContext {
  return {
    ...resolveProject(options, env),
    branches: options.branches?.length ? options.branches : undefined,
    building:
      environmentOf(env) === "preview"
        ? env.VERCEL_GIT_COMMIT_REF || undefined
        : undefined,
    dryRun: options.dryRun ?? false,
  };
}
