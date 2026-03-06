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

export const log = {
  step: (msg: string) => console.log(`  ${msg} ...`),
  success: (msg: string) => console.log(`${GREEN}✓${RESET} ${msg}`),
  info: (msg: string) => console.log(`  ${msg}`),
  warning: (msg: string) => console.log(`${YELLOW}⚠${RESET} ${msg}`),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => {
    if (isDebug()) {
      const msg = args
        .map((a) => (typeof a === "string" ? a : String(a)))
        .join(" ");
      console.debug(`${DIM}${msg}${RESET}`);
    }
  },
};

const REDACTED_HEADERS = new Set(["authorization"]);

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

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_BODY_KEYS.has(lower)) return true;
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

function redactValue(value: string): string {
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function redactSensitiveFields(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveFields(item));
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (isSensitiveKey(key) && typeof val === "string") {
        result[key] = redactValue(val);
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
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers ?? {});
  const redacted = entries.map(([k, v]) =>
    REDACTED_HEADERS.has(k.toLowerCase()) ? [k, `****${v.slice(-4)}`] : [k, v],
  );
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
    if (typeof init?.body === "string") log.debug(`   body: ${redactBody(init.body)}`);

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
