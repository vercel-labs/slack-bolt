import { defineHandler, html } from "nitro";

export default defineHandler(
  () =>
    html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Slack Bolt with Nitro</title>
        </head>
        <body
          style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; font-family: sans-serif"
        >
          <h1>Slack Bolt with Nitro</h1>
          <a href="/api/slack/events" style="color: #3b82f6">Install</a>
        </body>
      </html>`,
);
