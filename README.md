# @vercel/bolt

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

import { App, LogLevel } from "@slack/bolt";
import { VercelReceiver } from "@vercel/bolt";
import registerListeners from "./listeners";

const receiver = new VercelReceiver();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  receiver,
  deferInitialization: true,
});

registerListeners(app);

export { app, receiver };
```

### 3. Create API folder and events.ts route

Your project structure should look like this:

```
root/
├── api/
│   └── events.ts          # Vercel API endpoint to handle requests
├── src/
│   ├── commands/        # Slash command handlers
│   ├── events/          # Event listeners
│   └── utils/           # Helper functions
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

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:

- Check the [Slack Bolt documentation](https://slack.dev/bolt-js/)
- Review [Vercel Functions documentation](https://vercel.com/docs/functions)
- Open an issue in this repository
