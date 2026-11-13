import { randomBytes } from "node:crypto";
import { VercelError } from "./errors";
import { send } from "./http";
import type { Log } from "./log";
import { scrub, secret } from "./secrets";
import { wait } from "./wait";

/** An environment variable to save. */
export interface EnvVar {
  key: string;
  value: string;
  /** `plain` values can be listed, `encrypted` ones read, `sensitive` ones neither. */
  type: "plain" | "encrypted" | "sensitive";
  target: string[];
  gitBranch?: string;
  comment?: string;
}

/** An environment variable as Vercel lists it. */
export interface StoredEnv {
  id: string;
  key: string;
  type?: string;
  target: string[];
  gitBranch?: string;
  /** Its value, when it's `plain`. Otherwise absent, or not the value. */
  value?: string;
}

interface Request {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | undefined>;
  json?: unknown;
  repeatable?: boolean;
  /**
   * The request or its answer carries secrets, so an error shows Vercel's
   * error code and nothing else from the answer, which can echo them.
   */
  secret?: boolean;
}

/**
 * The variables Vercel refused, each with its error code, like
 * `SLACK_APP_ID (BAD_REQUEST)`. Never values or messages, which can echo
 * what was sent.
 */
function refused(answer: unknown): string {
  const failed = (answer as { failed?: unknown } | null)?.failed;
  if (!Array.isArray(failed)) return "";
  return failed
    .map(
      (item: {
        error?: { code?: string; key?: string; envVarKey?: string };
      }) => {
        const key = item?.error?.envVarKey ?? item?.error?.key ?? "a variable";
        return `${key} (${item?.error?.code ?? "no reason given"})`;
      },
    )
    .join(", ");
}

/**
 * Whether Vercel turned a request away because another change to the
 * project's variables was underway, like a build of another branch saving
 * its own. Nothing was changed, so the request can be sent again.
 */
function busy(status: number, answer: unknown): boolean {
  if (status !== 400 && status !== 409) return false;
  const body = answer as {
    error?: { message?: unknown };
    failed?: { error?: { message?: unknown } }[];
  } | null;
  const messages = [
    body?.error?.message,
    ...(Array.isArray(body?.failed)
      ? body.failed.map((item) => item?.error?.message)
      : []),
  ];
  return messages.some(
    (message) =>
      typeof message === "string" &&
      /ongoing update|already happening/i.test(message),
  );
}

/** How many times, and how far apart, to send a request Vercel was too busy for. */
const BUSY_ATTEMPTS = 4;
const BUSY_BACKOFF_MS = [1_000, 2_000, 4_000];

export type Vercel = ReturnType<typeof createVercel>;

