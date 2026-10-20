import {
  type App,
  AppInitializationError,
  HTTPReceiver,
  type HTTPReceiverOptions,
} from "@slack/bolt";
import { waitUntil } from "@vercel/functions";

/**
 * Options for {@link VercelReceiver}. Accepts every Bolt `HTTPReceiver`
 * option. Pass `logger` and `logLevel` here: Bolt doesn't apply the App's
 * logger to a custom receiver.
 */
export interface VercelReceiverOptions extends Omit<
  HTTPReceiverOptions,
  "signingSecret"
> {
  /**
   * Verifies that requests come from Slack. Required unless
   * `signatureVerification` is `false`.
   * @default process.env.SLACK_SIGNING_SECRET
   */
  signingSecret?: string | undefined;
}

const noop = () => {};

/** Keeps the function running until `work` settles, and returns `work`. */
function keepAlive<T>(work: T): T {
  waitUntil(Promise.resolve(work).then(noop, noop));
  return work;
}

/**
 * A Bolt receiver for Vercel Functions.
 *
 * Extends Bolt's `HTTPReceiver` and keeps each event's listeners running with
 * `waitUntil` after Slack has been acknowledged.
 *
 * @example
 * ```ts
 * import { App } from "@slack/bolt";
 * import { VercelReceiver } from "@vercel/slack-bolt/v2";
 *
 * const receiver = new VercelReceiver();
 * const app = new App({
 *   receiver,
 *   token: process.env.SLACK_BOT_TOKEN,
 *   // Checks the token on the first event, and again if that fails.
 *   deferInitialization: true,
 * });
 * ```
 */
export class VercelReceiver extends HTTPReceiver {
  /**
   * @param options Bolt `HTTPReceiver` options. `signingSecret` defaults to
   * `process.env.SLACK_SIGNING_SECRET`.
   * @throws {AppInitializationError} When the signing secret is missing and
   * `signatureVerification` isn't `false`.
   */
  public constructor(options: VercelReceiverOptions = {}) {
    const {
      signingSecret = process.env.SLACK_SIGNING_SECRET ?? "",
      processEventErrorHandler,
      ...rest
    } = options;

    // Fail closed with a clear message: Bolt < 4.7.3 accepts an empty secret,
    // and pnpm and yarn don't enforce the peer range.
    if (rest.signatureVerification !== false && !signingSecret) {
      throw new AppInitializationError(
        "Missing signing secret. Set the SLACK_SIGNING_SECRET environment variable or pass the signingSecret option.",
      );
    }

    super({
      ...rest,
      signingSecret,
      // Bolt runs it after processEvent has settled, so keep it alive too.
      ...(processEventErrorHandler && {
        processEventErrorHandler: (args) =>
          keepAlive(processEventErrorHandler(args)),
      }),
    });
  }

  /**
   * Called by Bolt when the `App` is created. Registers each event's
   * processing with `waitUntil` so listeners finish after the response, and
   * runs `app.init()` on the first event for an App created with
   * `deferInitialization`.
   */
  public override init(app: App): void {
    // An App created with deferInitialization waits for app.init(), which
    // nothing calls on Vercel. Run it once, on the first event, and have
    // concurrent events wait for it. Retry on the next event if it fails.
    let initializing: Promise<void> | undefined;
    const ready = () => {
      if (
        !initializing &&
        (app as unknown as { initialized?: boolean }).initialized === false
      ) {
        initializing = app.init().then(
          () => {
            initializing = undefined;
          },
          (error: unknown) => {
            initializing = undefined;
            // Bolt only logs a generic error for the event, so say why.
            this["logger"].error(
              "app.init() failed, so this event wasn't processed. It runs again on the next event.",
              error,
            );
            throw error;
          },
        );
      }
      return initializing;
    };

    const processEvent: App["processEvent"] = (event) => {
      const pending = ready();
      return keepAlive(
        pending
          ? pending.then(() => app.processEvent(event))
          : app.processEvent(event),
      );
    };
    super.init(
      new Proxy(app, {
        get: (target, prop, receiver) =>
          prop === "processEvent"
            ? processEvent
            : Reflect.get(target, prop, receiver),
      }),
    );
  }
}
