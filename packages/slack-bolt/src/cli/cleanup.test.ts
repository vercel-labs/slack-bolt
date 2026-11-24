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

    /** Fake APIs with one stale branch; resolves the Slack delete with `slack`. */
    function stub(slack: () => Response = () => jsonResponse({ ok: true })) {
      mockFetch.mockImplementation((input: string | URL) => {
        const url = new URL(input.toString());
        if (url.pathname === "/v5/projects/prj_123/branches") {
          return Promise.resolve(
            jsonResponse({ branches: [{ branch: "feature-live" }] }),
          );
        }
        if (url.pathname === "/v9/projects/prj_123/env") {
          return Promise.resolve(jsonResponse({ envs }));
        }
        if (url.pathname === "/v9/projects/prj_123/env/env_app") {
          return Promise.resolve(jsonResponse({ value: "A_STALE" }));
        }
        if (url.pathname.startsWith("/v9/projects/prj_123/env/")) {
          return Promise.resolve(jsonResponse({}));
        }
        if (url.href === "https://slack.com/api/apps.manifest.delete") {
          return Promise.resolve(slack());
        }
        throw new Error(`Unexpected fetch call: ${url.toString()}`);
      });
    }

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

    it("should still delete the variables when the app is already gone", async () => {
      stub(() => jsonResponse({ ok: false, error: "app_not_found" }));

      await cleanupOrphanedApps(defaultArgs);

      expect(deletedEnvIds()).toHaveLength(7);
    });

    it("should still delete the variables when Slack refuses to delete the app", async () => {
      stub(() => jsonResponse({ ok: false, error: "no_permission" }));

      await cleanupOrphanedApps(defaultArgs);

      expect(deletedEnvIds()).toHaveLength(7);
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
