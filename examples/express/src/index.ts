import express, { type RequestHandler } from "express";
import { toNodeHandler } from "srvx/node";
import { receiver } from "./bolt/app";

const app = express();

// One route receives every event, command and interaction from Slack, and
// serves the install page and OAuth callback. Bolt verifies Slack's signature
// against the raw request body, so keep this route before any body parser,
// like express.json(). srvx types its handler for HTTP/1 and HTTP/2 servers;
// Express is HTTP/1, hence the cast.
app.all("/api/slack/events", toNodeHandler(receiver.fetch) as RequestHandler);

app.get("/", (_req, res) => {
  res.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Slack Bolt with Express</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100vh;
        margin: 0;
        font-family: Arial, Helvetica, sans-serif;
      }
      a { color: #3b82f6; }
    </style>
  </head>
  <body>
    <h1>Slack Bolt with Express</h1>
    <a href="/api/slack/events">Install</a>
  </body>
</html>
`);
});

// Vercel serves the default export. Listen only when this file is run
// directly, like with `pnpm dev`.
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, (error) => {
    if (error) throw error;
    console.log(`Listening on http://localhost:${port}`);
  });
}

export default app;
