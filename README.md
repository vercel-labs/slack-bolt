# @vercel/bolt

## Installation

```bash
pnpm add @vercel/bolt
```

## Quick Start

### 1. Environment Setup

Set your Slack signing secret in your environment variables:

```bash
SLACK_SIGNING_SECRET=your_slack_signing_secret_here
SLACK_BOT_TOKEN=your_slack_bot_token
```

### 2. Create API folder

Your project structure should look like this:

```
root/
├── api/
│   └── app.ts          # Vercel API endpoint with your Slack app logic
├── src/
│   ├── commands/        # Slash command handlers
│   ├── events/          # Event listeners
│   └── utils/           # Helper functions
├── package.json
└── .env                 # Environment variables
```

### 2. Create Bolt App

Add your Bolt app to the `api/app.ts` file:

```typescript
import { App } from "@slack/bolt";
import { VercelReceiver, handler } from "@vercel/bolt";

// Create the Slack app with Vercel receiver
const receiver = new VercelReceiver();

const app = new App({
  receiver,
  token: process.env.SLACK_BOT_TOKEN,
  deferInitialization: true,
});

// Add your Slack event listeners
app.message("hello", async ({ message, say }) => {
  await say(`Hey there <@${message.user}>!`);
});

// Export the handler for Vercel
export default async (req: VercelRequest, res: VercelResponse) => {
  const handler = await receiver.start();
  return handler(req, res);
};
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:

- Check the [Slack Bolt documentation](https://slack.dev/bolt-js/)
- Review [Vercel Functions documentation](https://vercel.com/docs/functions)
- Open an issue in this repository
