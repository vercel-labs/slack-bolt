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
 * custom receiver. Pass the OAuth options (`clientId`, `clientSecret`,
 * `stateSecret`, `scopes`, `installationStore`) here too, not to the App. Bolt
 * doesn't apply the App's `clientOptions` to the installer either, so pass
 * them as `installerOptions.clientOptions` as well.
 */
export interface VercelReceiverOptions extends Omit<
  HTTPReceiverOptions,
  | "signingSecret"
  | "endpoints"
  | "customRoutes"
  | "port"
  | "dispatchErrorHandler"
  | "installerOptions"
> {
  /**
   * Verifies that requests come from Slack. Required unless
   * `signatureVerification` is `false`.
   * @default process.env.SLACK_SIGNING_SECRET
   */
  signingSecret?: string | undefined;
  /**
   * Absolute OAuth callback URL with a path, like
   * `https://example.com/api/slack/oauth`, without a query string or fragment.
   */
  redirectUri?: string;
  /**
   * Bolt's installer options, minus `installPath`, `redirectUriPath` and
   * `port`: `fetch` serves the install page and OAuth callback at whatever
   * path your route has.
   */
  installerOptions?: Omit<
    NonNullable<HTTPReceiverOptions["installerOptions"]>,
    "installPath" | "redirectUriPath" | "port"
  >;
}

// The paths we give Bolt. fetch points each request at one of them, so they
// never need to match the URLs Slack and your users call.
const ENDPOINT = "/slack/events";
const INSTALL_PATH = "/slack/install";
const CALLBACK_PATH = "/slack/oauth_redirect";

// Slack sends these to the OAuth callback, never to the install page.
const CALLBACK_PARAMS = ["code", "error", "state"];

const BODY_USED =
  "Request body already read. Bolt needs the raw body to verify Slack's signature, so clone the request before you read it, read the original and pass the clone to fetch.";

/**
 * Whether the request's body was already read. A srvx Node request, like
 * Express's and Nitro's, hands Bolt the Node stream underneath, which reading a
 * clone also drains without setting `bodyUsed`.
 */
function bodyRead(request: Request): boolean {
  const node = (request as { runtime?: { node?: { req?: IncomingMessage } } })
    .runtime?.node?.req;
  return request.bodyUsed || node?.readableDidRead === true;
}

const noop = () => {};

/** Keeps the function running until `work` settles, and returns `work`. */
function keepAlive<T>(work: T): T {
  waitUntil(Promise.resolve(work).then(noop, noop));
  return work;
}

const isDeferred = (error: unknown) =>
  (error as CodedError | undefined)?.code ===
  ErrorCode.HTTPReceiverDeferredRequestError;

