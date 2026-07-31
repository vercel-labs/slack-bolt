import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPError } from "./errors";
import {
  addEnvironmentVariables,
  getActiveBranches,
  getProject,
  updateProtectionBypass,
} from "./index";

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function okResponse(body: unknown = {}) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function errorResponse(status: number, statusText: string, body?: unknown) {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    statusText,
  });
}

describe("updateProtectionBypass", () => {
  const defaultArgs = {
    projectId: "prj_123",
    token: "tok_abc",
    teamId: "team_456",
  };

  it("should send a PATCH to the correct URL with projectId and teamId", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    await updateProtectionBypass(defaultArgs);

    const [url] = mockFetch.mock.calls[0];
    expect(url.toString()).toBe(
      "https://api.vercel.com/v1/projects/prj_123/protection-bypass?teamId=team_456",
    );
    expect(mockFetch.mock.calls[0][1].method).toBe("PATCH");
  });

  it("should set the Authorization bearer header", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    await updateProtectionBypass(defaultArgs);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer tok_abc");
  });

  it("should send a body with generate.secret (32-char hex) and the expected note", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    await updateProtectionBypass(defaultArgs);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.generate.secret).toMatch(/^[0-9a-f]{32}$/);
    expect(body.generate.note).toBe("Created by @vercel/slack-bolt");
  });

  it("should return the same secret that was sent in the request body", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    const secret = await updateProtectionBypass(defaultArgs);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(secret).toBe(body.generate.secret);
  });

  it("should omit teamId query param when teamId is not provided", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    await updateProtectionBypass({ projectId: "prj_123", token: "tok_abc" });

    const [url] = mockFetch.mock.calls[0];
    expect(url.toString()).toBe(
      "https://api.vercel.com/v1/projects/prj_123/protection-bypass",
    );
  });

  it("should set Content-Type to application/json", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    await updateProtectionBypass(defaultArgs);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("should generate a unique secret on every call", async () => {
    mockFetch.mockResolvedValue(okResponse());

    const s1 = await updateProtectionBypass(defaultArgs);
    const s2 = await updateProtectionBypass(defaultArgs);

    expect(s1).not.toBe(s2);
  });

  it("should generate a secret that meets Vercel API requirements (exactly 32 characters, no special characters)", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    const secret = await updateProtectionBypass(defaultArgs);

    expect(secret).toHaveLength(32);
    expect(secret).toMatch(/^[0-9a-f]+$/);
    expect(secret).not.toMatch(/[^0-9a-f]/);
  });

  it("should throw HTTPError with status and statusText on failure", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(403, "Forbidden"));

    const err = await updateProtectionBypass(defaultArgs).catch((e) => e);

    expect(err).toBeInstanceOf(HTTPError);
    expect(err.status).toBe(403);
    expect(err.statusText).toBe("Forbidden");
    expect(err.message).toBe(
      "Failed to update protection bypass: 403 Forbidden",
    );
  });

  it("should include response body in error message when present", async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(403, "Forbidden", {
        error: { code: "forbidden", message: "Not allowed" },
      }),
    );

    const err = await updateProtectionBypass(defaultArgs).catch((e) => e);

    expect(err).toBeInstanceOf(HTTPError);
    expect(err.message).toBe(
      'Failed to update protection bypass: 403 Forbidden - {"error":{"code":"forbidden","message":"Not allowed"}}',
    );
    expect(err.body).toBe(
      '{"error":{"code":"forbidden","message":"Not allowed"}}',
    );
  });

  it("should propagate network errors from fetch", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(updateProtectionBypass(defaultArgs)).rejects.toThrow(
      TypeError,
    );
  });
});

describe("getProject", () => {
  const defaultArgs = {
    projectId: "prj_123",
    token: "tok_abc",
    teamId: "team_456",
  };

  it("should send a GET to the /v9/projects endpoint with projectId and teamId", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    await getProject(defaultArgs);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url.toString()).toBe(
      "https://api.vercel.com/v9/projects/prj_123?teamId=team_456",
    );
    expect(opts.method).toBe("GET");
  });

  it("should omit teamId query param when not provided", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    await getProject({ projectId: "prj_123", token: "tok_abc" });

    const [url] = mockFetch.mock.calls[0];
    expect(url.toString()).toBe("https://api.vercel.com/v9/projects/prj_123");
  });

  it("should set the Authorization bearer header", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    await getProject(defaultArgs);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer tok_abc");
  });

  it("should not send a request body", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    await getProject(defaultArgs);

    expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
  });

  it("should resolve on success", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    await expect(getProject(defaultArgs)).resolves.toBeUndefined();
  });

  it("should throw HTTPError on 401", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(401, "Unauthorized"));

    const err = await getProject(defaultArgs).catch((e) => e);

    expect(err).toBeInstanceOf(HTTPError);
    expect(err.status).toBe(401);
    expect(err.message).toBe(
      "Failed to access Vercel project: 401 Unauthorized",
    );
  });

  it("should throw HTTPError on 403", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(403, "Forbidden"));

    const err = await getProject(defaultArgs).catch((e) => e);

    expect(err).toBeInstanceOf(HTTPError);
    expect(err.status).toBe(403);
    expect(err.statusText).toBe("Forbidden");
  });

  it("should include response body in error message when present", async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(403, "Forbidden", {
        error: { code: "forbidden", message: "Not authorized" },
      }),
    );

    const err = await getProject(defaultArgs).catch((e) => e);

    expect(err).toBeInstanceOf(HTTPError);
    expect(err.message).toBe(
      'Failed to access Vercel project: 403 Forbidden - {"error":{"code":"forbidden","message":"Not authorized"}}',
    );
  });

  it("should propagate network errors from fetch", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(getProject(defaultArgs)).rejects.toThrow(TypeError);
  });
});

