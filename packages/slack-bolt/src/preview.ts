import { provisionPreview } from "./internal/provision";
import type {
  InstallResult,
  SlackManifestCreateResponse,
  SlackManifestUpdateResponse,
} from "./internal/slack/types";

export type PreviewParams = {
  slackConfigRefreshToken?: string;
  automationBypassSecret?: string;
  branch: string;
  branchUrl?: string;
  commitAuthor?: string;
  commitMessage?: string;
  commitSha?: string;
  deploymentId?: string;
  deploymentUrl: string;
  manifestPath: string;
  projectId: string;
  slackAppId?: string;
  slackConfigurationToken: string;
  slackServiceToken?: string;
  teamId?: string;
  vercelApiToken: string;
};

export type PreviewResult = {
  isNew: boolean;
  /** How installing the app went, like `installed` or `missing_service_token`. */
  installStatus: InstallResult["status"];
  /**
   * Why Slack didn't install the app, when `installStatus` is `unknown_error`
   * or `slack_api_error`: Slack's error code, like `service_limits_exceeded`,
   * or the HTTP status it answered with.
   */
  installError?: string;
  app: SlackManifestCreateResponse | SlackManifestUpdateResponse;
};

export const preview = async (
  params: PreviewParams,
  context?: "cli",
): Promise<PreviewResult> => {
  const { changedEnv: _changedEnv, ...result } = await provisionPreview(
    params,
    { cli: context === "cli" },
  );
  return result;
};
