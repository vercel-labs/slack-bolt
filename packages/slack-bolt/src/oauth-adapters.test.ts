import { describe, expect, it } from "vitest";
import { createResponseCapture, toIncomingMessage } from "./oauth-adapters";

describe("toIncomingMessage", () => {
  it("should extract url path and query string", () => {
    const req = new Request("https://example.com/slack/install?foo=bar");
    const msg = toIncomingMessage(req);

    expect(msg.url).toBe("/slack/install?foo=bar");
  });

  it("should extract the HTTP method", () => {
    const req = new Request("https://example.com/slack/install", {
      method: "GET",
    });
    const msg = toIncomingMessage(req);

    expect(msg.method).toBe("GET");
  });

  it("should extract host header", () => {
    const req = new Request("https://example.com/slack/install", {
      headers: { host: "example.com" },
    });
    const msg = toIncomingMessage(req);

    expect(msg.headers.host).toBe("example.com");
  });

  it("should extract cookie header", () => {
    const req = new Request("https://example.com/slack/install", {
      headers: { cookie: "slack-app-oauth-state=abc123" },
    });
    const msg = toIncomingMessage(req);

    expect(msg.headers.cookie).toBe("slack-app-oauth-state=abc123");
  });

  it("should set headers to undefined when not present", () => {
    const req = new Request("https://example.com/slack/install");
    const msg = toIncomingMessage(req);

    expect(msg.headers.host).toBeUndefined();
    expect(msg.headers.cookie).toBeUndefined();
  });
});

describe("createResponseCapture", () => {
  it("should capture writeHead status and headers", () => {
    const capture = createResponseCapture();

    capture.writeHead(302, {
      Location: "https://slack.com/oauth/v2/authorize",
    });
    capture.end("");

    const response = capture.toResponse();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
  });

  it("should capture setHeader calls", () => {
    const capture = createResponseCapture();

    capture.setHeader("Content-Type", "text/html; charset=utf-8");
    capture.writeHead(200);
    capture.end("<html>hello</html>");

    const response = capture.toResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8",
    );
  });

  it("should handle array values in setHeader (Set-Cookie)", () => {
    const capture = createResponseCapture();

    capture.setHeader("Set-Cookie", [
      "slack-app-oauth-state=abc; Path=/",
      "other-cookie=xyz; Path=/",
    ]);
    capture.writeHead(302, { Location: "https://slack.com" });
    capture.end("");

    const response = capture.toResponse();
    expect(response.headers.getSetCookie()).toEqual([
      "slack-app-oauth-state=abc; Path=/",
      "other-cookie=xyz; Path=/",
    ]);
  });

  it("should capture body from end()", async () => {
    const capture = createResponseCapture();

    capture.writeHead(200, { "Content-Type": "text/html" });
    capture.end("<html><body>Success</body></html>");

    const response = capture.toResponse();
    const body = await response.text();
    expect(body).toBe("<html><body>Success</body></html>");
  });

  it("should default to 200 with empty body", async () => {
    const capture = createResponseCapture();
    capture.end();

    const response = capture.toResponse();
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });
});
