import { afterEach, describe, expect, it, vi } from "vitest";
import { recorder, rejection } from "../testing";
import { Unavailable } from "./errors";
import { type Call, send } from "./http";
import { logTo } from "./log";
import { wait } from "./wait";

vi.mock("./wait", () => ({ wait: vi.fn(() => Promise.resolve()) }));

const json = (status: number, body: unknown = {}, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const down = new TypeError("fetch failed");

/** Answers each request with the next of `answers`: a response, or an error to throw. */
function answering(...answers: (Response | Error)[]) {
  const fetch = vi.fn(async () => {
    const answer = answers.shift();
    if (!answer) throw new Error("The test has no more answers");
    if (answer instanceof Error) throw answer;
    return answer;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const call = (overrides: Partial<Call> = {}): Call => ({
  service: "Slack",
  method: "POST",
  url: "https://slack.com/api/auth.test",
  headers: { Authorization: "Bearer t" },
  repeatable: true,
  ...overrides,
});

const out = recorder();
const request = (overrides: Partial<Call> = {}) =>
  send(call(overrides), logTo(out.logger));
const waits = () => vi.mocked(wait).mock.calls.map(([ms]) => ms);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(wait).mockClear();
  out.lines.length = 0;
});

describe("an answer", () => {
  it("resolves with its status and JSON", async () => {
    const fetch = answering(json(200, { ok: true }));

    await expect(request({ body: "{}" })).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(fetch).toHaveBeenCalledWith("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: "Bearer t" },
      body: "{}",
      signal: expect.any(AbortSignal),
    });
  });

  it("has no body when it isn't JSON", async () => {
    answering(new Response("<html>", { status: 200 }));

    await expect(request()).resolves.toEqual({ status: 200, body: undefined });
  });

  it("is passed on when the request was refused, without trying again", async () => {
    const fetch = answering(json(403, { error: { code: "forbidden" } }));

    await expect(request()).resolves.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("a rate limit", () => {
  it("is waited out for as long as it asks, whatever the request", async () => {
    const fetch = answering(
      json(429, {}, { "retry-after": "7" }),
      json(200, { ok: true }),
    );

    await expect(request({ repeatable: false })).resolves.toMatchObject({
      status: 200,
    });
    expect(waits()).toEqual([7000]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("is waited out with a backoff when it doesn't say how long", async () => {
    answering(json(429), json(429), json(200));

    await request();

    expect(waits()).toEqual([500, 2000]);
  });

  it("fails the request the third time", async () => {
    answering(json(429), json(429), json(429));

    await expect(request()).rejects.toThrow("Slack is rate limiting requests");
  });

  it("fails the request at once when it asks for more than a minute", async () => {
    const fetch = answering(json(429, {}, { "retry-after": "61" }));

    await expect(request()).rejects.toBeInstanceOf(Unavailable);
    expect(waits()).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("a server error", () => {
  it("is tried again for a request that can be repeated", async () => {
    answering(json(502), json(503), json(200, { ok: true }));

    await expect(request()).resolves.toMatchObject({ status: 200 });
    expect(waits()).toEqual([500, 2000]);
  });

  it("fails the request the third time", async () => {
    answering(json(500), json(500), json(503));

    await expect(request({ service: "Vercel" })).rejects.toThrow(
      "Vercel answered 503",
    );
  });

  it("fails a request that can't be repeated at once: the work may be done", async () => {
    const fetch = answering(json(500));

    await expect(request({ repeatable: false })).rejects.toThrow(
      "Slack answered 500",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("no answer", () => {
  it("is tried again for a request that can be repeated", async () => {
    const fetch = answering(down, down, json(200));

    await expect(request()).resolves.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fails the request the third time, with what went wrong as its cause", async () => {
    answering(down, down, down);

    const error = await rejection(request());

    expect(error).toBeInstanceOf(Unavailable);
    expect(error.message).toBe("Slack couldn't be reached");
    expect(error.cause).toBe(down);
  });

  it("fails a request that can't be repeated at once", async () => {
    const fetch = answering(down);

    await expect(request({ repeatable: false })).rejects.toThrow(
      "Slack couldn't be reached",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is called a timeout when it is one", async () => {
    const timeout = Object.assign(new Error("aborted"), {
      name: "TimeoutError",
    });
    answering(timeout);

    await expect(request({ repeatable: false })).rejects.toThrow(
      "Slack didn't answer within 30 seconds",
    );
  });
});

describe("debug output", () => {
  it("shows each attempt by its label, and never a header or a body", async () => {
    answering(json(503), json(200));

    await request({ label: "auth.test", body: "secret-body" });

    expect(out.lines).toEqual([
      "? → auth.test",
      expect.stringMatching(/^\? ← auth\.test: 503 \(\d+ms\)$/),
      "? → auth.test",
      expect.stringMatching(/^\? ← auth\.test: 200 \(\d+ms\)$/),
    ]);
  });

  it("shows the method and URL of a request without a label", async () => {
    answering(down);

    await request({ method: "GET", repeatable: false }).catch(() => {});

    expect(out.lines).toEqual([
      "? → GET https://slack.com/api/auth.test",
      "? ← GET https://slack.com/api/auth.test: couldn't be reached",
    ]);
  });
});
