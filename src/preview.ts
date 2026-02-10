import { log, redact } from "./internal/logger";
import { loadManifest, prepareManifest } from "./internal/manifest";
import { checkSlackConfigToken, createSlackOps } from "./internal/slack";
import type {
  SetupResult,
  SetupSlackPreviewOptions,
  UpsertResult,
} from "./internal/types";
import {
  cleanupOrphanedApps,
  tryInstallApp,
  upsertSlackApp,
  validatePreviewEnvironment,
} from "./internal/utils";
import { createVercelOps } from "./internal/vercel";

/**
 * Pre-build setup script for Slack preview deployments.
 *
 * Call this before your framework build command to:
 * - Create a Slack app on the first deployment for a branch
 * - Sync manifest changes on subsequent deployments
 * - Set branch-scoped environment variables in Vercel
 *
 * @example
 * ```typescript
 * // scripts/setup-slack.ts
 * import { setupSlackPreview } from '@vercel/slack-bolt/preview';
 *
 * // Uses manifest.json in the repo root by default
 * await setupSlackPreview();
 *
 * // Or specify a custom path
 * await setupSlackPreview({ manifestPath: 'config/manifest.json' });
 * ```
 *
 * Build command: `tsx scripts/setup-slack.ts && next build`
 */
export async function setupSlackPreview(
  options: SetupSlackPreviewOptions = {},
): Promise<SetupResult> {
  const {
    manifestPath = "manifest.json",
    slackConfigToken: slackConfigTokenOpt = process.env
      .SLACK_CONFIGURATION_TOKEN,
    vercelToken: vercelTokenOpt = process.env.VERCEL_API_TOKEN,
    slackServiceToken = process.env.SLACK_SERVICE_TOKEN,
    slackConfigRefreshToken = process.env.SLACK_CONFIG_REFRESH_TOKEN,
    debug = false,
  } = options;

  log._debug = debug;

  if (!slackConfigTokenOpt) {
    return {
      status: "skipped",
      reason: "SLACK_CONFIGURATION_TOKEN is not set",
      warnings: [],
    };
  }
  if (!vercelTokenOpt) {
    return {
      status: "skipped",
      reason: "VERCEL_API_TOKEN is not set",
      warnings: [],
    };
  }

  const env = validatePreviewEnvironment();

  if (typeof env === "string") {
    return { status: "skipped", reason: env, warnings: [] };
  }

  const { branch, projectId, branchUrl, teamId } = env;

  const warnings: string[] = [];
  const vercel = createVercelOps(projectId, vercelTokenOpt, teamId);

  log.task("Checking Slack configuration token...");
  let slackConfigToken = slackConfigTokenOpt;
  try {
    const tokenResult = await checkSlackConfigToken(
      slackConfigTokenOpt,
      slackConfigRefreshToken,
    );
    slackConfigToken = tokenResult.token;

    if (tokenResult.rotated) {
      log.success("Configuration token was expired — rotated successfully");

      try {
        const tokenVars: { key: string; value: string }[] = [
          { key: "SLACK_CONFIGURATION_TOKEN", value: tokenResult.token },
        ];
        if (tokenResult.newRefreshToken) {
          tokenVars.push({
            key: "SLACK_CONFIG_REFRESH_TOKEN",
            value: tokenResult.newRefreshToken,
          });
        }
        await vercel.setEnvVars(null, tokenVars);
        log.success("Rotated tokens persisted to Vercel project env vars");
      } catch (error) {
        warnings.push(
          `Token was rotated but failed to persist to Vercel: ${error instanceof Error ? error.message : error}. ` +
            "You may need to update SLACK_CONFIGURATION_TOKEN and SLACK_CONFIG_REFRESH_TOKEN manually.",
        );
      }
    } else {
      log.success("Configuration token is valid");
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { status: "failed", error: msg, warnings };
  }

  const slack = createSlackOps(slackConfigToken, slackServiceToken);

  log.info("Branch", branch);
  log.info("Manifest", manifestPath);
  console.log();

  log.task("Cleaning up orphaned apps...");
  try {
    await cleanupOrphanedApps(
      projectId,
      branch,
      vercelTokenOpt,
      teamId,
      slackConfigToken,
    );
  } catch (error) {
    log.warn(
      `Orphan cleanup failed: ${error instanceof Error ? error.message : error}`,
    );
  }
  log.success("Orphan cleanup completed");
  log.task(`Loading manifest from: ${manifestPath}...`);
  const manifest = await loadManifest(manifestPath);
  log.success(`Loaded manifest from: ${manifestPath}`);

  let bypassSecret: string | null = null;
  log.task("Setting up deployment protection bypass...");
  try {
    bypassSecret = await vercel.ensureProtectionBypass();
    log.debug(
      bypassSecret === process.env.VERCEL_AUTOMATION_BYPASS_SECRET
        ? "Using existing VERCEL_AUTOMATION_BYPASS_SECRET"
        : `Generated new bypass secret: ${redact(bypassSecret)}`,
    );
  } catch (error) {
    warnings.push(
      `Failed to configure deployment protection bypass: ${error instanceof Error ? error.message : error}`,
    );
    warnings.push(
      "Slack webhooks may be blocked by Vercel Authentication on preview deployments",
    );
  }
  log.success("Deployment protection bypass setup complete");

  log.task("Preparing manifest...");
  prepareManifest(manifest, {
    branch,
    branchUrl,
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
    commitMsg: process.env.VERCEL_GIT_COMMIT_MESSAGE ?? "",
    commitAuthor: process.env.VERCEL_GIT_COMMIT_AUTHOR_LOGIN ?? "unknown",
    bypassSecret,
  });
  log.success("Manifest prepared");

  let result: UpsertResult;
  try {
    result = await upsertSlackApp(manifest, branch, slack, vercel);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { status: "failed", error: msg, warnings };
  }

  const { appId, isNew } = result;

  if (slackServiceToken) {
    log.task("Installing Slack app...");
    const installResult = await tryInstallApp(
      appId,
      manifest,
      slack,
      vercel,
      branch,
    );
    if (installResult.installed) {
      log.success(`Slack app ${appId} installed for preview branch: ${branch}`);
    } else if (installResult.error) {
      warnings.push(`Failed to auto-install app: ${installResult.error}`);
      if (!isNew) {
        warnings.push(
          "Check that SLACK_SERVICE_TOKEN has the correct permissions, or install manually via the URL below.",
        );
      }
    }
  } else {
    warnings.push(
      "SLACK_SERVICE_TOKEN is not set. The app must be installed manually.",
    );
  }

  if (isNew) {
    log.task("Redeploying preview branch...");
    try {
      await vercel.triggerRedeploy();
      log.debug("Redeploy triggered successfully.");
    } catch (error) {
      warnings.push(
        `Failed to trigger redeploy: ${error instanceof Error ? error.message : error}`,
      );
      warnings.push(
        "Push a new commit or redeploy manually from the Vercel dashboard.",
      );
    }

    const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
    if (deploymentId) {
      try {
        await vercel.cancelDeployment(deploymentId);
        log.debug(`Canceled current deployment: ${deploymentId}`);
      } catch {}
    }

    return { status: "created", appId, warnings };
  }

  if (debug) {
    console.log();
    log.debug("--- Build summary ---");
    log.debug(`App ID: ${appId}`);
    log.debug(
      `SLACK_SIGNING_SECRET in process.env: ${redact(process.env.SLACK_SIGNING_SECRET)}`,
    );
    log.debug("--- End build summary ---");
  }

  return { status: "updated", appId, warnings };
}
