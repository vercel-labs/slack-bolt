import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupOrphanedApps } from "./cleanup";

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("cleanupOrphanedApps", () => {
  const defaultArgs = {
    projectId: "prj_123",
    currentBranch: "main",
    vercelApiToken: "tok_abc",
    teamId: "team_456",
    slackConfigurationToken: "xoxe.xoxp-configtoken",
  };

  it("should not treat a branch that is only present on the second page of active branches as stale", async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => ({
      branch: `branch-${i}`,
    }));

    mockFetch.mockImplementation((input: string | URL) => {
      const url = new URL(input.toString());

      if (url.pathname === "/v5/projects/prj_123/branches") {
        if (url.searchParams.get("until") === "cursor-1") {
          // Second page: contains the live branch, no further pages.
          return Promise.resolve(
            jsonResponse({ branches: [{ branch: "feature-live" }] }),
          );
        }
        return Promise.resolve(
          jsonResponse({ branches: pageOne, until: "cursor-1" }),
        );
      }

      if (url.pathname === "/v9/projects/prj_123/env") {
        return Promise.resolve(
          jsonResponse({
            envs: [
              {
                id: "env_1",
                key: "SLACK_APP_ID",
                gitBranch: "feature-live",
              },
            ],
          }),
        );
      }

      throw new Error(`Unexpected fetch call: ${url.toString()}`);
    });

    await cleanupOrphanedApps(defaultArgs);

    // Two branch pages + one env listing; no Slack app deletion, no env
    // variable deletion.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    for (const [input, init] of mockFetch.mock.calls) {
      expect(new URL(input.toString()).hostname).toBe("api.vercel.com");
      expect(init?.method ?? "GET").not.toBe("DELETE");
    }
  });

  describe("with a stale branch", () => {
    /** Every variable preview can store for a branch, plus ones to keep. */
    const envs = [
      { id: "env_app", key: "SLACK_APP_ID", gitBranch: "feature-gone" },
      { id: "env_client", key: "SLACK_CLIENT_ID", gitBranch: "feature-gone" },
      {
        id: "env_secret",
        key: "SLACK_CLIENT_SECRET",
        gitBranch: "feature-gone",
      },
      {
        id: "env_signing",
        key: "SLACK_SIGNING_SECRET",
        gitBranch: "feature-gone",
      },
      { id: "env_bot", key: "SLACK_BOT_TOKEN", gitBranch: "feature-gone" },
      {
        id: "env_app_level",
        key: "SLACK_APP_LEVEL_TOKEN",
        gitBranch: "feature-gone",
      },
      { id: "env_user", key: "SLACK_USER_TOKEN", gitBranch: "feature-gone" },
      // Not ours, on the stale branch.
      { id: "env_other", key: "DATABASE_URL", gitBranch: "feature-gone" },
      // Ours, on branches that must be left alone.
      { id: "env_live", key: "SLACK_APP_ID", gitBranch: "feature-live" },
      { id: "env_current", key: "SLACK_APP_ID", gitBranch: "main" },
      // Ours, for every branch.
      { id: "env_shared", key: "SLACK_SIGNING_SECRET" },
    ];

    /**
     * Fake APIs with one stale branch. `slack` answers the app's delete,
     * `exported` its export, and `vercel` can answer a request for one
     * variable instead of the default.
     */
    function stub({
      slack = () => jsonResponse({ ok: true }),
      exported = () => jsonResponse({ ok: true, manifest: {} }),
      vercel = () => undefined,
    }: {
      slack?: () => Response;
      exported?: () => Response;
      vercel?: (envId: string, method: string) => Response | undefined;
    } = {}) {
      mockFetch.mockImplementation(
        (input: string | URL, init?: RequestInit) => {
          const url = new URL(input.toString());
          const method = init?.method ?? "GET";
          if (url.pathname === "/v5/projects/prj_123/branches") {
            return Promise.resolve(
              jsonResponse({ branches: [{ branch: "feature-live" }] }),
            );
          }
          if (url.pathname === "/v9/projects/prj_123/env") {
            return Promise.resolve(jsonResponse({ envs }));
          }
          if (url.pathname.startsWith("/v9/projects/prj_123/env/")) {
            const envId = url.pathname.split("/").pop()!;
            const answer = vercel(envId, method);
            if (answer) return Promise.resolve(answer);
            return Promise.resolve(
              jsonResponse(
                envId === "env_app" && method === "GET"
                  ? { value: "A_STALE" }
                  : {},
              ),
            );
          }
          if (url.href === "https://slack.com/api/apps.manifest.delete") {
            return Promise.resolve(slack());
          }
          if (url.href === "https://slack.com/api/apps.manifest.export") {
            return Promise.resolve(exported());
          }
          throw new Error(`Unexpected fetch call: ${url.toString()}`);
        },
      );
    }

    const printed = () =>
      vi
        .mocked(console.log)
        .mock.calls.map((args) => args.join(" "))
        .join("\n");

    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {});
    });

    const deletedEnvIds = () =>
      mockFetch.mock.calls
        .filter(([, init]) => init?.method === "DELETE")
        .map(([input]) => new URL(input.toString()).pathname.split("/").pop());

    it("should delete the branch's Slack app with the configuration token", async () => {
      stub();

      await cleanupOrphanedApps(defaultArgs);

      const [, init] = mockFetch.mock.calls.find(([input]) =>
        input.toString().includes("apps.manifest.delete"),
      )!;
      expect(JSON.parse(init.body)).toEqual({ app_id: "A_STALE" });
      expect(init.headers.Authorization).toBe("Bearer xoxe.xoxp-configtoken");
    });

    it("should delete every Slack variable preview stored for the branch", async () => {
      stub();

      await cleanupOrphanedApps(defaultArgs);

      expect(deletedEnvIds().sort()).toEqual(
        [
          "env_app",
          "env_client",
          "env_secret",
          "env_signing",
          "env_bot",
          "env_app_level",
          "env_user",
        ].sort(),
      );
    });

    it("should delete SLACK_APP_ID last, so a cleanup that stops early finds the branch again", async () => {
      stub();

      await cleanupOrphanedApps(defaultArgs);

      expect(deletedEnvIds().at(-1)).toBe("env_app");
    });

    it("should still delete the variables when the app is already gone", async () => {
      stub({
        slack: () => jsonResponse({ ok: false, error: "app_not_found" }),
      });

      await cleanupOrphanedApps(defaultArgs);

      expect(deletedEnvIds()).toHaveLength(7);
      expect(printed()).toContain("A_STALE already deleted");
    });

    // Slack answers the delete of an app that was already deleted with
    // no_permission, and only the export says it's gone.
    it("should still delete the variables when Slack refuses the delete because the app was deleted before", async () => {
      stub({
        slack: () => jsonResponse({ ok: false, error: "no_permission" }),
        exported: () => jsonResponse({ ok: false, error: "app_not_found" }),
      });

      await cleanupOrphanedApps(defaultArgs);

      expect(deletedEnvIds()).toHaveLength(7);
      expect(printed()).toContain("A_STALE already deleted");
    });

    // SLACK_APP_ID is the only record of the app. Deleting it while the app
    // is still there leaves an app no later cleanup can find.
    it.each([
      [
        "Slack refuses to delete an app that's still there",
        () => jsonResponse({ ok: false, error: "no_permission" }),
      ],
      ["Slack is rate limiting", () => new Response(null, { status: 429 })],
      ["Slack is down", () => new Response(null, { status: 503 })],
      [
        "Slack refuses the configuration token",
        () => jsonResponse({ ok: false, error: "token_expired" }),
      ],
    ])("should keep the branch's variables when %s", async (_, slack) => {
      stub({ slack });

      await cleanupOrphanedApps(defaultArgs);

      expect(deletedEnvIds()).toEqual([]);
      expect(printed()).toContain("Failed to delete app A_STALE");
      expect(printed()).toContain("left 1 of 1 branch for the next build");
      expect(printed()).not.toContain("Orphan cleanup completed");
    });

    // Like an app created with another user's configuration token.
    it("should say what to do when Slack refuses to delete an app that's still there", async () => {
      stub({
        slack: () => jsonResponse({ ok: false, error: "no_permission" }),
      });

      await cleanupOrphanedApps(defaultArgs);

      expect(printed()).toContain(
        "Delete the app at https://api.slack.com/apps/A_STALE",
      );
    });

    it.each([
      ["Slack is down", () => new Response(null, { status: 503 })],
      [
        "Slack refuses the configuration token",
        () => jsonResponse({ ok: false, error: "token_expired" }),
      ],
    ])("should leave that out when %s, which passes", async (_, slack) => {
      stub({ slack });

      await cleanupOrphanedApps(defaultArgs);

      expect(printed()).not.toContain("Slack will refuse again");
    });

    it("should keep the branch's app and variables when its SLACK_APP_ID can't be read", async () => {
      stub({
        vercel: (envId, method) =>
          envId === "env_app" && method === "GET"
            ? new Response(null, { status: 500 })
            : undefined,
      });

      await cleanupOrphanedApps(defaultArgs);

      expect(
        mockFetch.mock.calls.filter(([input]) =>
          input.toString().includes("slack.com"),
        ),
      ).toEqual([]);
      expect(deletedEnvIds()).toEqual([]);
      expect(printed()).toContain(
        "Failed to read SLACK_APP_ID for branch feature-gone",
      );
    });

    it("should keep SLACK_APP_ID when another of the branch's variables can't be deleted", async () => {
      stub({
        vercel: (envId, method) =>
          envId === "env_bot" && method === "DELETE"
            ? new Response(null, { status: 500 })
            : undefined,
      });

      await cleanupOrphanedApps(defaultArgs);

      expect(deletedEnvIds()).not.toContain("env_app");
      // The rest still go: the app is gone, so nothing needs them.
      expect(deletedEnvIds()).toEqual(
        expect.arrayContaining(["env_client", "env_secret", "env_signing"]),
      );
      expect(printed()).toContain(
        "Failed to delete env var SLACK_BOT_TOKEN for branch feature-gone",
      );
    });

    it("should say the cleanup finished when nothing was left behind", async () => {
      stub();

      await cleanupOrphanedApps(defaultArgs);

      expect(printed()).toContain("Orphan cleanup completed");
    });
  });

  it("should abort without deleting anything when fetching active branches fails", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 500, statusText: "Internal Server Error" }),
    );

    await expect(cleanupOrphanedApps(defaultArgs)).rejects.toThrow(
      "Failed to fetch active branches",
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
