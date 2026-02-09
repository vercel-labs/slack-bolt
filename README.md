# @vercel/slack-bolt

A custom [Slack Bolt](https://slack.dev/bolt-js/) receiver built for Vercel's [Fluid Compute](https://vercel.com/docs/fluid-compute).

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

## Vercel Preview Deployments

This package exports a custom build script to automate the creation and installation of Slack apps into your internal workspace when a preview deployment is created.

### Update Project Level Environment Variables

- `SLACK_CONFIGURATION_TOKEN`: Create a Slack configuration token on the bottom of this [page](https://api.slack.com/apps)
- `SLACK_SERVICE_TOKEN`: Create a Slack service token to allow for automatic app installs by running `slack auth token` in your terminal and following the instructions
- `VERCEL_API_TOKEN`: Create a PAT [here](https://vercel.com/account/settings/tokens) to allow for automatic environment variable updates

### Update build script

In your package.json file update the build command to include `vercel-slack build`. You can put this before your frameworks build command. For example, `vercel-slack build && next build`.

### How it works

The `vercel-slack build` command runs before your framework build and automates Slack app lifecycle management for preview branches:

1. **Cleans up orphaned apps** — deletes Slack apps tied to branches that no longer exist in your Vercel project.
2. **Loads and prepares your manifest** — reads your `manifest.json`, injects the preview branch URL into all request URLs, and appends deployment metadata.
3. **Configures deployment protection bypass** — generates or reuses a `VERCEL_AUTOMATION_BYPASS_SECRET` so Slack's incoming webhooks can reach your preview deployment even when [Vercel Authentication](https://vercel.com/docs/security/deployment-protection) is enabled.
4. **Creates or updates the Slack app** — on the first deploy for a branch, creates a new Slack app via the Manifest API and stores its credentials (`SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`) as branch-scoped Vercel environment variables. On subsequent deploys, it syncs the manifest to the existing app.
5. **Auto-installs the app** (if `SLACK_SERVICE_TOKEN` is set) — installs the app to your workspace and stores the `SLACK_BOT_TOKEN` as a branch-scoped env var.
6. **Triggers a redeploy** — on first-time app creation, triggers a fresh build so the newly stored env vars are available to your application code.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:

- Check the [Slack Bolt documentation](https://slack.dev/bolt-js/)
- Review [Vercel Functions documentation](https://vercel.com/docs/functions)
- [Open an issue](https://github.com/vercel-labs/slack-bolt/issues) in this repository
