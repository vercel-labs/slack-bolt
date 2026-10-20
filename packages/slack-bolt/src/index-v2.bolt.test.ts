// Smoke tests against the real Bolt App and HTTPReceiver, with no Slack
// network calls. They check the Bolt behaviour index-v2.test.ts stubs out:
// App's constructor calls receiver.init(app), HTTPReceiver calls processEvent
// on the app it was given with `this` intact, and HTTPReceiver keeps its
// logger in the `logger` field we log through.
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { App, AppInitializationError, type AppOptions } from "@slack/bolt";
import { waitUntil } from "@vercel/functions";
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

beforeEach(() => {
  vi.mocked(waitUntil).mockClear();
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

/** POSTs a signed Events API payload to the receiver. */
async function postEvent(receiver: VercelReceiver, event: object) {
  server = createServer(receiver.requestListener).listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const body = JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "Ev1",
    event_time: 1,
    event,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return fetch(`http://127.0.0.1:${port}/slack/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${signature}`,
    },
    body,
  });
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
