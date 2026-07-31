import crypto from "node:crypto";
import { HTTPError } from "./errors";
import type {
  AddEnvironmentVariablesResult,
  CreateProjectEnv,
  EnvironmentVariable,
  ListBranchesResponse,
} from "./types";

export async function getProject({
  projectId,
  token,
  teamId,
}: {
  projectId: string;
  token: string;
  teamId?: string;
}): Promise<void> {
  const url = new URL(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}`,
  );
  if (teamId) url.searchParams.set("teamId", teamId);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw await HTTPError.fromResponse(
      "Failed to access Vercel project",
      response,
    );
  }
}

export async function updateProtectionBypass({
  projectId,
  token,
  teamId,
}: {
  projectId: string;
  token: string;
  teamId?: string;
}): Promise<string> {
  const newSecret = crypto.randomBytes(16).toString("hex");
  const note = "Created by @vercel/slack-bolt";

  const url = new URL(
    `https://api.vercel.com/v1/projects/${encodeURIComponent(projectId)}/protection-bypass`,
  );
  if (teamId) url.searchParams.set("teamId", teamId);

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      generate: {
        secret: newSecret,
        note: note,
      },
    }),
  });

  if (!response.ok) {
    throw await HTTPError.fromResponse(
      "Failed to update protection bypass",
      response,
    );
  }

  return newSecret;
}

export async function addEnvironmentVariables({
  projectId,
  token,
  teamId,
  envs,
  upsert = true,
}: {
  projectId: string;
  token: string;
  teamId?: string;
  envs: CreateProjectEnv | CreateProjectEnv[];
  upsert?: boolean;
}): Promise<AddEnvironmentVariablesResult> {
  const url = new URL(
    `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env`,
  );
  if (teamId) url.searchParams.set("teamId", teamId);
  if (upsert) url.searchParams.set("upsert", "true");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(envs),
  });

  if (!response.ok) {
    throw await HTTPError.fromResponse(
      "Failed to create environment variables",
      response,
    );
  }

  return response.json();
}

export async function cancelDeployment({
  deploymentId,
  token,
  teamId,
}: {
  deploymentId: string;
  token: string;
  teamId?: string;
}): Promise<void> {
  const url = new URL(
    `https://api.vercel.com/v12/deployments/${encodeURIComponent(deploymentId)}/cancel`,
  );
  if (teamId) url.searchParams.set("teamId", teamId);

  const response = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw await HTTPError.fromResponse("Failed to cancel deployment", response);
  }
}

export async function createDeployment({
  deploymentId,
  projectId,
  token,
  teamId,
}: {
  deploymentId: string;
  projectId: string;
  token: string;
  teamId?: string;
}): Promise<{ id: string; url: string }> {
  const url = new URL("https://api.vercel.com/v13/deployments");
  if (teamId) url.searchParams.set("teamId", teamId);
  url.searchParams.set("forceNew", "1");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      deploymentId,
      name: projectId,
      project: projectId,
    }),
  });

  if (!response.ok) {
    throw await HTTPError.fromResponse("Failed to create deployment", response);
  }

  const data = await response.json();
  return { id: data.id, url: data.url };
}

/**
 * Safety bound on pagination. Callers use the returned set to decide which
 * Slack apps to DELETE, so a partial set must never be returned silently:
 * if this bound is hit, we throw instead.
 */
const MAX_BRANCH_PAGES = 100;

export async function getActiveBranches({
  projectId,
  token,
  teamId,
}: {
  projectId: string;
  token: string;
  teamId?: string;
}): Promise<Set<string>> {
  const branches = new Set<string>();
  const seenCursors = new Set<string>();
  let until: string | undefined;

  for (let page = 0; page < MAX_BRANCH_PAGES; page++) {
    const params = new URLSearchParams({ active: "1", limit: "100" });
    if (teamId) params.set("teamId", teamId);
    if (until) params.set("until", until);

    const response = await fetch(
      `https://api.vercel.com/v5/projects/${encodeURIComponent(projectId)}/branches?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!response.ok) {
      throw await HTTPError.fromResponse(
        "Failed to fetch active branches",
        response,
      );
    }

    const data: ListBranchesResponse = await response.json();
    const pageBranches = data.branches ?? [];
    for (const b of pageBranches) {
      branches.add(b.branch);
    }

    // The v5 branches endpoint returns a top-level `until` cursor when more
    // pages exist; it is absent on the last page.
    const next =
      data.until !== undefined && data.until !== null
        ? String(data.until)
        : undefined;

    if (!next || pageBranches.length === 0) {
      return branches;
    }

    if (seenCursors.has(next)) {
      throw new Error(
        "Failed to fetch active branches: pagination cursor repeated, aborting to avoid returning a partial branch list",
      );
    }
    seenCursors.add(next);
    until = next;
  }

  throw new Error(
    `Failed to fetch active branches: exceeded ${MAX_BRANCH_PAGES} pages, aborting to avoid returning a partial branch list`,
  );
}

export async function getEnvironmentVariables({
  projectId,
  token,
  teamId,
}: {
  projectId: string;
  token: string;
  teamId?: string;
}): Promise<EnvironmentVariable[]> {
  const url = new URL(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}/env`,
  );
  if (teamId) url.searchParams.set("teamId", teamId);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw await HTTPError.fromResponse(
      "Failed to fetch environment variables",
      response,
    );
  }

  const data: { envs: EnvironmentVariable[] } = await response.json();
  return data.envs ?? [];
}

export async function getEnvironmentVariable({
  projectId,
  envId,
  token,
  teamId,
}: {
  projectId: string;
  envId: string;
  token: string;
  teamId?: string;
}): Promise<string | null> {
  const url = new URL(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`,
  );
  if (teamId) url.searchParams.set("teamId", teamId);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw await HTTPError.fromResponse(
      "Failed to fetch environment variable",
      response,
    );
  }

  const data: { value?: string } = await response.json();
  return data.value ?? null;
}

export async function deleteEnvironmentVariable({
  projectId,
  envId,
  token,
  teamId,
}: {
  projectId: string;
  envId: string;
  token: string;
  teamId?: string;
}): Promise<void> {
  const url = new URL(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`,
  );
  if (teamId) url.searchParams.set("teamId", teamId);

  const response = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw await HTTPError.fromResponse(
      "Failed to delete environment variable",
      response,
    );
  }
}
