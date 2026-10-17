import {
  type App,
  AppInitializationError,
  HTTPReceiver,
  type HTTPReceiverOptions,
} from "@slack/bolt";
import { waitUntil } from "@vercel/functions";

/**
 * Options for {@link VercelReceiver}. Accepts every Bolt `HTTPReceiver`
 * option. Credentials default to their `SLACK_*` environment variables.
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
  signingSecret?: string;
  /**
   * Your app's client ID. Setting it enables OAuth.
   * @default process.env.SLACK_CLIENT_ID
   */
  clientId?: HTTPReceiverOptions["clientId"];
  /**
   * Your app's client secret. Setting it enables OAuth.
   * @default process.env.SLACK_CLIENT_SECRET
   */
  clientSecret?: HTTPReceiverOptions["clientSecret"];
  /**
   * Signs the OAuth state parameter. Required for OAuth unless
   * `installerOptions.stateStore` is set or `installerOptions.stateVerification`
   * is `false`.
   * @default process.env.SLACK_STATE_SECRET
   */
  stateSecret?: HTTPReceiverOptions["stateSecret"];
}

const OAUTH_SETTINGS = [
  { env: "SLACK_CLIENT_ID", option: "clientId" },
  { env: "SLACK_CLIENT_SECRET", option: "clientSecret" },
  { env: "SLACK_STATE_SECRET", option: "stateSecret" },
] as const;

const list = (items: string[]) =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(items);

/**
 * A Bolt receiver for Vercel Functions.
 *
 * Extends Bolt's `HTTPReceiver` and keeps each event's listeners running with
 * `waitUntil` after Slack has been acknowledged.
 *
 * @example
 * ```ts
 * import { App } from "@slack/bolt";
 * import { VercelReceiver } from "@vercel/slack-bolt";
 *
 * const receiver = new VercelReceiver();
 * const app = new App({ receiver, token: process.env.SLACK_BOT_TOKEN });
 * ```
 *
 * @throws {AppInitializationError} When the signing secret is missing, or
 * OAuth is partly configured.
 */
export class VercelReceiver extends HTTPReceiver {
  public constructor({
    signingSecret = process.env.SLACK_SIGNING_SECRET ?? "",
    clientId = process.env.SLACK_CLIENT_ID,
    clientSecret = process.env.SLACK_CLIENT_SECRET,
    stateSecret = process.env.SLACK_STATE_SECRET,
    ...options
  }: VercelReceiverOptions = {}) {
    // Bolt only rejects a missing secret from 4.7.3 on; older versions fail open.
    if (options.signatureVerification !== false && !signingSecret) {
      throw new AppInitializationError(
        "Missing signing secret. Set the SLACK_SIGNING_SECRET environment variable or pass the signingSecret option.",
      );
    }

    // Bolt silently skips OAuth when any credential is missing.
    if (clientId || clientSecret) {
      const { stateStore, stateVerification } = options.installerOptions ?? {};
      const present = {
        clientId,
        clientSecret,
        stateSecret: stateSecret || stateStore || stateVerification === false,
      };
      const missing = OAUTH_SETTINGS.filter(({ option }) => !present[option]);
      if (missing.length > 0) {
        const plural = missing.length > 1 ? "s" : "";
        throw new AppInitializationError(
          `Missing OAuth settings. Set the ${list(missing.map((m) => m.env))} environment variable${plural} or pass the ${list(missing.map((m) => m.option))} option${plural}.`,
        );
      }
      if (!options.installationStore) {
        (options.logger ?? console).warn(
          "OAuth is enabled without an installationStore. Installations are kept in memory and lost when the function restarts. Pass the installationStore option.",
        );
      }
    }

    // Bolt requires redirectUriPath whenever redirectUri is set, and the two
    // must agree, so default it to the URL's path.
    let { installerOptions } = options;
    if (
      options.redirectUri &&
      !installerOptions?.redirectUriPath &&
      URL.canParse(options.redirectUri)
    ) {
      installerOptions = {
        ...installerOptions,
        redirectUriPath: new URL(options.redirectUri).pathname,
      };
    }

    super({
      ...options,
      installerOptions,
      signingSecret,
      clientId,
      clientSecret,
      stateSecret,
    });
  }

  /**
   * Called by Bolt when the `App` is created. Registers each event's
   * processing with `waitUntil` so listeners finish after the response.
   */
  public override init(app: App): void {
    const processEvent: App["processEvent"] = (event) => {
      const processing = app.processEvent(event);
      waitUntil(Promise.resolve(processing).catch(() => {}));
      return processing;
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
