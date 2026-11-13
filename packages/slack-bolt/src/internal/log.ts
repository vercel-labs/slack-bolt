import { scrub } from "./secrets";

/**
 * Where `preview` and `cleanup` say what they did. `console` is one:
 *
 * ```ts
 * await preview({ logger: console });
 * ```
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  /** Every request and how it was answered. Never a header or a body. */
  debug?(message: string): void;
}

/** What a run can say, as the code inside this package says it. */
export interface Log {
  /** Something was done. */
  ok(message: string): void;
  /** A detail about the line above. */
  note(message: string): void;
  /** Something needs attention, and the run carries on. */
  warn(message: string): void;
  /** A request, or its answer. */
  debug(message: string): void;
}

/**
 * A `Log` that writes to a `Logger`, or nowhere without one.
 *
 * Messages are built from what Slack and Vercel answer, which this package
 * doesn't control, so each is scrubbed first.
 */
export function logTo(logger: Logger | undefined): Log {
  return {
    ok: (message) => logger?.info(scrub(message)),
    // Indented, to sit under the line it's about.
    note: (message) => logger?.info(`  ${scrub(message)}`),
    warn: (message) => logger?.warn(scrub(message)),
    debug: (message) => logger?.debug?.(scrub(message)),
  };
}
