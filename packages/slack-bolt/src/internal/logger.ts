function isDebug(): boolean {
  return (
    process.env.VERCEL_SLACK_DEBUG === "1" ||
    process.env.VERCEL_SLACK_DEBUG === "true"
  );
}

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

type PatchedFetch = typeof globalThis.fetch & { __debugPatched?: boolean };

/** The deployment protection bypass secret, wherever a URL carries it. */
const BYPASS_PARAM = /(x-vercel-protection-bypass=)[^&"'\s\\]+/gi;

/**
 * Slack tokens, by their prefix: bot (`xoxb-`), user (`xoxp-`), app-level
 * (`xapp-`), configuration (`xoxe.xoxp-`), refresh (`xoxe-`) and the rest of
 * the `xox` family.
 */
const SLACK_TOKEN = /\b(?:xox[a-z]\.xox[a-z]|xox[a-z]|xapp)-[A-Za-z0-9-]+/g;

/** Vercel access tokens with a typed prefix, like `vcp_`. */
const VERCEL_TOKEN = /\bvc[a-z]_[A-Za-z0-9]{16,}/g;

/** Shorter than this, the last characters are too much of a value to show. */
const MIN_LENGTH_TO_SHOW_END = 16;

function redactValue(value: string): string {
  if (value.length < MIN_LENGTH_TO_SHOW_END) return "****";
  return `****${value.slice(-4)}`;
}

/** Values that must not be printed, wherever they turn up. */
const secrets = new Set<string>();

/**
 * Marks values as secret, so `scrub` takes them out of anything printed: a
 * signing or client secret has no shape to recognise it by, and an error
 * message or a field with an innocent name can still carry one.
 */
export function registerSecret(...values: (string | null | undefined)[]): void {
  for (const value of values) {
    // A value this short would match ordinary words.
    if (value && value.length >= 8) secrets.add(value);
  }
}

/**
 * Takes secrets out of text on its way to the logs: the values registered as
 * secret, anything shaped like a Slack or Vercel token, and the bypass secret
 * in a URL.
 */
export function scrub(text: string): string {
  let result = text;
  // Longest first, so a secret that contains another goes as a whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (result.includes(secret)) {
      result = result.split(secret).join(redactValue(secret));
    }
  }
  return result
    .replace(BYPASS_PARAM, "$1****")
    .replace(SLACK_TOKEN, redactValue)
    .replace(VERCEL_TOKEN, redactValue);
}

const text = (value: unknown) =>
  typeof value === "string" ? value : String(value);

// Everything printed goes through `scrub`: messages are built from errors and
// from what Slack and Vercel answer, which the code doesn't control.
export const log = {
  step: (msg: string) => console.log(scrub(`  ${msg} ...`)),
  success: (msg: string) => console.log(`${GREEN}✓${RESET} ${scrub(msg)}`),
  info: (msg: string) => console.log(scrub(`  ${msg}`)),
  warning: (msg: string) => console.log(`${YELLOW}⚠${RESET} ${scrub(msg)}`),
  error: (...args: unknown[]) =>
    console.error(...args.map((arg) => scrub(text(arg)))),
  debug: (...args: unknown[]) => {
    if (isDebug()) {
      console.debug(`${DIM}${scrub(args.map(text).join(" "))}${RESET}`);
    }
  },
};

const REDACTED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-vercel-protection-bypass",
]);

/** Header name fragments that mark its value as a credential. */
const SENSITIVE_HEADER_PATTERNS = ["token", "secret", "api-key", "apikey"];

function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    REDACTED_HEADERS.has(lower) ||
    SENSITIVE_HEADER_PATTERNS.some((pattern) => lower.includes(pattern))
  );
}

/**
 * Keys whose values should be redacted when logging request/response bodies.
 * Matches are case-insensitive and checked against the lowercased key.
 */
const SENSITIVE_BODY_KEYS = new Set([
  "token",
  "bot",
  "app_level",
  "user",
  "secret",
  "client_secret",
  "signing_secret",
  "verification_token",
  "bot_token",
  "user_token",
  "app_level_token",
  "value",
  "access_token",
  "refresh_token",
  "password",
]);

/**
 * Key name fragments — if any of these appear in a key name (case-insensitive),
 * the value is redacted.
 */
const SENSITIVE_KEY_PATTERNS = ["token", "secret", "password", "credential"];

/**
 * Keys whose whole value is redacted, however it's nested. Vercel returns a
 * project's deploy hooks with their URLs, and anyone who has one can deploy.
 */
