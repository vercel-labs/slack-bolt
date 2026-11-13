export type Service = "Slack" | "Vercel";

/** A problem Slack found in a manifest, and where it is. */
export interface ManifestProblem {
  message?: string;
  pointer?: string;
}

/**
 * The service gave no verdict: it couldn't be reached, timed out, was
 * overloaded or is rate limiting. Trying again later can work.
 */
export class Unavailable extends Error {
  constructor(
    public service: Service,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`${service} ${reason}`, options);
    this.name = "Unavailable";
  }
}

/** Slack answered a Web API call with `ok: false`. */
export class SlackError extends Error {
  constructor(
    /** The method that failed, like `apps.manifest.update`. */
    public method: string,
    /** Slack's error code, like `invalid_manifest`. */
    public code: string,
    /** What Slack found wrong with a manifest. */
    public problems: ManifestProblem[] = [],
  ) {
    super(`Slack answered ${method} with ${code}`);
    this.name = "SlackError";
  }
}

/** Vercel answered with an HTTP error status. */
export class VercelError extends Error {
  constructor(
    public status: number,
    /** Vercel's own error code, like `forbidden`. */
    public code?: string,
    detail?: string,
  ) {
    super(`Vercel answered ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "VercelError";
  }
}

/** Slack's codes for a failure on its side, which says nothing about the request. */
const TRANSIENT = new Set([
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
  // The workspace is moving to an Enterprise org, and is back when that's done.
  "team_added_to_org",
  "org_login_required",
]);

/** Slack's codes for a token it won't accept, whatever the call. */
const TOKEN_REFUSED = new Set([
  "invalid_auth",
  "not_authed",
  "token_expired",
  "token_revoked",
  "account_inactive",
]);

/** Slack's codes for an app that doesn't exist. */
const APP_MISSING = new Set(["app_not_found", "invalid_app_id"]);

/**
 * Slack's codes for an app this token can't manage, now or later: it was
 * deleted, never existed, or belongs to someone else.
 */
const APP_UNREACHABLE = new Set([
  ...APP_MISSING,
  "no_permission",
  "app_not_owned_by_manager_app",
  "app_not_eligible",
]);

const slackCode = (error: unknown, codes: Set<string>) =>
  error instanceof SlackError && codes.has(error.code);

/** Whether trying again later can work, with nothing changed. */
export const isTransient = (error: unknown): boolean =>
  error instanceof Unavailable || slackCode(error, TRANSIENT);

/** Whether Slack refused the token itself. */
export const isTokenRefused = (error: unknown): boolean =>
  slackCode(error, TOKEN_REFUSED);

/** Whether Slack said the app doesn't exist. */
export const isAppMissing = (error: unknown): boolean =>
  slackCode(error, APP_MISSING);

/** Whether Slack said this token can never manage the app. */
export const isAppUnreachable = (error: unknown): boolean =>
  slackCode(error, APP_UNREACHABLE);

/** Whether Vercel refused the token, or doesn't show it the project. */
export const isAccessDenied = (error: unknown): boolean =>
  error instanceof VercelError && [401, 403, 404].includes(error.status);

/** An error's message, or the value itself when something else was thrown. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * An error that says what went wrong on its first line and what to do about
 * it on the next, so it reads the same in a build log and in a stack trace.
 */
export function problem(what: string, fix: string, cause?: unknown): Error {
  return new Error(`${what}\n${fix}`, cause === undefined ? {} : { cause });
}

/** What to do about a failure that passes on its own. */
export const RETRY = "Redeploy to try again.";
