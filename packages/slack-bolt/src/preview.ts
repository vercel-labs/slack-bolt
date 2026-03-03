import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ErrorCode, type WebAPIPlatformError, WebClient } from "@slack/web-api";
import type { Manifest } from "@slack/web-api/dist/types/request/manifest";
import { Vercel } from "@vercel/sdk";
import { z } from "zod";

export const preview = async ({
  overrides = {},
}: {
  overrides?: { [key: string]: string };
} = {}): Promise<void> => {
  const env = { ...process.env, ...overrides };

  if (env.VERCEL_ENV === "production") {
    console.warn("[@vercel/slack-bolt] Skipping production build\n");
    return;
  }

  if (
    !env.VERCEL_ENV ||
    env.VERCEL_ENV === "development" ||
    env.NODE_ENV === "development"
  ) {
    console.warn("[@vercel/slack-bolt] Skipping local/development build\n");
    return;
  }

  const systemResult = systemEnvSchema.safeParse(env);
  if (!systemResult.success) {
    const missing = formatMissingKeys(systemResult.error);
    throw new Error(
      `Missing Vercel system environment variables: ${missing}\nEnable 'Automatically expose System Environment Variables' in your Vercel project settings:\nhttps://vercel.com/docs/projects/environment-variables/system-environment-variables`,
    );
  }

  const slackResult = slackEnvSchema.safeParse(env);
  if (!slackResult.success) {
    const missing = formatMissingKeys(slackResult.error);
    throw new Error(
      `Missing Slack environment variables: ${missing}\nAdd them as environment variables in your Vercel project.`,
    );
  }

  const vercelResult = vercelEnvSchema.safeParse(env);
  if (!vercelResult.success) {
    const missing = formatMissingKeys(vercelResult.error);
    throw new Error(
      `Missing Vercel environment variables: ${missing}\nCreate a new token and add it as VERCEL_API_TOKEN in your Vercel project:\nhttps://vercel.com/account/settings/tokens`,
    );
  }

  const {
    VERCEL_GIT_COMMIT_REF: branch,
    VERCEL_PROJECT_ID: projectId,
    VERCEL_URL: deploymentUrl,
    VERCEL_BRANCH_URL: maybeBranchUrl,
    VERCEL_TEAM_ID: teamId,
    VERCEL_GIT_COMMIT_AUTHOR_LOGIN: commitAuthor,
    VERCEL_GIT_COMMIT_MESSAGE: commitMsg,
    VERCEL_GIT_COMMIT_SHA: commitSha,
    VERCEL_DEPLOYMENT_ID: deploymentId,
    VERCEL_AUTOMATION_BYPASS_SECRET: automationBypassSecret,
  } = systemResult.data;

  const branchUrl = maybeBranchUrl ?? deploymentUrl;

  const {
    SLACK_APP_ID: slackAppId,
    SLACK_CONFIGURATION_TOKEN: slackConfigurationToken,
    SLACK_SERVICE_TOKEN: slackServiceToken,
    MANIFEST_PATH: manifestPath,
  } = slackResult.data;

  const { VERCEL_API_TOKEN: vercelApiToken } = vercelResult.data;

  let bypassSecret = automationBypassSecret;

  if (!slackConfigurationToken) {
    throw new Error(
      "Slack Configuration Token is not set. Generate a configuration token and add it as SLACK_CONFIGURATION_TOKEN in your Vercel project:\nhttps://api.slack.com/apps",
    );
  }

  try {
    await new WebClient(slackConfigurationToken).auth.test();
  } catch (error) {
    throw new Error(
      "Slack configuration token is invalid or expired. Generate a new configuration token and add it as SLACK_CONFIGURATION_TOKEN in your Vercel project:\nhttps://api.slack.com/apps",
      { cause: error },
    );
  }

  let validServiceToken: string | undefined;
  if (!slackServiceToken) {
    console.warn(
      "SLACK_SERVICE_TOKEN is not set. Create a service token and add it as SLACK_SERVICE_TOKEN in your Vercel project. This app will need to be installed manually.\nhttps://docs.slack.dev/authentication/tokens/#service",
    );
  } else {
    try {
      await new WebClient(slackServiceToken).auth.test();
      validServiceToken = slackServiceToken;
    } catch (error) {
      console.warn(
        "SLACK_SERVICE_TOKEN is invalid. Create a new service token and add it as SLACK_SERVICE_TOKEN in your Vercel project. This app will need to be installed manually.\nhttps://docs.slack.dev/authentication/tokens/#service",
      );
      console.debug(error);
    }
  }

  const slackClient = new WebClient(slackConfigurationToken);
  const vercelClient = new Vercel({ bearerToken: vercelApiToken });

  try {
    await vercelClient.user.getAuthUser();
  } catch (error) {
    throw new Error(
      "Vercel API token is invalid or expired. Create a new token and add it as VERCEL_API_TOKEN in your Vercel project:\nhttps://vercel.com/account/settings/tokens",
      {
        cause: error,
      },
    );
  }

  try {
    const cleanupResult = await cleanupOrphanedApps({
      projectId,
      currentBranch: branch,
      teamId,
      vercelClient,
      vercelToken: vercelApiToken,
      slackClient,
    });
    if (cleanupResult.staleBranches.length > 0) {
      console.log(
        `[@vercel/slack-bolt] Found ${cleanupResult.staleBranches.length} orphaned branch(es): ${cleanupResult.staleBranches.join(", ")}`,
      );
    }
    for (const d of cleanupResult.deleted) {
      console.log(
        `[@vercel/slack-bolt] Deleted Slack app ${d.appId} (branch: ${d.branch})`,
      );
    }
    for (const w of cleanupResult.warnings) {
      console.warn(
        `[@vercel/slack-bolt] Orphan cleanup warning (${w.branch}): ${w.message}`,
      );
    }
  } catch (error) {
    console.warn(
      `[@vercel/slack-bolt] Orphan cleanup failed: ${error instanceof Error ? error.message : error}`,
    );
  }

  let rawFileManifest: string;
  try {
    rawFileManifest = fs.readFileSync(
      path.join(process.cwd(), manifestPath),
      "utf8",
    );
  } catch (error) {
    throw new Error(
      `Failed to read manifest file from ${manifestPath}. The default manifest path is "manifest.json". You can change the manifest path by setting the MANIFEST_PATH environment variable in your Vercel project.`,
      {
        cause: error,
      },
    );
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(rawFileManifest) as Manifest;
  } catch (error) {
    throw new Error(
      `Failed to parse manifest as JSON from ${manifestPath}. The manifest must be a valid JSON object.`,
      {
        cause: error,
      },
    );
  }

  try {
    await slackClient.apps.manifest.validate({ manifest });
  } catch (error) {
    throw new Error(
      "Invalid manifest file. Please check your manifest.json file and try again.",
      { cause: error },
    );
  }

  if (!bypassSecret) {
    const generatedSecret = generateBypassSecret();

    try {
      const result = await vercelClient.projects.updateProjectProtectionBypass({
        idOrName: projectId,
        teamId: teamId,
        requestBody: {
          generate: {
            secret: generatedSecret,
            note: "Created by @vercel/slack-bolt",
          },
        },
      });

      const entry = result.protectionBypass?.[generatedSecret];
      if (
        !entry ||
        !("scope" in entry) ||
        entry.scope !== "automation-bypass"
      ) {
        throw new Error(
          "Generated secret not found in Vercel API response. This is a bug in @vercel/slack-bolt — please report it at https://github.com/vercel-labs/slack-bolt/issues",
        );
      }
    } catch (error) {
      throw new Error(
        "Failed to generate deployment protection bypass. This is a bug in @vercel/slack-bolt — please report it at https://github.com/vercel-labs/slack-bolt/issues",
        {
          cause: error,
        },
      );
    }

    bypassSecret = generatedSecret;
  }

  if (manifest.settings?.event_subscriptions?.request_url) {
    try {
      manifest.settings.event_subscriptions.request_url = rewriteUrl(
        manifest.settings.event_subscriptions.request_url,
        branchUrl,
        bypassSecret,
      );
    } catch (error) {
      throw new Error(
        `Could not parse event_subscriptions.request_url in your manifest: "${manifest.settings.event_subscriptions.request_url}"\nThis URL will be rewritten to point to your Vercel preview deployment. It must be a valid URL (e.g. https://example.com/api/slack/events).`,
        { cause: error },
      );
    }
  }

  if (manifest.settings?.interactivity?.request_url) {
    try {
      manifest.settings.interactivity.request_url = rewriteUrl(
        manifest.settings.interactivity.request_url,
        branchUrl,
        bypassSecret,
      );
    } catch (error) {
      throw new Error(
        `Could not parse interactivity.request_url in your manifest: "${manifest.settings.interactivity.request_url}"\nThis URL will be rewritten to point to your Vercel preview deployment. It must be a valid URL (e.g. https://example.com/api/slack/events).`,
        { cause: error },
      );
    }
  }

  if (manifest.features?.slash_commands) {
    for (const cmd of manifest.features.slash_commands) {
      if (cmd.url) {
        try {
          cmd.url = rewriteUrl(cmd.url, branchUrl, bypassSecret);
        } catch (error) {
          throw new Error(
            `Could not parse slash command URL in your manifest: "${cmd.url}"\nThis URL will be rewritten to point to your Vercel preview deployment. It must be a valid URL.`,
            { cause: error },
          );
        }
      }
    }
  }

  if (manifest.oauth_config?.redirect_urls) {
    manifest.oauth_config.redirect_urls =
      manifest.oauth_config.redirect_urls.map((originalUrl) => {
        try {
          return rewriteUrl(originalUrl, branchUrl);
        } catch (error) {
          throw new Error(
            `Could not parse redirect URL in your manifest: "${originalUrl}"\nThis URL will be rewritten to point to your Vercel preview deployment. It must be a valid URL.`,
            { cause: error },
          );
        }
      });
  }

  const shortSha = commitSha?.slice(0, 7) ?? "unknown";
  const safeCommitMsg = commitMsg ?? "";
  const safeCommitAuthor = commitAuthor ?? "unknown";
  const deploymentInfo = `\n:globe_with_meridians: *Deployment URL:* ${branchUrl}\n:seedling: *Branch:* ${branch}\n:technologist: *Commit:* ${shortSha} ${safeCommitMsg}\n:bust_in_silhouette: *Last updated by:* ${safeCommitAuthor}\n\n_Automatically created by ▲ Vercel_\n`;

  const maxLongDesc = 4000;
  const existingDesc = manifest.display_information.long_description ?? "";
  const combined = existingDesc + deploymentInfo;
  if (combined.length > maxLongDesc) {
    const available = Math.max(0, maxLongDesc - deploymentInfo.length);
    manifest.display_information.long_description = (
      existingDesc.slice(0, available) + deploymentInfo
    ).slice(0, maxLongDesc);
  } else {
    manifest.display_information.long_description = combined;
  }

  const originalName =
    manifest.features?.bot_user?.display_name ??
    manifest.display_information.name;
  const maxDisplayName = 35;
  const cleanBranch = branch.replace(/^refs\/heads\//, "").replace(/\//g, "-");

  let displayName = `${originalName} (${cleanBranch})`;
  if (displayName.length > maxDisplayName) {
    const prefix = `${originalName} (`;
    const suffix = ")";
    const availableForBranch = maxDisplayName - prefix.length - suffix.length;
    displayName =
      availableForBranch > 0
        ? `${prefix}${cleanBranch.slice(0, availableForBranch)}${suffix}`
        : displayName.slice(0, maxDisplayName);
  }

  if (manifest.features?.bot_user) {
    manifest.features.bot_user.display_name = displayName;
  }
  manifest.display_information.name = displayName;

  try {
    await slackClient.apps.manifest.validate({ manifest });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Manifest validation failed after URL rewrite: ${detail}\nCheck that your manifest.json is valid before @vercel/slack-bolt rewrites the URLs.`,
      { cause: error },
    );
  }

  try {
    fs.writeFileSync(
      path.join(process.cwd(), manifestPath),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  } catch (error) {
    throw new Error(
      `Failed to write manifest to ${manifestPath}. This is a bug in @vercel/slack-bolt — please report it at https://github.com/vercel-labs/slack-bolt/issues`,
      {
        cause: error,
      },
    );
  }

  let needsRedeploy = false;
  let needsCreate = !slackAppId;
  let appId = slackAppId;

  if (slackAppId) {
    try {
      await slackClient.apps.manifest.update({
        manifest,
        app_id: slackAppId,
      });
    } catch (error) {
      const platformError =
        error instanceof Error &&
        "code" in error &&
        error.code === ErrorCode.PlatformError
          ? (error as WebAPIPlatformError)
          : undefined;
      const slackError = platformError?.data.error;
      if (
        slackError === "app_not_found" ||
        slackError === "invalid_app_id" ||
        slackError === "internal_error"
      ) {
        console.warn(
          `[@vercel/slack-bolt] App ${slackAppId} could not be updated (${slackError}). Creating a new one...`,
        );
        needsCreate = true;
      } else {
        const detail =
          platformError?.data.error ??
          (error instanceof Error ? error.message : String(error));
        throw new Error(`Failed to update app ${slackAppId}: ${detail}`, {
          cause: error,
        });
      }
    }
  }

  if (needsCreate) {
    let result: Awaited<ReturnType<typeof slackClient.apps.manifest.create>>;
    try {
      result = await slackClient.apps.manifest.create({ manifest });
    } catch (error) {
      throw new Error("Failed to create Slack app", { cause: error });
    }

    if (!result.app_id) {
      throw new Error("Failed to create Slack app: response missing app_id");
    }
    if (!result.credentials?.client_id) {
      throw new Error(
        "Failed to create Slack app: response missing credentials.client_id",
      );
    }
    if (!result.credentials?.client_secret) {
      throw new Error(
        "Failed to create Slack app: response missing credentials.client_secret",
      );
    }
    if (!result.credentials?.signing_secret) {
      throw new Error(
        "Failed to create Slack app: response missing credentials.signing_secret",
      );
    }

    appId = result.app_id;

    try {
      await vercelClient.projects.createProjectEnv({
        idOrName: projectId,
        teamId: teamId,
        upsert: "true",
        requestBody: [
          {
            key: "SLACK_APP_ID",
            value: result.app_id,
            type: "encrypted",
            target: ["preview"],
            gitBranch: branch,
            comment: `Created by @vercel/slack-bolt for app ${result.app_id} on branch ${branch}`,
          },
          {
            key: "SLACK_CLIENT_ID",
            value: result.credentials.client_id,
            type: "encrypted",
            target: ["preview"],
            gitBranch: branch,
            comment: `Created by @vercel/slack-bolt for app ${result.app_id} on branch ${branch}`,
          },
          {
            key: "SLACK_CLIENT_SECRET",
            value: result.credentials.client_secret,
            type: "encrypted",
            target: ["preview"],
            gitBranch: branch,
            comment: `Created by @vercel/slack-bolt for app ${result.app_id} on branch ${branch}`,
          },
          {
            key: "SLACK_SIGNING_SECRET",
            value: result.credentials.signing_secret,
            type: "encrypted",
            target: ["preview"],
            gitBranch: branch,
            comment: `Created by @vercel/slack-bolt for app ${result.app_id} on branch ${branch}`,
          },
        ],
      });
      needsRedeploy = true;
    } catch (error) {
      // if you deploy via CLI and haven't pushed the branch yet, you'll get this error
      if (
        error instanceof Error &&
        error.message.includes("not found in the connected Git repository")
      ) {
        throw new Error(
          `Branch "${branch}" does not exist in the remote Git repository. If you are deploying via CLI, you need to push the branch before deploying.`,
          { cause: error },
        );
      }
      throw new Error("Failed to set Slack environment variables", {
        cause: error,
      });
    }
  }

  if (appId && validServiceToken) {
    const installResult = await developerInstall({
      serviceToken: validServiceToken,
      appId,
      botScopes: manifest.oauth_config?.scopes?.bot ?? [],
    });

    switch (installResult.status) {
      case "installed":
        try {
          await vercelClient.projects.createProjectEnv({
            idOrName: projectId,
            teamId: teamId,
            upsert: "true",
            requestBody: [
              {
                key: "SLACK_BOT_TOKEN",
                value: installResult.botToken,
                type: "encrypted",
                target: ["preview"],
                gitBranch: branch,
                comment: `Created by @vercel/slack-bolt for app ${appId} on branch ${branch}`,
              },
            ],
          });
          if (needsCreate) {
            needsRedeploy = true;
          }
        } catch (error) {
          console.warn(`Failed to persist SLACK_BOT_TOKEN for app ${appId}`);
          console.debug(error);
        }
        break;
      case "app_approval_request_eligible":
        console.warn(
          `App ${appId} requires admin approval before it can be installed. Ask a workspace admin to approve the app, then redeploy.`,
        );
        break;
      case "app_approval_request_pending":
        console.warn(
          `App ${appId} is awaiting admin approval. Reach out to a workspace admin for status, or redeploy after approval.`,
        );
        break;
      case "app_approval_request_denied":
        console.warn(
          `App ${appId} was denied by a workspace admin. Contact your admin or try with different scopes.`,
        );
        break;
      case "failed":
        console.warn(`Failed to install app ${appId}: ${installResult.error}`);
        break;
      default: {
        const _exhaustive: never = installResult;
        console.warn(
          `[@vercel/slack-bolt] Unexpected install status: ${
            // biome-ignore lint/suspicious/noExplicitAny: we want to log the status
            (_exhaustive as any).status
          }`,
        );
      }
    }
  }

  if (needsRedeploy) {
    console.log(
      `[@vercel/slack-bolt] Slack App ${appId} created successfully. View the app at https://api.slack.com/apps/${appId}.`,
    );

    if (!deploymentId) {
      throw new Error("Cannot redeploy: VERCEL_DEPLOYMENT_ID is not available");
    }

    console.warn(
      "[@vercel/slack-bolt] Redeploying preview branch to pick up new environment variables...",
    );

    try {
      await vercelClient.deployments.cancelDeployment({
        id: deploymentId,
        teamId,
      });
    } catch (error) {
      throw new Error("Failed to cancel current deployment before redeploy", {
        cause: error,
      });
    }

    try {
      await vercelClient.deployments.createDeployment({
        teamId,
        requestBody: {
          name: projectId,
          deploymentId,
          withLatestCommit: true,
        },
      });
    } catch (error) {
      throw new Error("Failed to trigger redeploy", { cause: error });
    }
  }
};

