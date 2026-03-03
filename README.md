# @vercel/slack-bolt

A custom [Slack Bolt](https://slack.dev/bolt-js/) receiver built for Vercel's [Fluid Compute](https://vercel.com/docs/fluid-compute), with automatic Slack app provisioning for preview deployments.

## Getting Started

Visit our [template](https://vercel.com/templates/backend/slack-bolt-with-nitro) to get started building a Slack app.

## Installation

```bash
npm install @vercel/slack-bolt
# or
yarn add @vercel/slack-bolt
# or
pnpm add @vercel/slack-bolt
# or
bun add @vercel/slack-bolt
```

## Preview Deployments

`@vercel/slack-bolt` can automatically create and manage a dedicated Slack app for each preview branch. On every preview build it will:

1. Create a new Slack app (or update the existing one) from your `manifest.json`
2. Rewrite manifest URLs to point to the preview deployment
3. Store the app credentials (`SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`) as branch-scoped environment variables
4. Optionally auto-install the app and persist `SLACK_BOT_TOKEN`
5. Cancel and redeploy so the new environment variables take effect

On production and local/development builds, the preview step is skipped automatically.

### Setup

#### 1. Add the CLI to your build script

```json
{
  "scripts": {
    "build": "vercel-slack build && next build"
  }
}
```

#### 2. Create a `manifest.json`

Place a [Slack app manifest](https://api.slack.com/reference/manifests) in your project root. URLs can use any placeholder domain — they will be rewritten to your preview deployment URL:

```json
{
  "display_information": {
    "name": "My Slack App"
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://example.com/api/slack/events"
    }
  }
}
```

#### 3. Configure environment variables

Add the following to your Vercel project:

| Variable                    | Required | Description                                                                                                                                            |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SLACK_CONFIGURATION_TOKEN` | Yes      | App configuration token. Generate at https://api.slack.com/apps                                                                                        |
| `VERCEL_API_TOKEN`          | Yes      | Vercel API token with write access. Create at https://vercel.com/account/settings/tokens                                                               |
| `SLACK_SERVICE_TOKEN`       | No       | Service token for auto-installing the app. Without this, the app must be installed manually. See https://docs.slack.dev/authentication/tokens/#service |

You must also enable **Automatically expose System Environment Variables** in your Vercel project settings.

### How it works

```
git push → Vercel preview build
  └─ vercel-slack build
       ├─ Skips if production, development, or local
       ├─ Reads manifest.json
       ├─ Creates or updates Slack app via apps.manifest API
       ├─ Rewrites manifest URLs → preview deployment URL
       ├─ Stores credentials as branch-scoped env vars
       ├─ Auto-installs app (if SLACK_SERVICE_TOKEN is set)
       └─ Redeploys to pick up new env vars (only needed on first deploy for branch)
```

### CLI Reference

```
vercel-slack v1.1.0

Usage: vercel-slack <command> [options]

Commands:
  build    Build and configure the Slack app for a Vercel preview deployment
  help     Show this help message

Options:
  --help, -h       Show help
  --version, -v    Show version
```

All Vercel and Slack environment variables are read automatically. You can override any of them via CLI flags (e.g. `--vercel-env`, `--slack-app-id`).

### Programmatic API

You can also call the preview function directly instead of using the CLI:

```typescript
import { preview } from "@vercel/slack-bolt/preview";

await preview();

// Or with overrides:
await preview({
  overrides: {
    VERCEL_ENV: "preview",
    SLACK_CONFIGURATION_TOKEN: "your-token",
  },
});
```

## API Reference

### `VercelReceiver`

Responsible for handling and parsing any incoming requests from Slack and then forwarding them to your Bolt app for event processing.

```typescript
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

#### Parameters

| Name                        | Type                              | Default Value                      | Required       | Description                                                            |
| --------------------------- | --------------------------------- | ---------------------------------- | -------------- | ---------------------------------------------------------------------- |
| `signingSecret`             | `string`                          | `process.env.SLACK_SIGNING_SECRET` | No<sup>1</sup> | Signing secret for your Slack app used to verify requests.             |
| `signatureVerification`     | `boolean`                         | `true`                             | No             | Enable or disable request signature verification.                      |
| `logger`                    | `Logger`<sup>2</sup>              | `new ConsoleLogger()`              | No             | Logger used for diagnostics.                                           |
| `logLevel`                  | `LogLevel`<sup>2</sup>            | `LogLevel.INFO`                    | No             | Minimum log level for the logger.                                      |
| `customPropertiesExtractor` | `(req: Request) => StringIndexed` | `undefined`                        | No             | Return value is merged into Bolt event `customProperties`<sup>2</sup>. |
| `ackTimeoutMs`              | `number`                          | `3001`                             | No             | Milliseconds to wait for `ack()` before returning a timeout error.     |

<sup>1</sup> Optional if `process.env.SLACK_SIGNING_SECRET` is provided.

<sup>2</sup> Provided by the [`@slack/bolt`](https://www.npmjs.com/package/@slack/bolt) library. More information [here](https://docs.slack.dev/tools/bolt-js/reference#app-options).

### `createHandler`

A function that returns a Vercel-compatible request handler that will initialize and start your Bolt app to process the event.

```typescript
// An example using Next.js route handlers

import { createHandler } from "@vercel/slack-bolt";
import { app, receiver } from "./app";

export const POST = createHandler(app, receiver);
```

#### Parameters

| Name       | Type              | Required | Description                                                  |
| ---------- | ----------------- | -------- | ------------------------------------------------------------ |
| `app`      | `App`<sup>1</sup> | Yes      | Your Bolt app                                                |
| `receiver` | `VercelReceiver`  | Yes      | The Vercel receiver instance used to process Slack requests. |

<sup>1</sup> Provided by the [`@slack/bolt`](https://www.npmjs.com/package/@slack/bolt) library. More information [here](https://docs.slack.dev/tools/bolt-js/reference#app-options).

## Examples

Starter templates: [Next.js](https://github.com/vercel-labs/slack-bolt/tree/examples/examples/nextjs), [Hono](https://github.com/vercel-labs/slack-bolt/tree/examples/examples/hono), [Nitro](https://github.com/vercel-labs/slack-bolt/tree/examples/examples/nitro).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:

- Check the [Slack Bolt documentation](https://slack.dev/bolt-js/)
- Review [Vercel Functions documentation](https://vercel.com/docs/functions)
- [Open an issue](https://github.com/vercel-labs/slack-bolt/issues) in this repository
