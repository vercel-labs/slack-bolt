import type { Manifest } from "../manifest/types";

export interface SlackManifestCreateResponse {
  ok: boolean;
  error?: string;
  errors?: { message: string; pointer: string }[];
  app_id: string;
  credentials: {
    client_id: string;
    client_secret: string;
    verification_token: string;
    signing_secret: string;
  };
  oauth_authorize_url: string;
}

export interface SlackManifestUpdateResponse {
  ok: boolean;
  error?: string;
  errors?: { message: string; pointer: string }[];
  app_id: string;
  permissions_updated: boolean;
}

export interface SlackManifestExportResponse {
  ok: boolean;
  error?: string;
  manifest: Manifest;
}

export type InstallResponse = {
  ok: boolean;
  error?: string;
  app_id?: string;
  api_access_tokens?: {
    bot?: string;
    app_level?: string;
    user?: string;
  };
};

export type InstallResult = {
  status:
    | "installed"
    | "missing_service_token"
    | "app_approval_request_eligible"
    | "app_approval_request_pending"
    | "app_approval_request_denied"
    | "slack_api_error"
    | "unknown_error";
  error?: string;
  botToken?: string;
  appLevelToken?: string;
  userToken?: string;
};
