import { cleanUp } from "./internal/cleanup";
import { resolveCleanup, resolvePreview } from "./internal/context";
import { type Logger, logTo } from "./internal/log";
import type { Manifest } from "./internal/manifest";
import { provision } from "./internal/provision";
import { scrubError } from "./internal/secrets";

export type { Logger, Manifest };

/**
 * The Vercel project and the tokens to work on it with. Each option defaults
 * to the environment variable named with it, which is where a Vercel build
 * has it.
 */
export interface ProjectOptions {
  /** `VERCEL_PROJECT_ID` */
  projectId?: string;
  /** `VERCEL_TEAM_ID`. Needed for a team's project. */
  teamId?: string;
  /** `VERCEL_API_TOKEN`. Has to be able to write the project's environment variables. */
  vercelToken?: string;
  /**
   * `SLACK_CONFIGURATION_TOKEN`. Creates, updates and deletes Slack apps.
   * Without one, the token stored in the project is used.
   */
  slackConfigToken?: string;
  /**
   * `SLACK_CONFIG_REFRESH_TOKEN`. With it, an expired configuration token is
   * rotated, and the new pair saved to the project.
   */
  slackConfigRefreshToken?: string;
  /** Where to say what's being done. Nothing is said without one. */
  logger?: Logger;
}

export interface PreviewOptions extends ProjectOptions {
  /**
   * The app's manifest, or the path of its JSON or YAML file. Defaults to
   * `MANIFEST_PATH`, then to `manifest.json`, `manifest.yaml` or
   * `manifest.yml` in the working directory. The file is never changed.
   */
  manifest?: string | Manifest;
  /** `VERCEL_GIT_COMMIT_REF`. The branch the preview app belongs to. */
  branch?: string;
  /**
   * `VERCEL_BRANCH_URL`, else `VERCEL_URL`. The host or URL Slack sends the
   * app's requests to.
   */
  url?: string;
  /**
   * `VERCEL_DEPLOYMENT_ID`. The deployment to replace when it was built
   * without the app's variables. Outside a deployment, nothing is replaced.
   */
  deploymentId?: string;
  /**
   * `SLACK_SERVICE_TOKEN`. Installs the app in its workspace. Without one,
   * someone has to install it.
   */
  slackServiceToken?: string;
  /**
   * `VERCEL_AUTOMATION_BYPASS_SECRET`. Gets Slack's requests through
   * Deployment Protection. Without one, one is added to the project.
   */
  bypassSecret?: string;
  /** `VERCEL_GIT_COMMIT_SHA`, `_MESSAGE` and `_AUTHOR_LOGIN`. Shown on the app's page in Slack. */
  commit?: { sha?: string; message?: string; author?: string };
  /**
   * Save the app's secrets as Sensitive variables, which can't be read back
   * from Vercel. Defaults to `true`. With `false` they can be, by
   * `vercel env pull` for one.
   */
  sensitive?: boolean;
}

/** Whether the app is installed in its workspace, and why not. */
export type Installation =
  | { installed: true }
  | {
      installed: false;
      reason:
        | "no_service_token"
        | "approval_required"
        | "approval_pending"
        | "approval_denied"
        /** The service token's user can't see the app. */
        | "no_access"
        /** Slack couldn't be reached. The next build tries again. */
        | "unavailable"
        /** Slack refused, with `code`. */
        | "refused";
      /** Slack's error code. */
      code?: string;
    };

/** There was nothing to do. */
export interface PreviewSkipped {
  status: "skipped";
  reason: "not_preview" | "no_branch";
  message: string;
}

/** The branch has its app. */
export interface PreviewApp {
  /**
   * - `ready`: this deployment has the app's variables.
   * - `redeployed`: it was built without them, so `deployment` was started
   *   and this one canceled.
   * - `outdated`: it was built without them, and wasn't replaced.
   */
  status: "ready" | "redeployed" | "outdated";
  branch: string;
  app: {
    id: string;
    name: string;
    /** Whether this run created it. */
    created: boolean;
    /** The branch's earlier app, which Slack no longer lets this token manage. */
    replaced?: string;
    /** Its settings. */
    url: string;
    /** Where someone can install it. */
    installUrl: string;
  };
  installation: Installation;
  /** The names of the variables this run saved for the branch. */
  saved: string[];
  /** The deployment that replaces this one. */
  deployment?: { id: string; url: string };
}

export type PreviewResult = PreviewSkipped | PreviewApp;

/**
 * Gives a preview deployment's branch its own Slack app.
 *
 * Creates the app from the manifest, or updates the one the branch has,
 * with Slack's requests going to the branch's deployment. Saves the app's
 * credentials as preview variables of the branch, installs the app when
 * there's a service token, and when this deployment was built without those
 * variables, starts one that has them.
 *
 * In a Vercel build it needs no options:
 *
 * ```ts
 * import { preview } from "@vercel/slack-bolt/preview";
 *
 * await preview({ logger: console });
 * ```
 *
 * Resolves with `status: "skipped"` for anything but a branch's preview
 * deployment.
 *
 * @throws When the app couldn't be set up. The message says what to do, and
 * never contains a secret.
 */
export async function preview(
  options: PreviewOptions = {},
): Promise<PreviewResult> {
  try {
    const context = resolvePreview(options, process.env, process.cwd());
    if ("status" in context) {
      logTo(options.logger).note(context.message);
      return context;
    }
    return await provision(context);
  } catch (error) {
    throw scrubError(error);
  }
}

export interface CleanupOptions extends ProjectOptions {
  /**
   * The branches whose apps to remove. Without it, every branch with a
   * preview app that Vercel no longer lists as active.
   */
  branches?: string[];
  /** Say what would be removed, and remove nothing. */
  dryRun?: boolean;
}

export interface CleanupResult {
  dryRun: boolean;
  /** The branches whose app and variables were removed, or in a dry run, would be. */
  removed: { branch: string; appId?: string }[];
  /** The branches that still have something, and why. The next run tries them again. */
  failed: { branch: string; appId?: string; reason: string }[];
}

/**
 * Deletes the Slack apps and the variables of branches that are gone.
 *
 * Runs anywhere the project and a Vercel token are known, like a production
 * build, a scheduled job or a terminal.
 *
 * @throws When it can't tell which branches are gone. Nothing is removed
 * then.
 */
export async function cleanup(
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  try {
    return await cleanUp(resolveCleanup(options, process.env));
  } catch (error) {
    throw scrubError(error);
  }
}
