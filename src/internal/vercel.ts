import { Vercel } from "@vercel/sdk";
import { VercelApiError } from "./errors";
import { log, redact } from "./logger";
import type { VercelBranchesResponse, VercelOps } from "./types";

/**
 * Creates a real VercelOps implementation backed by the Vercel API.
 *
 * @param projectId - Vercel project ID
 * @param token - Vercel API token
 * @param teamId - Vercel team ID (or null for personal accounts)
 */
export function createVercelOps(
  projectId: string,
  token: string,
  teamId: string | null,
): VercelOps {
  return {
    async getSlackAppId(branch: string): Promise<string | null> {
      return getSlackAppIdForBranch(projectId, branch, token, teamId);
    },

    async setEnvVars(
      branch: string,
      vars: { key: string; value: string }[],
    ): Promise<void> {
      return setVercelEnvVars(projectId, branch, token, vars, teamId);
    },

    async deleteSlackEnvVars(branch: string): Promise<void> {
      return deleteVercelEnvVars(projectId, branch, token, teamId);
    },

    async ensureProtectionBypass(): Promise<string> {
      return ensureProtectionBypass(projectId, token, teamId);
    },

    triggerRedeploy(): Promise<void> {
      return triggerRedeploy(projectId, token, teamId);
    },

    async cancelDeployment(deploymentId: string): Promise<void> {
      const vercelClient = new Vercel({ bearerToken: token });
      await vercelClient.deployments.cancelDeployment({
        id: deploymentId,
        ...(teamId ? { teamId } : {}),
      });
    },

    getActiveBranches(): Promise<Set<string>> {
      return getActiveBranches(projectId, token, teamId);
    },
  };
}

