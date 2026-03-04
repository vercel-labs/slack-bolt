import crypto from "node:crypto";
import { HTTPError } from "./errors";
import type {
  AddEnvironmentVariablesResult,
  CreateProjectEnv,
  EnvironmentVariable,
  GetAuthUserResult,
} from "./types";

export async function getAuthUser({
  token,
  teamId,
}: {
  token: string;
  teamId?: string;
}): Promise<GetAuthUserResult> {
  const url = new URL("https://api.vercel.com/v2/user");
  if (teamId) url.searchParams.set("teamId", teamId);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw await HTTPError.fromResponse(
      "Failed to get authenticated user",
      response,
    );
  }

  return response.json();
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
  const newSecret = crypto.randomBytes(32).toString("hex");
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

export async function getActiveBranches({
  projectId,
  token,
  teamId,
}: {
  projectId: string;
  token: string;
  teamId?: string;
}): Promise<Set<string>> {
  const params = new URLSearchParams({ active: "1", limit: "100" });
  if (teamId) params.set("teamId", teamId);

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

  const data: { branches?: { branch: string }[] } = await response.json();
  return new Set(data.branches?.map((b) => b.branch) ?? []);
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
