import { Hono } from "hono";
import { receiver } from "./bolt/app.js";

const app = new Hono();

app.get("/", (c) =>
  c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Slack Bolt with Hono</title>
  </head>
  <body style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: sans-serif">
    <h1>Slack Bolt with Hono</h1>
    <a href="/api/slack/events" style="color: #3b82f6">Install</a>
  </body>
</html>`),
);

// Every event, command and interaction from Slack (POST), plus the install page
// and OAuth callback (GET). Bolt verifies Slack's signature against the raw
// body, so pass the untouched request and don't add middleware that reads it.
app.all("/api/slack/events", (c) => receiver.fetch(c.req.raw));

export default app;
