# @vercel/bolt

## Description

A Vercel-compatible [Slack Bolt](https://slack.dev/bolt-js/) receiver for building Slack apps on Vercel’s serverless platform.

This package provides a drop-in replacement for the default Bolt receiver, allowing you to deploy your Bolt Javascript app to Vercel

- **Easy integration:** Use with your existing Bolt app code.
- **Customizable:** Supports custom response handlers and property extraction.
- **TypeScript ready:** Fully typed for modern development.

See below for installation and usage instructions.

## Installation

```bash
pnpm add @vercel/bolt
```

## Quick Start

### 1. Environment Setup

Add your `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` to your environment variables:

```bash
SLACK_SIGNING_SECRET=your_slack_signing_secret_here
SLACK_BOT_TOKEN=your_slack_bot_token
```

### 2. Add the Vercel Receiver to your Bolt app

```typescript
// app.ts

import { App } from "@slack/bolt";
import { VercelReceiver } from "@vercel/bolt";

const receiver = new VercelReceiver();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver,
  deferInitialization: true,
});

app.message(/^(hi|hello|hey).*/, async ({ say }) => {
  await say("Hello!");
});

export { app, receiver };
```

### 3. Create an API folder and events.ts route

Your project structure should look like this:

```
root/
├── api/
│   └── events.ts        # Vercel API endpoint to handle requests
├── app.ts               # Bolt app
├── package.json
└── .env                 # Environment variables
```

### 4. Create a POST request handler using `createHandler` from `@vercel/bolt`

```typescript
// api/events.ts

import { createHandler } from "@vercel/bolt";
import { app, receiver } from "../app";

export const POST = createHandler(app, receiver);
```

### 5. Update your Slack App Manifest

- Disable socket mode on your app
- Update your `request_url` to match your Vercel deployment
- If using features such as `commands`, `shortcuts`, and `interactivity` you must update their `urls` as well.

See the [example](./manifest.example.json) for reference.

## Local Development

This package is compatible with the Slack CLI and can be used with the `slack run` command.

### 1. Ensure your app and manifest are not using `socket mode`.

### 2. Update the `start` command in you `./slack/hooks.json` file

```json
// ./slack/hooks.json
{
  "hooks": {
    "get-hooks": "npx -q --no-install -p @slack/cli-hooks slack-cli-get-hooks",
    "start": "vc dev"
  }
}
```

### 3. If you'd like to use your local `manifest.json`, update your `config.json` file. (optional)

```json
{
  // ./slack/config.json
  "manifest": {
    "source": "local" // remote pulls the manifest from your Slack's remote manifest
  },
  "project_id": "<your-project-id>"
}
```

### 4. Expose your local server with `ngrok` or a similar tunneling tool

```bash
ngrok http 3000
```

### 5. Update your app manifest to use your tunnel URL

Example: https://slack-agent.ngrok.dev/api/events

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:

- Check the [Slack Bolt documentation](https://slack.dev/bolt-js/)
- Review [Vercel Functions documentation](https://vercel.com/docs/functions)
- Open an issue in this repository
