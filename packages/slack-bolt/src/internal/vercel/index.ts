import crypto from "node:crypto";
import type { CreateProjectEnv21 } from "@vercel/sdk/esm/models/createprojectenvop";
import { HTTPError } from "./errors";
import type { AddEnvironmentVariablesResult, GetAuthUserResult } from "./types";

export async function getAuthUser({
  token,
}: {
  token: string;
}): Promise<GetAuthUserResult> {
  const response = await fetch("https://api.vercel.com/v2/user", {
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

  const response = await fetch(
    `https://api.vercel.com/v1/projects/${projectId}/protection-bypass?teamId=${teamId}`,
    {
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
    },
  );

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
  envs: CreateProjectEnv21 | CreateProjectEnv21[];
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
