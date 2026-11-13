import { type Service, Unavailable } from "./errors";
import type { Log } from "./log";
import { wait } from "./wait";

export interface Call {
  service: Service;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string | URL;
  headers: Record<string, string>;
  body?: string | URLSearchParams;
  /**
   * Whether sending the request twice does no more than sending it once. One
   * that isn't, like creating an app, is only sent again when the server
   * said it did nothing.
   */
  repeatable: boolean;
  /** How the request shows in debug output, in place of its URL. */
  label?: string;
}

export interface Answer {
  status: number;
  /** The body as JSON, or `undefined` when it isn't JSON. */
  body: unknown;
}

/** A build shouldn't wait on one request for longer than this. */
const TIMEOUT_MS = 30_000;

const ATTEMPTS = 3;
const BACKOFF_MS = [500, 2_000];

/** The longest a rate limit may ask a build to wait before it gives up. */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

/** How long a rate-limited response asks to wait, when it says. */
function retryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Sends a request and resolves with the answer, unless the server gave none.
 *
 * Tries again when that can help and can't hurt: after a rate limit, which
 * means the server did nothing, and for a repeatable request also after a
 * network failure or a 5xx, where the server may have done the work already.
 *
 * @throws {Unavailable} When the service couldn't be reached, timed out, kept
 * rate limiting or answered with a server error.
 */
export async function send(call: Call, log: Log): Promise<Answer> {
  const shown = call.label ?? `${call.method} ${String(call.url)}`;

  for (let attempt = 1; ; attempt++) {
    const last = attempt === ATTEMPTS;
    const backoff = BACKOFF_MS[attempt - 1] ?? 0;
    const started = Date.now();
    log.debug(`→ ${shown}`);

    let response: Response;
    try {
      response = await fetch(String(call.url), {
        method: call.method,
        headers: call.headers,
        body: call.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      const reason = timedOut
        ? `didn't answer within ${TIMEOUT_MS / 1000} seconds`
        : "couldn't be reached";
      log.debug(`← ${shown}: ${reason}`);
      if (call.repeatable && !last) {
        await wait(backoff);
        continue;
      }
      throw new Unavailable(call.service, reason, { cause: error });
    }

    const { status } = response;
    log.debug(`← ${shown}: ${status} (${Date.now() - started}ms)`);

    if (status === 429) {
      const delay = retryAfter(response) ?? backoff;
      if (last || delay > MAX_RATE_LIMIT_WAIT_MS) {
        throw new Unavailable(call.service, "is rate limiting requests");
      }
      await response.body?.cancel().catch(() => {});
      await wait(delay);
      continue;
    }
    if (status >= 500) {
      if (last || !call.repeatable) {
        throw new Unavailable(call.service, `answered ${status}`);
      }
      await response.body?.cancel().catch(() => {});
      await wait(backoff);
      continue;
    }

    return { status, body: await response.json().catch(() => undefined) };
  }
}
