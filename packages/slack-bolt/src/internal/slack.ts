import { isAppMissing, SlackError, Unavailable } from "./errors";
import { send } from "./http";
import type { Log } from "./log";
import type { Manifest } from "./manifest";
import { secret } from "./secrets";

interface Request {
  token?: string;
  /** Sent as JSON. Without it or `form`, the request has no body. */
  json?: unknown;
  form?: Record<string, string>;
  repeatable: boolean;
}

/** An app as Slack describes it when it's created, and only then. */
export interface CreatedApp {
  id: string;
  clientId?: string;
  clientSecret?: string;
  signingSecret?: string;
  /** Slack's link for installing the app. */
  installUrl?: string;
}

/** The tokens an installation comes with. */
export interface AppTokens {
  bot?: string;
  appLevel?: string;
  user?: string;
}

export type Slack = ReturnType<typeof createSlack>;

/** The Slack Web API methods this package uses. */
export function createSlack(log: Log) {
  /**
   * @throws {SlackError} When Slack answers `ok: false`.
   * @throws {Unavailable} When Slack gives no verdict on the call.
   */
  async function call<T extends object>(
    method: string,
    request: Request,
  ): Promise<T> {
    const { status, body } = await send(
      {
        service: "Slack",
        method: "POST",
        url: `https://slack.com/api/${method}`,
        label: method,
        headers: {
          ...(request.token && { Authorization: `Bearer ${request.token}` }),
          "Content-Type": request.form
            ? "application/x-www-form-urlencoded"
            : "application/json; charset=utf-8",
        },
        body: request.form
          ? new URLSearchParams(request.form)
          : request.json === undefined
            ? undefined
            : JSON.stringify(request.json),
        repeatable: request.repeatable,
      },
      log,
    );

    if (typeof body !== "object" || body === null) {
      // A proxy's or a maintenance page, which says nothing about the call.
      throw new Unavailable(
        "Slack",
        `answered ${method} with ${status} and no JSON`,
      );
    }
    const answer = body as { ok?: unknown; error?: unknown; errors?: unknown };
    if (answer.ok === true) return body as T;

    const code =
      typeof answer.error === "string" ? answer.error : "unknown_error";
    log.debug(`  ${method}: ${code}`);
    throw new SlackError(
      method,
      code,
      Array.isArray(answer.errors) ? answer.errors : [],
    );
  }

  return {
    /** Resolves when Slack accepts the token. */
    async authTest(token: string): Promise<void> {
      await call("auth.test", { token, repeatable: true });
    },

    async createApp(token: string, manifest: Manifest): Promise<CreatedApp> {
      const method = "apps.manifest.create";
      const answer = await call<{
        app_id?: unknown;
        credentials?: {
          client_id?: string;
          client_secret?: string;
          signing_secret?: string;
          verification_token?: string;
        };
        oauth_authorize_url?: string;
      }>(method, {
        token,
        json: { manifest: JSON.stringify(manifest) },
        repeatable: false,
      });
      if (typeof answer.app_id !== "string" || answer.app_id === "") {
        throw new SlackError(method, "no_app_id_in_answer");
      }
      const credentials = answer.credentials ?? {};
      secret(credentials.verification_token);
      return {
        id: answer.app_id,
        clientId: credentials.client_id,
        clientSecret: secret(credentials.client_secret),
        signingSecret: secret(credentials.signing_secret),
        installUrl: answer.oauth_authorize_url,
      };
    },

    async updateApp(
      token: string,
      appId: string,
      manifest: Manifest,
    ): Promise<void> {
      await call("apps.manifest.update", {
        token,
        json: { app_id: appId, manifest: JSON.stringify(manifest) },
        repeatable: true,
      });
    },

    async deleteApp(token: string, appId: string): Promise<void> {
      await call("apps.manifest.delete", {
        token,
        json: { app_id: appId },
        repeatable: true,
      });
    },

    /**
     * Whether Slack still has the app. Any answer other than "it exists" or
     * "it doesn't" throws.
     */
    async appExists(token: string, appId: string): Promise<boolean> {
      try {
        await call("apps.manifest.export", {
          token,
          json: { app_id: appId },
          repeatable: true,
        });
        return true;
      } catch (error) {
        if (isAppMissing(error)) return false;
        throw error;
      }
    },

    /** Trades a refresh token for a new configuration token and refresh token. */
    async rotate(
      refreshToken: string,
    ): Promise<{ token: string; refreshToken: string }> {
      const method = "tooling.tokens.rotate";
      const answer = await call<{ token?: string; refresh_token?: string }>(
        method,
        {
          form: { refresh_token: refreshToken },
          // Slack doesn't accept a refresh token it has already traded in.
          repeatable: false,
        },
      );
      if (!answer.token || !answer.refresh_token) {
        throw new SlackError(method, "no_tokens_in_answer");
      }
      return {
        token: secret(answer.token),
        refreshToken: secret(answer.refresh_token),
      };
    },

    /** Installs the app in the service token's workspace. */
    async install(
      serviceToken: string,
      appId: string,
      botScopes: string[],
    ): Promise<AppTokens> {
      const answer = await call<{
        api_access_tokens?: { bot?: string; app_level?: string; user?: string };
      }>("apps.developerInstall", {
        token: serviceToken,
        json: { app_id: appId, bot_scopes: botScopes, outgoing_domains: [] },
        repeatable: true,
      });
      const tokens = answer.api_access_tokens ?? {};
      return {
        bot: secret(tokens.bot),
        appLevel: secret(tokens.app_level),
        user: secret(tokens.user),
      };
    },
  };
}
