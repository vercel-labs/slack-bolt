import type { Manifest } from "./types";

export function rewriteUrl(
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

function createManifestDescription(params: {
  existingDescription: string;
  existingName: string;
  branchUrl: string;
  branch: string;
  commitSha?: string;
  commitMessage?: string;
  commitAuthor?: string;
}): { longDescription: string; displayName: string } {
  const shortSha = params.commitSha?.slice(0, 7) ?? "unknown";
  const safeCommitMsg = params.commitMessage ?? "";
  const safeCommitAuthor = params.commitAuthor ?? "unknown";

  const deploymentInfo = `\n:globe_with_meridians: *Deployment URL:* ${params.branchUrl}\n:seedling: *Branch:* ${params.branch}\n:technologist: *Commit:* ${shortSha} ${safeCommitMsg}\n:bust_in_silhouette: *Last updated by:* ${safeCommitAuthor}\n\n_Automatically created by ▲ Vercel_\n`;

  const maxLongDesc = 4000;
  const combined = params.existingDescription + deploymentInfo;
  let longDescription: string;
  if (combined.length > maxLongDesc) {
    const available = Math.max(0, maxLongDesc - deploymentInfo.length);
    longDescription = (
      params.existingDescription.slice(0, available) + deploymentInfo
    ).slice(0, maxLongDesc);
  } else {
    longDescription = combined;
  }

  const maxDisplayName = 35;
  const cleanBranch = params.branch
    .replace(/^refs\/heads\//, "")
    .replace(/\//g, "-");

  let displayName = `${params.existingName} (${cleanBranch})`;
  if (displayName.length > maxDisplayName) {
    const prefix = `${params.existingName} (`;
    const suffix = ")";
    const availableForBranch = maxDisplayName - prefix.length - suffix.length;
    displayName =
      availableForBranch > 0
        ? `${prefix}${cleanBranch.slice(0, availableForBranch)}${suffix}`
        : displayName.slice(0, maxDisplayName);
  }

  return { longDescription, displayName };
}

export function createNewManifest(params: {
  originalManifest: Manifest;
  branchUrl: string;
  bypassSecret: string;
  branch: string;
  commitSha?: string;
  commitMessage?: string;
  commitAuthor?: string;
}): Manifest {
  const manifest = structuredClone(params.originalManifest);

  if (manifest.settings?.event_subscriptions?.request_url) {
    manifest.settings.event_subscriptions.request_url = rewriteUrl(
      manifest.settings.event_subscriptions.request_url,
      params.branchUrl,
      params.bypassSecret,
    );
  }

  if (manifest.settings?.interactivity?.request_url) {
    manifest.settings.interactivity.request_url = rewriteUrl(
      manifest.settings.interactivity.request_url,
      params.branchUrl,
      params.bypassSecret,
    );
  }

  if (manifest.features?.slash_commands) {
    for (const cmd of manifest.features.slash_commands) {
      if (cmd.url) {
        cmd.url = rewriteUrl(cmd.url, params.branchUrl, params.bypassSecret);
      }
    }
  }

  if (manifest.oauth_config?.redirect_urls) {
    manifest.oauth_config.redirect_urls =
      manifest.oauth_config.redirect_urls.map((originalUrl) =>
        rewriteUrl(originalUrl, params.branchUrl),
      );
  }

  const { longDescription, displayName } = createManifestDescription({
    existingDescription: manifest.display_information.long_description ?? "",
    existingName:
      manifest.features?.bot_user?.display_name ??
      manifest.display_information.name,
    branchUrl: params.branchUrl,
    branch: params.branch,
    commitSha: params.commitSha,
    commitMessage: params.commitMessage,
    commitAuthor: params.commitAuthor,
  });

  manifest.display_information.long_description = longDescription;
  manifest.display_information.name = displayName;
  if (manifest.features?.bot_user) {
    manifest.features.bot_user.display_name = displayName;
  }

  return manifest;
}