describe("getActiveBranches", () => {
  const defaultArgs = {
    projectId: "prj_123",
    token: "tok_abc",
    teamId: "team_456",
  };

  function branchPage(names: string[], until?: string) {
    return okResponse({
      branches: names.map((branch) => ({ branch })),
      ...(until !== undefined ? { until } : {}),
    });
  }

  it("should send a GET with active=1, limit=100, teamId, and the bearer header", async () => {
    mockFetch.mockResolvedValueOnce(branchPage(["main"]));

    await getActiveBranches(defaultArgs);

    const [rawUrl, opts] = mockFetch.mock.calls[0];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe("/v5/projects/prj_123/branches");
    expect(url.searchParams.get("active")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("teamId")).toBe("team_456");
    expect(url.searchParams.has("until")).toBe(false);
    expect(opts.headers.Authorization).toBe("Bearer tok_abc");
  });

  it("should return all branches from a single page and make only one request", async () => {
    mockFetch.mockResolvedValueOnce(branchPage(["main", "feature-a"]));

    const branches = await getActiveBranches(defaultArgs);

    expect(branches).toEqual(new Set(["main", "feature-a"]));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should paginate through all pages and include branches from every page", async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => `branch-${i}`);
    mockFetch
      .mockResolvedValueOnce(branchPage(pageOne, "cursor-1"))
      .mockResolvedValueOnce(branchPage(["branch-100", "branch-101"]));

    const branches = await getActiveBranches(defaultArgs);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(branches.size).toBe(102);
    expect(branches.has("branch-0")).toBe(true);
    expect(branches.has("branch-99")).toBe(true);
    expect(branches.has("branch-100")).toBe(true);
    expect(branches.has("branch-101")).toBe(true);
  });

  it("should pass the pagination cursor as the until query param on the next request", async () => {
    mockFetch
      .mockResolvedValueOnce(branchPage(["a"], "cursor-1"))
      .mockResolvedValueOnce(branchPage(["b"]));

    await getActiveBranches(defaultArgs);

    const firstUrl = new URL(mockFetch.mock.calls[0][0]);
    const secondUrl = new URL(mockFetch.mock.calls[1][0]);
    expect(firstUrl.searchParams.has("until")).toBe(false);
    expect(secondUrl.searchParams.get("until")).toBe("cursor-1");
    expect(secondUrl.searchParams.get("active")).toBe("1");
    expect(secondUrl.searchParams.get("teamId")).toBe("team_456");
  });

  it("should support numeric until cursors", async () => {
    mockFetch
      .mockResolvedValueOnce(
        okResponse({ branches: [{ branch: "a" }], until: 1609499532000 }),
      )
      .mockResolvedValueOnce(branchPage(["b"]));

    const branches = await getActiveBranches(defaultArgs);

    const secondUrl = new URL(mockFetch.mock.calls[1][0]);
    expect(secondUrl.searchParams.get("until")).toBe("1609499532000");
    expect(branches).toEqual(new Set(["a", "b"]));
  });

  it("should stop when a page returns no branches even if a cursor is present", async () => {
    mockFetch
      .mockResolvedValueOnce(branchPage(["a"], "cursor-1"))
      .mockResolvedValueOnce(branchPage([], "cursor-2"));

    const branches = await getActiveBranches(defaultArgs);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(branches).toEqual(new Set(["a"]));
  });

  it("should throw when the pagination cursor repeats instead of looping or returning a partial set", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(branchPage(["a"], "cursor-1")),
    );

    await expect(getActiveBranches(defaultArgs)).rejects.toThrow(
      /pagination cursor repeated/,
    );
  });

  it("should throw instead of returning a partial set when exceeding the max page bound", async () => {
    let page = 0;
    mockFetch.mockImplementation(() => {
      page++;
      return Promise.resolve(branchPage([`branch-${page}`], `cursor-${page}`));
    });

    await expect(getActiveBranches(defaultArgs)).rejects.toThrow(
      /exceeded 100 pages/,
    );
  });

  it("should omit teamId query param when not provided", async () => {
    mockFetch.mockResolvedValueOnce(branchPage(["main"]));

    await getActiveBranches({ projectId: "prj_123", token: "tok_abc" });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.has("teamId")).toBe(false);
  });

  it("should throw HTTPError when any page request fails", async () => {
    mockFetch
      .mockResolvedValueOnce(branchPage(["a"], "cursor-1"))
      .mockResolvedValueOnce(errorResponse(500, "Internal Server Error"));

    const err = await getActiveBranches(defaultArgs).catch((e) => e);

    expect(err).toBeInstanceOf(HTTPError);
    expect(err.status).toBe(500);
    expect(err.message).toBe(
      "Failed to fetch active branches: 500 Internal Server Error",
    );
  });
});

