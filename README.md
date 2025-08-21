# @vercel/slack-bolt

A custom [Slack Bolt](https://slack.dev/bolt-js/) receiver built for Vercel's [Fluid Compute](https://vercel.com/docs/fluid-compute).

- **Vercel Fluid Compute** Fully compabatible with Vercel Fluid Compute and [Active CPU Pricing](https://vercel.com/changelog/lower-pricing-with-active-cpu-pricing-for-fluid-compute)
- **Easy integration:** Use with your existing Bolt app code
- **Customizable:** Supports custom response handlers and property extraction
- **TypeScript ready:** Fully typed for modern development
- **Node.js Compatible:** The library is compatible with any framework or function using the Node.js Request object.

## Installation

```bash
pnpm add @vercel/slack-bolt @slack/bolt
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
import { VercelReceiver } from "@vercel/slack-bolt";

const receiver = new VercelReceiver();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver,
  deferInitialization: true,
});

app.message(/^(hi|hello|hey).*/, async ({ say }) => {
  await say("Hello, world!");
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

### 4. Create a POST request handler using `createHandler` from `@vercel/slack-bolt`

```typescript
// api/events.ts

import { createHandler } from "@vercel/slack-bolt";
import { app, receiver } from "../app";

const handler = createHandler(app, receiver);

export const POST = async (req: Request) => {
  return handler(req);
};
```

> **Note:**  
> The `handler` returned by `createHandler` works with standard Node.js `Request` objects.  
> You can use it directly in your Vercel API routes or with any framework that provides compatible request objects.

### 5. Update your Slack App Manifest

- Disable socket mode on your app
- Update your `request_url` to match your Vercel deployment
- If using features such as `commands`, `shortcuts`, and `interactivity` you must update their `urls` as well.

See the [example](./manifest.example.json) for reference.

## Local Development

This package is compatible with the Slack CLI and can be used with the `slack run` command.

### 1. Update the `start` command in your `./slack/hooks.json` file

```jsonc
// ./slack/hooks.json
{
  "hooks": {
    "get-hooks": "npx -q --no-install -p @slack/cli-hooks slack-cli-get-hooks",
    "start": "vc dev" // or the start command for your framework
  }
}
```

### 2. If you'd like to use your local `manifest.json`, update your `config.json` file. (optional)

```jsonc
{
  // ./slack/config.json
  "manifest": {
    "source": "local" // remote pulls the manifest from your Slack's remote manifest
  },
  "project_id": "<your-project-id>"
}
```

### 3. Expose your local server with `ngrok` or a similar tunneling tool

```bash
ngrok http 3000
```

### 4. Update your app manifest to use your tunnel URL

Example: https://slack-agent.ngrok.dev/api/events

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:

- Check the [Slack Bolt documentation](https://slack.dev/bolt-js/)
- Review [Vercel Functions documentation](https://vercel.com/docs/functions)
- Open an issue in this repository
