// Build logs aren't private, and this package handles tokens that can create
// and delete Slack apps. Nothing it prints or throws may carry one, so every
// message on its way out goes through `scrub`.

/** Values seen during this process that must never be printed. */
const known = new Set<string>();

/** A shorter value would match ordinary words. */
const MIN_LENGTH = 8;

const REDACTED = "[redacted]";

/** The Deployment Protection bypass secret, wherever a URL carries it. */
const BYPASS_PARAM = /(x-vercel-protection-bypass=)[^&"'\s\\]+/gi;

/**
 * Slack tokens by prefix: bot (`xoxb-`), user (`xoxp-`), app-level (`xapp-`),
 * configuration (`xoxe.xoxp-`), refresh (`xoxe-`) and the rest of the family.
 */
const SLACK_TOKEN = /\b(?:xox[a-z]\.xox[a-z]|xox[a-z]|xapp)-[A-Za-z0-9-]+/g;

/** Vercel tokens with a typed prefix, like `vcp_`. */
const VERCEL_TOKEN = /\bvc[a-z]_[A-Za-z0-9]{16,}/g;

/** What a token is made of: visible ASCII characters and nothing else. */
const TOKEN = /^[!-~]+$/;

/**
 * Marks a value as secret and returns it. A signing or client secret has no
 * shape to recognise it by, so `scrub` can only take out the ones it was told
 * about.
 */
export function secret<T extends string | null | undefined>(value: T): T {
  if (value && value.length >= MIN_LENGTH) known.add(value);
  return value;
}

/** Forgets every secret. For tests. */
export function forgetSecrets(): void {
  known.clear();
}

/**
 * Takes secrets out of text: every known value, anything shaped like a Slack
 * or Vercel token, and the bypass secret in a URL.
 */
export function scrub(text: string): string {
  let result = text;
  // Longest first, so a secret that contains another is replaced whole.
  for (const value of [...known].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(value, REDACTED);
  }
  return result
    .replace(BYPASS_PARAM, `$1${REDACTED}`)
    .replace(SLACK_TOKEN, REDACTED)
    .replace(VERCEL_TOKEN, REDACTED);
}

/**
 * A token ready to send: marked as secret, without the space or line break a
 * paste leaves around it.
 *
 * @throws Without repeating the value, when it has one inside. `fetch`
 * refuses such a header with an error that quotes it, and that looks like the
 * network failing.
 */
export function token(name: string, value: string): string;
export function token(
  name: string,
  value: string | undefined,
): string | undefined;
export function token(
  name: string,
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  secret(value);
  const trimmed = value.trim();
  if (!TOKEN.test(trimmed)) {
    throw new Error(
      `${name} has a space, line break or non-ASCII character in it, so it isn't a valid token\nCopy it again in one piece and save it.`,
    );
  }
  return secret(trimmed);
}

/**
 * Scrubs an error's message, and those of its causes, in place. The last
 * thing `preview` and `cleanup` do to an error before it leaves.
 */
export function scrubError(error: unknown): unknown {
  const seen = new Set<unknown>();
  for (
    let current = error;
    current instanceof Error && !seen.has(current);
    current = current.cause
  ) {
    seen.add(current);
    current.message = scrub(current.message);
  }
  return error;
}
