// Smoke tests against the real Bolt App and HTTPReceiver, with no Slack
// network calls. They check the Bolt behaviour index-v2.test.ts stubs out:
// App's constructor calls receiver.init(app), HTTPReceiver calls processEvent
// on the app it was given with `this` intact, and HTTPReceiver keeps its
// logger in the `logger` field we log through. Requests go through fetch both
// as plain Requests and from srvx's own Node server, which hands fetch the
// real Node request.
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { App, AppInitializationError, type AppOptions } from "@slack/bolt";
import { waitUntil } from "@vercel/functions";
import { toNodeHandler } from "srvx/node";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VercelReceiver, type VercelReceiverOptions } from "./index-v2";

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

const SECRET = "test-signing-secret";
const authorize = async () => ({
  botToken: "xoxb-test",
  botId: "B1",
  botUserId: "U1",
});
const mention = {
  type: "app_mention",
  user: "U2",
  text: "<@U1> hi",
  channel: "C1",
  ts: "1.1",
  event_ts: "1.1",
};

let server: Server | undefined;
/** The real Node request URL after each response, as the server sees it. */
const urlsAfter: (string | undefined)[] = [];

beforeEach(() => {
  vi.mocked(waitUntil).mockClear();
  urlsAfter.length = 0;
});

afterEach(async () => {
  server?.close();
  if (server) await once(server, "close");
  server = undefined;
});

/** A real App on a VercelReceiver, authorized without calling Slack. */
function createApp(
  options: Partial<AppOptions> = {},
  receiverOptions: VercelReceiverOptions = {},
) {
  const receiver = new VercelReceiver({
    signingSecret: SECRET,
    ...receiverOptions,
  });
  const app = new App({ receiver, authorize, ...options });
  return { receiver, app };
}

/** A Slack-signed POST to `url`. */
function signedRequest(url: string, body: string, contentType: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${signature}`,
    },
    body,
  });
}

const eventBody = (event: object) =>
  JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "Ev1",
    event_time: 1,
    event,
  });

/** Serves fetch from srvx's Node server, then sends `request` to it. */
async function viaNodeServer(receiver: VercelReceiver, request: Request) {
  const handler = toNodeHandler(receiver.fetch) as RequestListener;
  server = createServer((req, res) => {
    res.once("finish", () => urlsAfter.push(req.url));
    void handler(req, res);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const { pathname, search } = new URL(request.url);
  return fetch(
    new Request(`http://127.0.0.1:${port}${pathname}${search}`, request),
  );
}

/** POSTs a signed Events API payload to /webhooks/slack on srvx's Node server. */
function postEvent(receiver: VercelReceiver, event: object) {
  return viaNodeServer(
    receiver,
    signedRequest(
      "https://example.com/webhooks/slack",
      eventBody(event),
      "application/json",
    ),
  );
}

it("acks a real App's event and keeps its listener alive with waitUntil", async () => {
  const { receiver, app } = createApp();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tokens: unknown[] = [];
  app.event("app_mention", async ({ context }) => {
    await released;
    tokens.push(context.botToken);
  });

  const response = await postEvent(receiver, mention);

  // Slack is acknowledged while the listener is still waiting.
  expect(response.status).toBe(200);
  expect(waitUntil).toHaveBeenCalledOnce();
  expect(tokens).toEqual([]);

  // The promise kept alive settles only once the listener has finished.
  release();
  await vi.mocked(waitUntil).mock.calls[0][0];
  expect(tokens).toEqual(["xoxb-test"]);
});

it("initializes an App created with deferInitialization on its first event", async () => {
  const { receiver, app } = createApp({ deferInitialization: true });
  const tokens: unknown[] = [];
  app.event("app_mention", async ({ context }) => {
    tokens.push(context.botToken);
  });

  const response = await postEvent(receiver, mention);

  expect(response.status).toBe(200);
  await vi.mocked(waitUntil).mock.calls[0][0];
  expect(tokens).toEqual(["xoxb-test"]);
});

it("logs why a deferred App couldn't initialize", async () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    getLevel: vi.fn(),
    setName: vi.fn(),
  };
  // No token and no authorize, so Bolt's app.init() throws.
  const { receiver } = createApp(
    { deferInitialization: true, authorize: undefined },
    { logger },
  );

  const response = await postEvent(receiver, mention);

  expect(response.status).toBe(500);
  expect(logger.error).toHaveBeenCalledWith(
    "app.init() failed, so this event wasn't processed. It runs again on the next event.",
    expect.any(AppInitializationError),
  );
});

it("answers Slack's URL verification through fetch at any path", async () => {
  const { receiver } = createApp();
  const body = JSON.stringify({ type: "url_verification", challenge: "c1" });

  const response = await receiver.fetch(
    signedRequest("https://example.com/api/slack", body, "application/json"),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ challenge: "c1" });
});

it("acks a slash command through fetch before its listener finishes", async () => {
  const { receiver, app } = createApp();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  app.command("/hello", async ({ ack }) => {
    await ack("hi");
    await released;
    finished = true;
  });
  const body = new URLSearchParams({
    command: "/hello",
    text: "",
    user_id: "U2",
    team_id: "T1",
    channel_id: "C1",
    trigger_id: "t1",
    response_url: "https://example.com/response",
  }).toString();

  const response = await receiver.fetch(
    signedRequest(
      "https://example.com/api/slack",
      body,
      "application/x-www-form-urlencoded",
    ),
  );

  await expect(response.text()).resolves.toBe("hi");
  expect(finished).toBe(false);
  release();
  await vi.mocked(waitUntil).mock.calls[0][0];
  expect(finished).toBe(true);
});

it("rejects a bad signature through fetch", async () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    getLevel: vi.fn(),
    setName: vi.fn(),
  };
  const { receiver } = createApp({}, { logger });
  const request = signedRequest(
    "https://example.com/api/slack",
    eventBody(mention),
    "application/json",
  );
  request.headers.set("x-slack-signature", "v0=bad");

  const response = await receiver.fetch(request);

  expect(response.status).toBe(401);
  expect(waitUntil).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalled();
});

it("responds 404 to GET through fetch when OAuth is off", async () => {
  const { receiver } = createApp();

  const response = await receiver.fetch(
    new Request("https://example.com/api/slack"),
  );

  expect(response.status).toBe(404);
});

it("leaves the real Node request's URL as it was on srvx's Node server", async () => {
  const { receiver } = createApp();

  const response = await postEvent(receiver, mention);
  const notFound = await viaNodeServer(
    receiver,
    new Request("https://example.com/webhooks/slack?a=1"),
  );

  expect(response.status).toBe(200);
  expect(notFound.status).toBe(404);
  expect(urlsAfter).toEqual(["/webhooks/slack", "/webhooks/slack?a=1"]);
});
