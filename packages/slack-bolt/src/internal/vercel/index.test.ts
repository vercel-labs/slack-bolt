import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPError } from "./errors";
import {
  addEnvironmentVariables,
  getAuthUser,
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
    expect(url).toBe(
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

  it("should send a body with generate.secret (64-char hex) and the expected note", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    await updateProtectionBypass(defaultArgs);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.generate.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.generate.note).toBe("Created by @vercel/slack-bolt");
  });

  it("should return the same secret that was sent in the request body", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    const secret = await updateProtectionBypass(defaultArgs);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(secret).toBe(body.generate.secret);
  });

  it("includes literal 'teamId=undefined' in URL when teamId is omitted (unlike addEnvironmentVariables which omits it)", async () => {
    mockFetch.mockResolvedValueOnce(okResponse());

    await updateProtectionBypass({ projectId: "prj_123", token: "tok_abc" });

    // Documents current behavior: template-literal interpolation produces
    // "?teamId=undefined" rather than omitting the parameter entirely.
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("?teamId=undefined");
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

describe("getAuthUser", () => {
  const defaultArgs = { token: "tok_abc" };

  const userPayload = {
    user: {
      id: "user_123",
      email: "test@example.com",
      name: "Test User",
      username: "testuser",
      avatar: "abc123hash",
      defaultTeamId: "team_456",
    },
  };

  it("should send a GET to the /v2/user endpoint", async () => {
    mockFetch.mockResolvedValueOnce(okResponse(userPayload));

    await getAuthUser(defaultArgs);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.vercel.com/v2/user");
    expect(opts.method).toBe("GET");
  });

  it("should set the Authorization bearer header", async () => {
    mockFetch.mockResolvedValueOnce(okResponse(userPayload));

    await getAuthUser(defaultArgs);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer tok_abc");
  });

  it("should not send a request body", async () => {
    mockFetch.mockResolvedValueOnce(okResponse(userPayload));

    await getAuthUser(defaultArgs);

    expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
  });

  it("should return the parsed JSON response on success", async () => {
    mockFetch.mockResolvedValueOnce(okResponse(userPayload));

    const result = await getAuthUser(defaultArgs);

    expect(result).toEqual(userPayload);
  });

  it("should throw HTTPError with status and statusText on 401", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(401, "Unauthorized"));

    const err = await getAuthUser(defaultArgs).catch((e) => e);

    expect(err).toBeInstanceOf(HTTPError);
    expect(err.status).toBe(401);
    expect(err.statusText).toBe("Unauthorized");
    expect(err.message).toBe(
      "Failed to get authenticated user: 401 Unauthorized",
    );
  });

  it("should throw HTTPError with status and statusText on 403", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(403, "Forbidden"));

    const err = await getAuthUser(defaultArgs).catch((e) => e);

    expect(err).toBeInstanceOf(HTTPError);
    expect(err.status).toBe(403);
    expect(err.statusText).toBe("Forbidden");
  });

  it("should include response body in error message when present", async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse(401, "Unauthorized", {
        error: { code: "forbidden", message: "Invalid token" },
      }),
    );

    const err = await getAuthUser(defaultArgs).catch((e) => e);

    expect(err).toBeInstanceOf(HTTPError);
    expect(err.message).toBe(
      'Failed to get authenticated user: 401 Unauthorized - {"error":{"code":"forbidden","message":"Invalid token"}}',
    );
  });

  it("should propagate network errors from fetch", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(getAuthUser(defaultArgs)).rejects.toThrow(TypeError);
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