describe("addEnvironmentVariables", () => {
  const envs = [
    {
      key: "FOO",
      value: "bar",
      type: "plain" as const,
      target: ["production" as const],
    },
  ];

  const defaultArgs = {
    projectId: "prj_123",
    token: "tok_abc",
    teamId: "team_456",
    envs,
  };

  it("should send a POST with the Authorization bearer header", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ created: [], failed: [] }));

    await addEnvironmentVariables(defaultArgs);

    const { method, headers } = mockFetch.mock.calls[0][1];
    expect(method).toBe("POST");
    expect(headers.Authorization).toBe("Bearer tok_abc");
  });

  it("should POST to a well-formed URL even when projectId contains special characters", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ created: [], failed: [] }));

    await addEnvironmentVariables({
      ...defaultArgs,
      projectId: "prj/with spaces&special=chars",
    });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe(
      "/v10/projects/prj%2Fwith%20spaces%26special%3Dchars/env",
    );
  });

  it("should include teamId query param when provided", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ created: [], failed: [] }));

    await addEnvironmentVariables(defaultArgs);

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get("teamId")).toBe("team_456");
  });

  it("should omit teamId query param when not provided", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ created: [], failed: [] }));

    await addEnvironmentVariables({
      projectId: "prj_123",
      token: "tok_abc",
      envs,
    });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.has("teamId")).toBe(false);
  });

  it("should treat empty-string teamId the same as omitted", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ created: [], failed: [] }));

    await addEnvironmentVariables({ ...defaultArgs, teamId: "" });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.has("teamId")).toBe(false);
  });

  it("should include upsert=true by default", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ created: [], failed: [] }));

    await addEnvironmentVariables(defaultArgs);

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get("upsert")).toBe("true");
  });

  it("should omit upsert when explicitly set to false", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ created: [], failed: [] }));

    await addEnvironmentVariables({ ...defaultArgs, upsert: false });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.has("upsert")).toBe(false);
  });

  it("should send envs as the JSON request body", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ created: [], failed: [] }));

    await addEnvironmentVariables(defaultArgs);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual(envs);
  });

  it("should return the parsed JSON response on success", async () => {
    const payload = {
      created: [{ key: "FOO", value: "bar" }],
      failed: [],
    };
    mockFetch.mockResolvedValueOnce(okResponse(payload));

    const result = await addEnvironmentVariables(defaultArgs);

    expect(result).toEqual(payload);
  });

  it("should set Content-Type to application/json", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ created: [], failed: [] }));

    await addEnvironmentVariables(defaultArgs);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("should send multiple env entries when provided as an array", async () => {
    const multipleEnvs = [
      {
        key: "FOO",
        value: "bar",
        type: "plain" as const,
        target: ["production" as const],
      },
      {
        key: "BAZ",
        value: "qux",
        type: "plain" as const,
        target: ["preview" as const],
      },
    ];
    mockFetch.mockResolvedValueOnce(
      okResponse({ created: multipleEnvs, failed: [] }),
    );

    await addEnvironmentVariables({ ...defaultArgs, envs: multipleEnvs });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toHaveLength(2);
    expect(body[0].key).toBe("FOO");
    expect(body[1].key).toBe("BAZ");
  });

  it("should throw HTTPError with status and statusText on failure", async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(500, "Internal Server Error"),
    );

    const err = await addEnvironmentVariables(defaultArgs).catch((e) => e);

    expect(err).toBeInstanceOf(HTTPError);
    expect(err.status).toBe(500);
    expect(err.statusText).toBe("Internal Server Error");
    expect(err.message).toBe(
      "Failed to create environment variables: 500 Internal Server Error",
    );
  });

  it("should propagate network errors from fetch", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(addEnvironmentVariables(defaultArgs)).rejects.toThrow(
      TypeError,
    );
  });
});
