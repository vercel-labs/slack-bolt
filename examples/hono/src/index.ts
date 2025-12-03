import { App } from "@slack/bolt";
import { createHandler, VercelReceiver } from "@vercel/slack-bolt";
import { Hono } from "hono";
import { receiver, app as slackApp } from "./lib/bolt/app.js";

const handler = createHandler(slackApp, receiver);

const app = new Hono();

const welcomeStrings = [
  "Hello Hono!",
  "To learn more about Hono on Vercel, visit https://vercel.com/docs/frameworks/backend/hono",
];

app.get("/", (c) => {
  return c.text(welcomeStrings.join("\n\n"));
});

app.post("/slack/events", async (c) => {
  return await handler(c.req.raw);
});

export default app;