async function triggerRedeploy(
  projectId: string,
  token: string,
  teamId?: string | null,
): Promise<void> {
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  if (!deploymentId) {
    throw new Error(
      "VERCEL_DEPLOYMENT_ID is not set. Cannot trigger redeploy.",
    );
  }

  log.debug(`Triggering redeploy based on deployment: ${deploymentId}`);

  const params = new URLSearchParams({ forceNew: "1" });
  if (teamId) params.set("teamId", teamId);

  const response = await fetch(
    `https://api.vercel.com/v13/deployments?${params}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: projectId,
        deploymentId,
        meta: {
          redeployedBy: "@vercel/slack-bolt",
          reason: "First-time Slack app setup — env vars now available",
        },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new VercelApiError(
      `Vercel API returned ${response.status}: ${body}`,
      response.status,
    );
  }

  const data = (await response.json()) as { id?: string; url?: string };
  log.debug(`Redeploy created: id=${data.id}, url=${data.url}`);
}

const SLACK_ENV_VAR_KEYS = [
  "SLACK_APP_ID",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
] as const;

async function getSlackAppIdForBranch(
  projectId: string,
  branch: string,
  token: string,
  teamId?: string | null,
): Promise<string | null> {
  log.debug(`Querying Vercel env vars for SLACK_APP_ID on branch: ${branch}`);
  const vercel = new Vercel({ bearerToken: token });

  let envs: Array<{ id?: string; key: string; gitBranch?: string }>;
  try {
    const data = await vercel.projects.filterProjectEnvs({
      idOrName: projectId,
      teamId: teamId ?? undefined,
    });
    envs = "envs" in data ? data.envs : [];
    log.debug(`  Found ${envs.length} total env vars in project`);
    const branchEnvs = envs.filter((e) => e.gitBranch === branch);
    log.debug(
      `  Found ${branchEnvs.length} env vars for branch "${branch}": ${branchEnvs.map((e) => e.key).join(", ") || "<none>"}`,
    );
  } catch (error) {
    const statusCode =
      error && typeof error === "object" && "statusCode" in error
        ? (error as { statusCode: number }).statusCode
        : 0;
    throw new VercelApiError(
      `Failed to fetch env vars: ${error instanceof Error ? error.message : String(error)}`,
      statusCode,
    );
  }

  const appIdEnv = envs.find(
    (env) => env.key === "SLACK_APP_ID" && env.gitBranch === branch,
  );

  if (!appIdEnv?.id) {
    log.debug("  No SLACK_APP_ID env var found for this branch");
    return null;
  }

  log.debug(
    `  Found SLACK_APP_ID env var (id: ${appIdEnv.id}), fetching decrypted value...`,
  );
  try {
    const decrypted = await vercel.projects.getProjectEnv({
      idOrName: projectId,
      id: appIdEnv.id,
      teamId: teamId ?? undefined,
    });
    const value = "value" in decrypted ? (decrypted.value ?? null) : null;
    log.debug(`  Decrypted SLACK_APP_ID = ${value ?? "<null>"}`);
    return value;
  } catch (error) {
    console.error(
      `[slack-bolt] Failed to decrypt SLACK_APP_ID:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function setVercelEnvVars(
  projectId: string,
  branch: string,
  token: string,
  vars: { key: string; value: string }[],
  teamId?: string | null,
): Promise<void> {
  log.debug(
    `Setting ${vars.length} env var(s) via Vercel API (branch: ${branch}, target: preview, type: encrypted):`,
  );
  const vercel = new Vercel({ bearerToken: token });
  const failures: string[] = [];

  for (const { key, value } of vars) {
    log.debug(`  Setting ${key} = ${redact(value)} ...`);
    try {
      await vercel.projects.createProjectEnv({
        idOrName: projectId,
        upsert: "true",
        teamId: teamId ?? undefined,
        requestBody: {
          key,
          value,
          type: "encrypted",
          target: ["preview"],
          gitBranch: branch,
        },
      });
      log.debug(`  ${key} set successfully`);
    } catch (error) {
      log.error(
        `Failed to set env var ${key}: ${error instanceof Error ? error.message : error}`,
      );
      log.debug(
        `  ${key} FAILED: ${error instanceof Error ? error.message : error}`,
      );
      failures.push(key);
    }
  }

  if (failures.length > 0) {
    throw new VercelApiError(
      `Failed to set env vars: ${failures.join(", ")}. ` +
        `The Slack app was created but cannot be tracked. ` +
        `Delete it manually in Slack and retry.`,
      0,
    );
  }
}

export async function deleteVercelEnvVars(
  projectId: string,
  branch: string,
  token: string,
  teamId?: string | null,
): Promise<void> {
  log.debug(`Deleting env vars for project ${projectId} branch ${branch}`);

  const vercel = new Vercel({ bearerToken: token });

  let envs: Array<{ id?: string; key: string; gitBranch?: string }>;
  try {
    const data = await vercel.projects.filterProjectEnvs({
      idOrName: projectId,
      teamId: teamId ?? undefined,
    });
    envs = "envs" in data ? data.envs : [];
  } catch (error) {
    console.error(
      `[slack-bolt] Failed to fetch env vars for deletion:`,
      error instanceof Error ? error.message : error,
    );
    return;
  }

  for (const env of envs) {
    if (
      env.id &&
      env.gitBranch === branch &&
      (SLACK_ENV_VAR_KEYS as readonly string[]).includes(env.key)
    ) {
      try {
        await vercel.projects.removeProjectEnv({
          idOrName: projectId,
          id: env.id,
          teamId: teamId ?? undefined,
        });
        log.debug(`Deleted env var: ${env.key}`);
      } catch (error) {
        console.error(
          `[slack-bolt] Failed to delete env var ${env.key}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}

export async function getActiveBranches(
  projectId: string,
  token: string,
  teamId?: string | null,
): Promise<Set<string>> {
  const params = new URLSearchParams({ active: "1", limit: "100" });
  if (teamId) params.set("teamId", teamId);

  const response = await fetch(
    `https://api.vercel.com/v5/projects/${projectId}/branches?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new VercelApiError(
      `Vercel branches API returned ${response.status}: ${body}`,
      response.status,
    );
  }

  const data = (await response.json()) as VercelBranchesResponse;
  return new Set(data.branches?.map((b) => b.branch) ?? []);
}

async function ensureProtectionBypass(
  projectId: string,
  token: string,
  teamId?: string | null,
): Promise<string> {
  const existing = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (existing) {
    log.debug(
      `Using existing VERCEL_AUTOMATION_BYPASS_SECRET: ${redact(existing)}`,
    );
    return existing;
  }

  log.debug(
    "No VERCEL_AUTOMATION_BYPASS_SECRET found, generating via Vercel API...",
  );
  const vercel = new Vercel({ bearerToken: token });

  const result = await vercel.projects.updateProjectProtectionBypass({
    idOrName: projectId,
    teamId: teamId ?? undefined,
    requestBody: {
      generate: {
        note: "Slack preview app webhooks (managed by @vercel/slack-bolt)",
      },
    },
  });

  const bypasses = result.protectionBypass;
  log.debug(
    `  Protection bypass entries returned: ${bypasses ? Object.keys(bypasses).length : 0}`,
  );
  if (!bypasses || Object.keys(bypasses).length === 0) {
    throw new VercelApiError(
      "Vercel API returned empty protectionBypass response",
      0,
    );
  }

  let newSecret: string | null = null;
  for (const [secret, meta] of Object.entries(bypasses)) {
    if (
      meta &&
      typeof meta === "object" &&
      "scope" in meta &&
      meta.scope === "automation-bypass"
    ) {
      newSecret = secret;
      break;
    }
  }

  if (!newSecret) {
    throw new VercelApiError(
      "Could not find automation-bypass secret in Vercel API response",
      0,
    );
  }

  log.debug(`  Generated bypass secret: ${redact(newSecret)}`);
  log.debug("  Marking bypass secret as env var for future builds...");

  await vercel.projects.updateProjectProtectionBypass({
    idOrName: projectId,
    teamId: teamId ?? undefined,
    requestBody: {
      update: {
        secret: newSecret,
        isEnvVar: true,
        note: "Slack preview app webhooks (managed by @vercel/slack-bolt)",
      },
    },
  });

  log.debug("  Bypass secret saved as VERCEL_AUTOMATION_BYPASS_SECRET");
  return newSecret;
}