function rewriteUrl(
  originalUrl: string,
  branchUrl: string,
  bypassSecret?: string,
): string {
  const pathStart = originalUrl.indexOf("/", originalUrl.indexOf("//") + 2);
  const pathAndQuery = pathStart !== -1 ? originalUrl.slice(pathStart) : "/";

  const url = new URL(pathAndQuery, `https://${branchUrl}`);
  if (bypassSecret) {
    url.searchParams.set("x-vercel-protection-bypass", bypassSecret);
  }
  return url.toString();
}

function generateBypassSecret(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(32);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

async function developerInstall(params: {
  serviceToken: string;
  appId: string;
  botScopes: string[];
}): Promise<DeveloperInstallResult> {
  const { serviceToken, appId, botScopes } = params;

  try {
    const response = await fetch(
      "https://slack.com/api/apps.developerInstall",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          app_id: appId,
          bot_scopes: botScopes,
          outgoing_domains: [],
        }),
      },
    );

    if (!response.ok) {
      return {
        status: "failed",
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    const data = (await response.json()) as DeveloperInstallResponse;

    if (!data.ok) {
      const code = data.error ?? "unknown_error";
      if ((APP_APPROVAL_CODES as Set<string>).has(code)) {
        return { status: code as AppApprovalCode, error: code };
      }
      return { status: "failed", error: code };
    }

    if (!data.api_access_tokens?.bot) {
      return {
        status: "failed",
        error: "installed but no bot token returned",
      };
    }

    return {
      status: "installed",
      botToken: data.api_access_tokens.bot,
      appLevelToken: data.api_access_tokens.app_level,
      userToken: data.api_access_tokens.user,
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
}

const SLACK_ENV_VAR_KEYS = [
  "SLACK_APP_ID",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
] as const;

type OrphanCleanupResult = {
  staleBranches: string[];
  deleted: { branch: string; appId: string }[];
  warnings: { branch: string; message: string }[];
};

async function cleanupOrphanedApps(params: {
  projectId: string;
  currentBranch: string;
  teamId: string | undefined;
  vercelClient: Vercel;
  vercelToken: string;
  slackClient: WebClient;
}): Promise<OrphanCleanupResult> {
  const {
    projectId,
    currentBranch,
    teamId,
    vercelClient,
    vercelToken,
    slackClient,
  } = params;

  const result: OrphanCleanupResult = {
    staleBranches: [],
    deleted: [],
    warnings: [],
  };

  const activeBranches = await fetchActiveBranches(
    projectId,
    vercelToken,
    teamId,
  );

  const data = await vercelClient.projects.filterProjectEnvs({
    idOrName: projectId,
    teamId,
  });
  const envs: Array<{ id?: string; key: string; gitBranch?: string }> =
    "envs" in data ? data.envs : [];

  const staleBranches = new Map<string, string | undefined>();
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
    return result;
  }

  result.staleBranches = [...staleBranches.keys()];

  for (const [branch, envId] of staleBranches) {
    let appId: string | null = null;
    if (envId) {
      try {
        const decrypted = await vercelClient.projects.getProjectEnv({
          idOrName: projectId,
          id: envId,
          teamId,
        });
        appId = "value" in decrypted ? (decrypted.value ?? null) : null;
      } catch {
        result.warnings.push({
          branch,
          message: "Failed to decrypt SLACK_APP_ID",
        });
      }
    }

    if (appId) {
      try {
        await slackClient.apps.manifest.delete({ app_id: appId });
        result.deleted.push({ branch, appId });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("app_not_found")) {
          result.warnings.push({
            branch,
            message: `App ${appId} already deleted`,
          });
        } else {
          result.warnings.push({
            branch,
            message: `Failed to delete app ${appId}: ${msg}`,
          });
        }
      }
    }

    const branchEnvs = envs.filter(
      (env): env is typeof env & { id: string } =>
        !!env.id &&
        env.gitBranch === branch &&
        (SLACK_ENV_VAR_KEYS as readonly string[]).includes(env.key),
    );
    for (const env of branchEnvs) {
      try {
        await vercelClient.projects.removeProjectEnv({
          idOrName: projectId,
          id: env.id,
          teamId,
        });
      } catch (error) {
        result.warnings.push({
          branch,
          message: `Failed to delete env var ${env.key}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  return result;
}

async function fetchActiveBranches(
  projectId: string,
  vercelToken: string,
  teamId: string | undefined,
): Promise<Set<string>> {
  const params = new URLSearchParams({ active: "1", limit: "100" });
  if (teamId) params.set("teamId", teamId);

  const response = await fetch(
    `https://api.vercel.com/v5/projects/${projectId}/branches?${params}`,
    { headers: { Authorization: `Bearer ${vercelToken}` } },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Vercel branches API returned ${response.status}: ${body}`);
  }

  const data = (await response.json()) as { branches?: { branch: string }[] };
  return new Set(data.branches?.map((b) => b.branch) ?? []);
}

function formatMissingKeys(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join(".")).join(", ");
}

const systemEnvSchema = z.object({
  VERCEL_ENV: z.enum(["production", "preview", "development"]),
  VERCEL_GIT_COMMIT_REF: z.string(),
  VERCEL_PROJECT_ID: z.string(),
  VERCEL_URL: z.string(),
  VERCEL_BRANCH_URL: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  VERCEL_GIT_COMMIT_MESSAGE: z.string().optional(),
  VERCEL_GIT_COMMIT_AUTHOR_LOGIN: z.string().optional(),
  VERCEL_DEPLOYMENT_ID: z.string().optional(),
  VERCEL_AUTOMATION_BYPASS_SECRET: z.string().optional(),
});

const slackEnvSchema = z.object({
  SLACK_APP_ID: z.string().optional(),
  SLACK_CONFIGURATION_TOKEN: z.string().optional(),
  SLACK_SERVICE_TOKEN: z.string().optional(),
  SLACK_CONFIG_REFRESH_TOKEN: z.string().optional(),
  MANIFEST_PATH: z.string().default("manifest.json"),
});

const vercelEnvSchema = z.object({
  VERCEL_API_TOKEN: z.string(),
});

type DeveloperInstallResponse = {
  ok: boolean;
  error?: string;
  app_id?: string;
  api_access_tokens?: {
    bot?: string;
    app_level?: string;
    user?: string;
  };
};

const APP_APPROVAL_CODES = new Set([
  "app_approval_request_eligible",
  "app_approval_request_pending",
  "app_approval_request_denied",
] as const);

type AppApprovalCode = typeof APP_APPROVAL_CODES extends Set<infer T>
  ? T
  : never;

type DeveloperInstallResult =
  | {
      status: "installed";
      botToken: string;
      appLevelToken?: string;
      userToken?: string;
    }
  | {
      status: AppApprovalCode;
      error: string;
    }
  | { status: "failed"; error: string };
