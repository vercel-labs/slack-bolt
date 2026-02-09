import fs from "node:fs/promises";
import path from "node:path";
import type { Manifest } from "@slack/web-api/dist/types/request/manifest";
import type { DeploymentContext } from "./types";

export function prepareManifest(
  manifest: Manifest,
  context: DeploymentContext,
): void {
  const {
    branch,
    branchUrl,
    commitSha,
    commitMsg,
    commitAuthor,
    bypassSecret,
  } = context;
  const baseUrl = `https://${branchUrl}`;
  const shortSha = commitSha.slice(0, 7);

  manifest.display_information.name = formatPreviewName(
    manifest.display_information.name,
    branch,
  );

  if (manifest.features?.bot_user?.display_name) {
    manifest.features.bot_user.display_name = formatPreviewName(
      manifest.features.bot_user.display_name,
      branch,
    );
  }

  const deploymentInfo = [
    `\n`,
    `:globe_with_meridians: *Deployment URL:* ${branchUrl}`,
    `:seedling: *Branch:* ${branch}`,
    `:technologist: *Commit:* ${shortSha} ${commitMsg}`,
    `:bust_in_silhouette: *Last updated by:* ${commitAuthor}`,
    `\n`,
    `_Automatically created by ▲ Vercel_`,
    ``,
  ].join("\n");

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

  injectUrls(manifest, baseUrl, bypassSecret);
}

export function injectUrls(
  manifest: Manifest,
  baseUrl: string,
  bypassSecret?: string | null,
): void {
  function buildUrl(originalUrl: string): string {
    const p = extractPath(originalUrl);
    const url = `${baseUrl}${p}`;
    if (!bypassSecret) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}x-vercel-protection-bypass=${bypassSecret}`;
  }

  if (manifest.settings?.event_subscriptions?.request_url) {
    manifest.settings.event_subscriptions.request_url = buildUrl(
      manifest.settings.event_subscriptions.request_url,
    );
  }
  if (manifest.settings?.interactivity?.request_url) {
    manifest.settings.interactivity.request_url = buildUrl(
      manifest.settings.interactivity.request_url,
    );
  }
  if (manifest.features?.slash_commands) {
    for (const cmd of manifest.features.slash_commands) {
      if (cmd.url) {
        cmd.url = buildUrl(cmd.url);
      }
    }
  }
}

export function extractPath(urlOrPath: string): string {
  const protocolMatch = urlOrPath.match(/^https?:\/\/[^/]+(\/.*)?$/);
  if (protocolMatch) {
    return protocolMatch[1] || "/";
  }

  try {
    const url = new URL(urlOrPath);
    return url.pathname + url.search;
  } catch {
    return urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`;
  }
}

export async function loadManifest(manifestPath: string): Promise<Manifest> {
  const resolved = path.resolve(process.cwd(), manifestPath);
  const content = await fs.readFile(resolved, "utf-8");
  try {
    return JSON.parse(content) as Manifest;
  } catch {
    throw new Error(
      `Failed to parse manifest as JSON from ${manifestPath}. Ensure it's valid JSON.`,
    );
  }
}

function formatPreviewName(originalName: string, branch: string): string {
  const maxLength = 35;
  const cleanBranch = branch.replace(/^refs\/heads\//, "").replace(/\//g, "-");

  const full = `${originalName} (${cleanBranch})`;

  if (full.length <= maxLength) {
    return full;
  }

  const prefix = `${originalName} (`;
  const suffix = ")";
  const availableForBranch = maxLength - prefix.length - suffix.length;

  if (availableForBranch <= 0) {
    return full.slice(0, maxLength);
  }

  return `${prefix}${cleanBranch.slice(0, availableForBranch)}${suffix}`;
}
