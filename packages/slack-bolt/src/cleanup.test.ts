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