/** The path of `redirectUri`, which Bolt needs as `redirectUriPath`. */
function pathOf(redirectUri: string): string {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new AppInitializationError(
      `redirectUri must be an absolute URL, like https://example.com/api/slack, but it's "${redirectUri}".`,
    );
  }
  // Bolt checks the original URL's suffix, then routes by pathname. Check
  // the delimiters directly: URL.search and URL.hash omit empty "?" and "#".
  if (redirectUri.includes("?") || redirectUri.includes("#")) {
    throw new AppInitializationError(
      "redirectUri must not include a query string or fragment. Use a URL like https://example.com/api/slack/oauth.",
    );
  }
  // Bolt also checks that redirectUri ends with this path, and blames
  // installerOptions.redirectUriPath if not. A bare origin's path is "/", and
  // URL percent-encodes characters like "ü" in the path.
  if (!redirectUri.endsWith(url.pathname)) {
    throw new AppInitializationError(
      url.pathname === "/"
        ? `redirectUri must include a path, like https://example.com/api/slack/oauth, but it's "${redirectUri}".`
        : `redirectUri must be percent-encoded, like ${url.origin}${url.pathname}, but it's "${redirectUri}".`,
    );
  }
  return url.pathname;
}

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
 * import { VercelReceiver } from "@vercel/slack-bolt";
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
   * events, commands and interactions. With the OAuth options, a `GET` with a
   * `code`, `error` or `state` parameter is the OAuth callback and any other
   * `GET` is the install page, so one route or separate ones both work.
   * Anything else is a 404.
   *
   * @throws {TypeError} When the request body was already read.
   */
  public readonly fetch = async (request: Request): Promise<Response> => {
    if (bodyRead(request)) throw new TypeError(BODY_USED);
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

  /** {@link VercelReceiver.fetch} for a framework's `GET` route export. */
  public readonly GET = (request: Request): Promise<Response> =>
    this.fetch(request);

  readonly #installPath: string;
  readonly #callbackPath: string;

  /**
   * @param options Bolt `HTTPReceiver` options. `signingSecret` defaults to
   * `process.env.SLACK_SIGNING_SECRET`.
   * @throws {AppInitializationError} When the signing secret is missing and
   * `signatureVerification` isn't `false`, when `clientId` is set without an
   * `installationStore`, a `clientSecret` or a `stateSecret` (unless
   * `installerOptions` has a `stateStore` or turns off `stateVerification`),
   * or when `redirectUri` isn't an absolute URL without a query string or
   * fragment.
   */
  public constructor(options: VercelReceiverOptions = {}) {
    const {
      signingSecret = process.env.SLACK_SIGNING_SECRET ?? "",
      processEventErrorHandler,
      installerOptions,
      ...rest
    } = options;

    // Fail closed with a clear message: Bolt < 4.7.3 accepts an empty secret,
    // and pnpm and yarn don't enforce the peer range.
    if (rest.signatureVerification !== false && !signingSecret) {
      // An app that passes signingSecret reads it from its own env var, so
      // don't send it looking for SLACK_SIGNING_SECRET.
      throw new AppInitializationError(
        "signingSecret" in options
          ? "Missing signing secret. The signingSecret option is empty. Check that the environment variable you pass as signingSecret is set."
          : "Missing signing secret. Set the SLACK_SIGNING_SECRET environment variable or pass the signingSecret option.",
      );
    }

    // Bolt's default store keeps installations in memory, which Vercel doesn't
    // share between instances or keep across deployments.
    if (rest.clientId !== undefined && !rest.installationStore) {
      throw new AppInitializationError(
        "Missing installationStore. OAuth needs one that saves installations somewhere lasting, like a database, because Bolt's default keeps them in memory.",
      );
    }

    // Without these Bolt quietly skips OAuth, and every GET answers 404. Treat
    // an empty string, like an unset variable in a .env file, as missing too.
    if (rest.clientId !== undefined && !rest.clientSecret) {
      throw new AppInitializationError(
        "Missing clientSecret. OAuth needs it whenever clientId is set.",
      );
    }
    if (
      rest.clientId !== undefined &&
      !rest.stateSecret &&
      !installerOptions?.stateStore &&
      installerOptions?.stateVerification !== false
    ) {
      throw new AppInitializationError(
        "Missing stateSecret. OAuth needs it to sign the state parameter whenever clientId is set, unless you pass installerOptions.stateStore or set installerOptions.stateVerification to false.",
      );
    }

    // Bolt requires redirectUriPath to match the end of redirectUri, and the
    // install page can't share the callback's path.
    const callbackPath = rest.redirectUri
      ? pathOf(rest.redirectUri)
      : CALLBACK_PATH;
    const installPath = callbackPath === INSTALL_PATH ? ENDPOINT : INSTALL_PATH;

    super({
      ...rest,
      signingSecret,
      endpoints: ENDPOINT,
      installerOptions: {
        ...installerOptions,
        installPath,
        redirectUriPath: callbackPath,
      },
      // Bolt runs it after processEvent has settled, so keep it alive too.
      ...(processEventErrorHandler && {
        processEventErrorHandler: (args) =>
          keepAlive(processEventErrorHandler(args)),
      }),
    });
    this.#installPath = installPath;
    this.#callbackPath = callbackPath;

    // Bolt doesn't await the installer, and only logs its errors without
    // answering, so a failing install page or callback (a throwing
    // beforeRedirection, state store or failure callback) would hold the
    // request open until the function times out. Answer 500 instead, and
    // rethrow so Bolt still logs the error.
    const { installer } = this;
    if (installer) {
      for (const method of ["handleInstallPath", "handleCallback"] as const) {
        const handle = installer[method].bind(installer);
        installer[method] = async (req, res, ...rest) => {
          try {
            await handle(req, res, ...rest);
          } catch (error) {
            if (!res.headersSent) res.writeHead(500);
            if (!res.writableEnded) res.end();
            throw error;
          }
        };
      }
    }
  }

  /** The Bolt path that handles a request, whatever path it came in on. */
  #pathFor(method: string | undefined, params: URLSearchParams): string {
    // Bolt only serves GET with the OAuth options.
    if (method !== "GET" || !this.installer) return ENDPOINT;
    return CALLBACK_PARAMS.some((param) => params.has(param))
      ? this.#callbackPath
      : this.#installPath;
  }

  // Bolt's requestListener routes by path, but the framework has already
  // routed this request, so send it to Bolt's path whatever its own.
  #route(req: IncomingMessage, res: ServerResponse): void {
    const original = req.url;
    const { search, searchParams } = new URL(
      original ?? "/",
      "http://localhost",
    );
    req.url = this.#pathFor(req.method, searchParams) + search;

    try {
      this.requestListener(req, res);
    } catch (error) {
      // Bolt only handles POST, and GET with the OAuth options.
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