const SENSITIVE_CONTAINER_KEYS = new Set(["deployhooks"]);

function matchesSensitivePattern(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

function isSensitiveKey(key: string): boolean {
  return (
    SENSITIVE_BODY_KEYS.has(key.toLowerCase()) || matchesSensitivePattern(key)
  );
}

/** Redacts every string in a value, whatever the keys around it are called. */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactValue(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDeep(item)]),
    );
  }
  return value;
}

/**
 * Redacts secrets inside a string value. Slack's manifest methods take the
 * manifest as a JSON string, and its request URLs carry the deployment
 * protection bypass secret, so look inside embedded JSON and URLs too.
 */
function redactString(value: string): string {
  const start = value.trimStart()[0];
  if (start === "{" || start === "[") {
    try {
      return JSON.stringify(redactSensitiveFields(JSON.parse(value)));
    } catch {
      // Not JSON after all.
    }
  }
  return scrub(value);
}

function redactSensitiveFields(obj: unknown): unknown {
  if (typeof obj === "string") return redactString(obj);
  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveFields(item));
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (isSensitiveKey(key) && typeof val === "string") {
        result[key] = redactValue(val);
      } else if (
        SENSITIVE_CONTAINER_KEYS.has(key.toLowerCase()) ||
        (matchesSensitivePattern(key) &&
          val !== null &&
          typeof val === "object")
      ) {
        // A key named for secrets, like `api_access_tokens` or `credentials`,
        // can hold them under names this file doesn't know. Short names like
        // `bot` and `user` don't count: a manifest lists scopes under them.
        result[key] = redactDeep(val);
      } else if (
        key.toLowerCase() === "protectionbypass" &&
        val !== null &&
        typeof val === "object" &&
        !Array.isArray(val)
      ) {
        // Vercel keys this map by the bypass secrets themselves.
        result[key] = Object.fromEntries(
          Object.entries(val).map(([secret, details]) => [
            redactValue(secret),
            redactSensitiveFields(details),
          ]),
        );
      } else {
        result[key] = redactSensitiveFields(val);
      }
    }
    return result;
  }
  return obj;
}

function redactBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    const redacted = redactSensitiveFields(parsed);
    return JSON.stringify(redacted);
  } catch {
    // Not JSON — redact entirely to be safe since we can't inspect the structure
    return `<non-JSON body, ${body.length} bytes>`;
  }
}

function formatHeaders(headers?: HeadersInit): string {
  // Headers can also be a list of pairs; read every form the same way.
  let entries: [string, string][];
  try {
    entries = [...new Headers(headers).entries()];
  } catch {
    return "<unreadable headers>";
  }
  const redacted = entries.map(([name, value]) => [
    name,
    isSensitiveHeader(name) ? redactValue(value) : scrub(value),
  ]);
  return JSON.stringify(Object.fromEntries(redacted));
}

export function enableFetchDebugLogging(): void {
  if ((globalThis.fetch as PatchedFetch).__debugPatched) return;

  const originalFetch = globalThis.fetch;
  const patched: PatchedFetch = async (input, init) => {
    const method = init?.method ?? "GET";
    const url = input instanceof Request ? input.url : input.toString();
    const start = performance.now();
    log.debug(`-> ${method} ${url}`);
    log.debug(`   headers: ${formatHeaders(init?.headers)}`);
    if (typeof init?.body === "string")
      log.debug(`   body: ${redactBody(init.body)}`);

    const response = await originalFetch(input, init);

    const ms = (performance.now() - start).toFixed(0);
    log.debug(`<- ${response.status} ${response.statusText} (${ms}ms)`);
    log.debug(`   headers: ${formatHeaders(response.headers)}`);

    const clone = response.clone();
    try {
      const body = await clone.text();
      if (body) log.debug(`   body: ${redactBody(body)}`);
    } catch {}

    return response;
  };
  patched.__debugPatched = true;
  globalThis.fetch = patched;
}

export const startMessage = (
  version?: string,
  branch?: string,
  commit?: string,
  appId?: string,
) => {
  const lines = [`▲ @vercel/slack-bolt ${version ?? ""}`];
  if (branch) lines.push(`  - Branch: ${branch}`);
  if (commit) lines.push(`  - Commit: ${commit.slice(0, 7)}`);
  if (appId) lines.push(`  - App ID: ${appId}`);
  return `${BOLD}${lines.join("\n")}${RESET}\n`;
};
