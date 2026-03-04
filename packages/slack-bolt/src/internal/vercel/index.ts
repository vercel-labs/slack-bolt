import crypto from "node:crypto";
import type { CreateProjectEnv21 } from "@vercel/sdk/esm/models/createprojectenvop";
import { HTTPError } from "./errors";
import type { AddEnvironmentVariablesResult } from "./types";

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
    throw new HTTPError(
      "Failed to update protection bypass",
      response.status,
      response.statusText,
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
    throw new HTTPError(
      "Failed to create environment variables",
      response.status,
      response.statusText,
    );
  }

  return response.json();
}
