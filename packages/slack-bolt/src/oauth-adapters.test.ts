import { InstallProvider } from "@slack/oauth";
import { describe, expect, it } from "vitest";
import { createResponseCapture, toIncomingMessage } from "./oauth-adapters";

describe("toIncomingMessage", () => {
  it("preserves pathname and search params in msg.url", () => {
    const req = new Request(
      "https://example.com/slack/oauth_redirect?code=abc&state=xyz",
    );

    const msg = toIncomingMessage(req);

    expect(msg.url).toBe("/slack/oauth_redirect?code=abc&state=xyz");
  });

  it("preserves the HTTP method", () => {
    const req = new Request("https://example.com/install", { method: "GET" });

    const msg = toIncomingMessage(req);

    expect(msg.method).toBe("GET");
  });

  it("preserves headers including host and cookie", () => {
    const req = new Request("https://example.com/install", {
      headers: {
        Host: "example.com",
        Cookie: "slack-state=abc123",
        "X-Custom": "value",
      },
    });

    const msg = toIncomingMessage(req);

    expect(msg.headers.host).toBe("example.com");
    expect(msg.headers.cookie).toBe("slack-state=abc123");
    expect(msg.headers["x-custom"]).toBe("value");
  });

  it("lowercases header keys", () => {
    const req = new Request("https://example.com/install", {
      headers: { "Content-Type": "text/html" },
    });

    const msg = toIncomingMessage(req);

    expect(msg.headers["content-type"]).toBe("text/html");
  });
});

describe("createResponseCapture", () => {
  it("captures status code from writeHead", () => {
    const res = createResponseCapture();

    res.writeHead(302);
    res.end();

    const response = res.toResponse();
    expect(response.status).toBe(302);
  });

  it("captures body from end", async () => {
    const res = createResponseCapture();

    res.writeHead(200);
    res.end("<html>Hello</html>");

    const response = res.toResponse();
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("<html>Hello</html>");
  });

  it("defaults to 200 when writeHead is not called", () => {
    const res = createResponseCapture();

    res.end("ok");

    expect(res.toResponse().status).toBe(200);
  });

  it("returns null body when end is called without data", () => {
    const res = createResponseCapture();

    res.writeHead(302);
    res.end();

    const response = res.toResponse();
    expect(response.body).toBeNull();
  });

  it("captures headers set via setHeader", () => {
    const res = createResponseCapture();

    res.setHeader("Location", "https://slack.com/oauth/authorize?...");
    res.setHeader("Content-Type", "text/html");
    res.writeHead(302);
    res.end();

    const response = res.toResponse();
    expect(response.headers.get("location")).toBe(
      "https://slack.com/oauth/authorize?...",
    );
    expect(response.headers.get("content-type")).toBe("text/html");
  });

  it("getHeader returns values set via setHeader", () => {
    const res = createResponseCapture();

    res.setHeader("Set-Cookie", "state=abc");

    expect(res.getHeader("Set-Cookie")).toBe("state=abc");
    expect(res.getHeader("set-cookie")).toBe("state=abc");
  });

  it("handles array values in setHeader (multiple Set-Cookie)", () => {
    const res = createResponseCapture();

    res.setHeader("Set-Cookie", ["state=abc", "other=xyz"]);
    res.writeHead(302);
    res.end();

    const response = res.toResponse();
    const cookies = response.headers.getSetCookie();
    expect(cookies).toContain("state=abc");
    expect(cookies).toContain("other=xyz");
  });

  it("handles a full OAuth redirect flow", () => {
    const res = createResponseCapture();

    res.setHeader("Set-Cookie", "slack-app-oauth-state=xyz; Path=/; HttpOnly");
    res.setHeader("Location", "https://slack.com/oauth/v2/authorize?state=xyz");
    res.writeHead(302);
    res.end("");

    const response = res.toResponse();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://slack.com/oauth/v2/authorize?state=xyz",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "slack-app-oauth-state=xyz",
    );
  });

  it("handles a full install page HTML flow", async () => {
    const res = createResponseCapture();
    const html =
      '<html><body><a href="https://slack.com">Add to Slack</a></body></html>';

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.writeHead(200);
    res.end(html);

    const response = res.toResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    await expect(response.text()).resolves.toBe(html);
  });

  it("captures headers passed via writeHead args object", () => {
    const res = createResponseCapture();

    res.writeHead(302, { "X-Custom": "val", Location: "/foo" });
    res.end();

    const response = res.toResponse();
    expect(response.status).toBe(302);
    expect(response.headers.get("x-custom")).toBe("val");
    expect(response.headers.get("location")).toBe("/foo");
  });
});

describe("toIncomingMessage body piping", () => {
  it("pipes request body into the IncomingMessage stream", async () => {
    const payload = JSON.stringify({ hello: "world" });
    const req = new Request("https://example.com/callback", {
      method: "POST",
      body: payload,
      headers: { "Content-Type": "application/json" },
    });

    const msg = toIncomingMessage(req);

    const chunks: Buffer[] = [];
    const body = await new Promise<string>((resolve, reject) => {
      msg.on("data", (chunk: Buffer) => chunks.push(chunk));
      msg.on("end", () => resolve(Buffer.concat(chunks).toString()));
      msg.on("error", reject);
    });

    expect(body).toBe(payload);
  });

  it("ends the stream cleanly for bodyless GET requests", async () => {
    const req = new Request("https://example.com/install", { method: "GET" });
    const msg = toIncomingMessage(req);

    await new Promise<void>((resolve, reject) => {
      msg.on("end", () => resolve());
      msg.on("error", reject);
      msg.resume();
    });
  });
});

describe("InstallProvider integration", () => {
  it("handleInstallPath produces a 302 redirect to Slack via adapters", async () => {
    const installer = new InstallProvider({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      stateVerification: false,
      directInstall: true,
    });

    const req = new Request("https://example.com/slack/install", {
      method: "GET",
      headers: { Host: "example.com" },
    });

    const nodeReq = toIncomingMessage(req);
    const capture = createResponseCapture();

    await installer.handleInstallPath(
      nodeReq,
      capture,
      {},
      {
        scopes: ["chat:write"],
        redirectUri: "https://example.com/slack/oauth_redirect",
      },
    );

    const response = capture.toResponse();

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBeTruthy();
    expect(location).toContain("https://slack.com/oauth/v2/authorize");
    expect(location).toContain("client_id=test-client-id");
    expect(location).toContain("scope=chat%3Awrite");
  });
});
