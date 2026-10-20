import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type App,
  AppInitializationError,
  type CodedError,
  ErrorCode,
  HTTPReceiver,
  type HTTPReceiverOptions,
} from "@slack/bolt";
import { waitUntil } from "@vercel/functions";
import { fetchNodeHandler } from "srvx/node";

/**
 * Options for {@link VercelReceiver}: Bolt's `HTTPReceiver` options, minus
 * the ones for Bolt's own server (`endpoints`, `customRoutes`, `port` and
 * `dispatchErrorHandler`), which don't apply when your route calls `fetch`.
 * Pass `logger` and `logLevel` here: Bolt doesn't apply the App's logger to a
 * custom receiver. The OAuth options authorize events from your
 * `installationStore`, but `fetch` doesn't serve the install or redirect
 * pages yet.
 */
export interface VercelReceiverOptions extends Omit<
  HTTPReceiverOptions,
  | "signingSecret"
  | "endpoints"
  | "customRoutes"
  | "port"
  | "dispatchErrorHandler"
> {
  /**
   * Verifies that requests come from Slack. Required unless
   * `signatureVerification` is `false`.
   * @default process.env.SLACK_SIGNING_SECRET
   */
  signingSecret?: string | undefined;
}

// The one endpoint we give Bolt. fetch points every request here, so it never
// needs to match the URL Slack calls.
const ENDPOINT = "/slack/events";

const BODY_USED =
  "Request body already read. Bolt needs the raw body to verify Slack's signature, so pass request.clone() to fetch instead.";

const noop = () => {};

/** Keeps the function running until `work` settles, and returns `work`. */
function keepAlive<T>(work: T): T {
  waitUntil(Promise.resolve(work).then(noop, noop));
  return work;
}

const isDeferred = (error: unknown) =>
  (error as CodedError | undefined)?.code ===
  ErrorCode.HTTPReceiverDeferredRequestError;

/**
 * A Bolt receiver for Vercel Functions.
 *
 * Extends Bolt's `HTTPReceiver` and keeps each event's listeners running with
 * `waitUntil` after Slack has been acknowledged. Serve it with
 * {@link VercelReceiver.fetch} from a route at any path.
 *
 * @example
 * ```ts
 * // lib/slack.ts
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
 *
 * export const { POST } = receiver;
 *
 * // app/api/slack/route.ts
 * export { POST } from "@/lib/slack";
 * ```
 */
export class VercelReceiver extends HTTPReceiver {
  /**
   * Handles a Slack request and resolves with the response once Slack is
   * acknowledged; listeners keep running with `waitUntil`. Mount it at any
   * path and point your Slack app's request URLs there: `POST` requests are
   * events, commands and interactions, and anything else is a 404.
   *
   * @throws {TypeError} When the request body was already read.
   */
  public readonly fetch = async (request: Request): Promise<Response> => {
    if (request.bodyUsed) throw new TypeError(BODY_USED);
    try {
      return await fetchNodeHandler(
        (req: IncomingMessage, res: ServerResponse) => this.#route(req, res),
        request,
      );
    } catch (error) {
      // srvx's own Node server rejects instead of answering.
      this["logger"].error("Couldn't handle the Slack request.", error);
      return new Response(null, { status: 500 });
    }
  };

  /** {@link VercelReceiver.fetch} for a framework's `POST` route export. */
  public readonly POST = (request: Request): Promise<Response> =>
    this.fetch(request);

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
      endpoints: ENDPOINT,
      // Bolt runs it after processEvent has settled, so keep it alive too.
      ...(processEventErrorHandler && {
        processEventErrorHandler: (args) =>
          keepAlive(processEventErrorHandler(args)),
      }),
    });
  }

  // Bolt's requestListener routes by path, but the framework has already
  // routed this request, so send it to Bolt's endpoint whatever its path.
  #route(req: IncomingMessage, res: ServerResponse): void {
    const original = req.url;
    const { search } = new URL(original ?? "/", "http://localhost");
    req.url = ENDPOINT + search;

    try {
      this.requestListener(req, res);
    } catch (error) {
      // Bolt only handles POST at its endpoint.
      if (isDeferred(error)) {
        res.writeHead(404).end();
        return;
      }
      // Log through our logger, not srvx's console.error with every header.
      this["logger"].error("Couldn't handle the Slack request.", error);
      if (!res.headersSent) res.writeHead(500).end();
    } finally {
      // Bolt has routed by now; leave the framework's request as it was.
      req.url = original;
    }
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