/** The Vercel REST API, for one project. */
export function createVercel({
  token,
  projectId,
  teamId,
  log,
}: {
  token: string;
  projectId: string;
  teamId?: string;
  log: Log;
}) {
  const project = `/projects/${encodeURIComponent(projectId)}`;

  /**
   * @throws {VercelError} When Vercel answers with an error status.
   * @throws {Unavailable} When Vercel gives no verdict on the request.
   */
  async function request(path: string, options: Request = {}) {
    const url = new URL(`https://api.vercel.com${path}`);
    if (teamId) url.searchParams.set("teamId", teamId);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }
    const method = options.method ?? "GET";
    const repeatable = options.repeatable ?? method === "GET";

    let status: number;
    let body: unknown;
    for (let attempt = 1; ; attempt++) {
      ({ status, body } = await send(
        {
          service: "Vercel",
          method,
          url,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(options.json !== undefined && {
              "Content-Type": "application/json",
            }),
          },
          body:
            options.json === undefined
              ? undefined
              : JSON.stringify(options.json),
          repeatable,
        },
        log,
      ));
      if (!repeatable || attempt === BUSY_ATTEMPTS || !busy(status, body)) {
        break;
      }
      log.debug("  Vercel is saving another change to the variables");
      await wait(BUSY_BACKOFF_MS[attempt - 1] ?? 0);
    }
    if (status < 400) return body;

    const error = (body as { error?: { code?: unknown; message?: unknown } })
      ?.error;
    const code = typeof error?.code === "string" ? error.code : undefined;
    const message =
      !options.secret && typeof error?.message === "string"
        ? scrub(error.message)
        : undefined;
    throw new VercelError(
      status,
      code,
      [message ?? code, refused(body)].filter(Boolean).join(": ") || undefined,
    );
  }

  const client = {
    /**
     * Every environment variable of the project. Values come with `plain`
     * ones only.
     *
     * @throws When the answer isn't the whole list: what's missing from it
     * would be taken for not existing.
     */
    async listEnv(): Promise<StoredEnv[]> {
      const answer = (await request(`/v10${project}/env`)) as {
        envs?: unknown;
        pagination?: { next?: unknown };
      } | null;
      if (!Array.isArray(answer?.envs)) {
        throw new Error("Vercel's list of environment variables has no envs");
      }
      if (answer.pagination?.next != null) {
        throw new Error(
          "Vercel's list of environment variables is only its first page",
        );
      }
      return answer.envs.flatMap(
        (env: Record<string, unknown>): StoredEnv[] => {
          if (typeof env?.id !== "string" || typeof env.key !== "string") {
            return [];
          }
          const { target } = env;
          return [
            {
              id: env.id,
              key: env.key,
              type: typeof env.type === "string" ? env.type : undefined,
              target: Array.isArray(target)
                ? target.map(String)
                : typeof target === "string"
                  ? [target]
                  : [],
              gitBranch:
                typeof env.gitBranch === "string" ? env.gitBranch : undefined,
              value:
                env.type === "plain" && typeof env.value === "string"
                  ? env.value
                  : undefined,
            },
          ];
        },
      );
    },

    /** A variable's value, or `null` when Vercel won't show it, like a Sensitive one's. */
    async readEnv(id: string): Promise<string | null> {
      const answer = (await request(
        `/v1${project}/env/${encodeURIComponent(id)}`,
        { secret: true },
      )) as { type?: unknown; value?: unknown } | null;
      const value = answer?.value;
      if (answer?.type === "sensitive") return null;
      return typeof value === "string" && value !== "" ? value : null;
    },

    /**
     * Saves environment variables, replacing any with the same key, targets
     * and branch.
     *
     * @throws When Vercel saved none of them, or only some: a deployment
     * with half of an app's credentials doesn't work.
     */
    async saveEnv(envs: EnvVar[]): Promise<void> {
      if (envs.length === 0) return;
      const answer = await request(`/v10${project}/env`, {
        method: "POST",
        query: { upsert: "true" },
        json: envs,
        repeatable: true,
        secret: true,
      });
      const refusals = refused(answer);
      if (refusals) {
        throw new Error(`Vercel didn't save every variable: ${refusals}`);
      }
    },

    /**
     * Deletes variables. Ones that are already gone count as deleted.
     *
     * @throws When any of them is still there: a 404 can also mean the
     * project, not the variables, wasn't found.
     */
    async deleteEnv(ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      try {
        await request(`/v1${project}/env`, {
          method: "DELETE",
          json: { ids },
          repeatable: true,
        });
      } catch (error) {
        if (!(error instanceof VercelError && error.status === 404)) {
          throw error;
        }
        const left = new Set((await client.listEnv()).map((env) => env.id));
        if (ids.some((id) => left.has(id))) throw error;
      }
    },

    /**
     * Adds a Protection Bypass for Automation secret to the project, and
     * resolves with it.
     */
    async createBypassSecret(): Promise<string> {
      // Vercel accepts 32 letters or digits.
      const value = secret(randomBytes(16).toString("hex"));
      await request(`/v1${project}/protection-bypass`, {
        method: "PATCH",
        json: {
          generate: {
            secret: value,
            note: "Slack previews (@vercel/slack-bolt)",
          },
        },
        secret: true,
      });
      return value;
    },

    /**
     * The branches Vercel counts as active: in the Git repository, with a
     * deployment in the project.
     *
     * Cleanup deletes the Slack app of every branch that isn't in this set,
     * and Vercel doesn't document this endpoint. So the set has to be
     * complete and has to be what Vercel said: an answer without a list of
     * named branches, a page that can't be followed, or more pages than a
     * project plausibly has all throw.
     */
    async activeBranches(): Promise<Set<string>> {
      const branches = new Set<string>();
      const cursors = new Set<string>();
      let until: string | undefined;

      for (let page = 0; page < 100; page++) {
        const answer = (await request(`/v5${project}/branches`, {
          query: { active: "1", limit: "100", until },
        })) as { branches?: unknown; until?: unknown } | null;

        const list = answer?.branches;
        if (!Array.isArray(list)) {
          throw new Error("Vercel's list of active branches has no branches");
        }
        for (const item of list as { branch?: unknown }[]) {
          if (typeof item?.branch !== "string" || item.branch === "") {
            throw new Error("Vercel's list of active branches has no names");
          }
          branches.add(item.branch);
        }

        // More pages exist while the answer has an `until` cursor.
        const next = answer?.until;
        if (next == null || list.length === 0) return branches;
        until = String(next);
        if (cursors.has(until)) {
          throw new Error("Vercel's list of active branches repeats a page");
        }
        cursors.add(until);
      }
      throw new Error("Vercel's list of active branches has too many pages");
    },

    /** A deployment's metadata: what Vercel recorded, and what it was created with. */
    async deploymentMeta(id: string): Promise<Record<string, unknown>> {
      const answer = (await request(
        `/v13/deployments/${encodeURIComponent(id)}`,
      )) as { meta?: Record<string, unknown> } | null;
      return answer?.meta ?? {};
    },

    /**
     * Deploys the same source again, with the project's current variables.
     *
     * @throws When the answer doesn't name the new deployment: without it,
     * there's no telling one was started.
     */
    async redeploy(
      id: string,
      meta: Record<string, string>,
    ): Promise<{ id: string; url: string }> {
      const answer = (await request("/v13/deployments", {
        method: "POST",
        query: { forceNew: "1" },
        json: { deploymentId: id, name: projectId, project: projectId, meta },
      })) as { id?: unknown; url?: unknown } | null;
      if (typeof answer?.id !== "string" || answer.id === "") {
        throw new Error("Vercel's answer doesn't name the new deployment");
      }
      return {
        id: answer.id,
        url: typeof answer.url === "string" ? answer.url : "",
      };
    },

    async cancelDeployment(id: string): Promise<void> {
      await request(`/v12/deployments/${encodeURIComponent(id)}/cancel`, {
        method: "PATCH",
        repeatable: true,
      });
    },
  };
  return client;
}
