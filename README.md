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

This package automates the creation and installation of Slack apps into your internal workspace when a preview deployment is created. You can set this up using the CLI build command or the programmatic API.

### Update Project Level Environment Variables

- `SLACK_CONFIGURATION_TOKEN`: Create a Slack configuration token on the bottom of this [page](https://api.slack.com/apps)
- `SLACK_CONFIG_REFRESH_TOKEN`: The refresh token provided alongside the configuration token. When set, expired configuration tokens are automatically rotated and persisted — you never need to manually regenerate them.
- `SLACK_SERVICE_TOKEN`: Create a Slack service token to allow for automatic app installs by running `slack auth token` in your terminal and following the instructions
- `VERCEL_API_TOKEN`: Create a PAT [here](https://vercel.com/account/settings/tokens) to allow for automatic environment variable updates

### Option 1: CLI Build Command

In your `package.json` file update the build command to include `vercel-slack build`. You can put this before your framework's build command. For example, `vercel-slack build && next build`.

### Option 2: `setupSlackPreview`

If you prefer programmatic control, you can use the `setupSlackPreview` function exported from `@vercel/slack-bolt/preview` instead of the CLI.

```typescript
// scripts/setup-slack.ts
import { setupSlackPreview } from "@vercel/slack-bolt/preview";

const result = await setupSlackPreview();

switch (result.status) {
  case "skipped":
    console.log(`Skipped: ${result.reason}`);
    break;
  case "failed":
    console.error(`Failed: ${result.error}`);
    process.exit(1);
  case "created":
    console.log(`Created Slack app: ${result.appId}`);
    break;
  case "updated":
    console.log(`Updated Slack app: ${result.appId}`);
    break;
}
```

Then update your build command to run the script before your framework build. For example, `tsx scripts/setup-slack.ts && next build`.

#### Parameters

| Name               | Type      | Default                                | Required | Description                                                                          |
| ------------------ | --------- | -------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `manifestPath`            | `string`  | `"manifest.json"`                       | No       | Path to the manifest.json file (relative to repo root).                              |
| `slackConfigToken`        | `string`  | `process.env.SLACK_CONFIGURATION_TOKEN` | No       | Slack configuration token for creating/updating apps.                                |
| `slackConfigRefreshToken` | `string`  | `process.env.SLACK_CONFIG_REFRESH_TOKEN`| No       | Refresh token for automatic config token rotation.                                   |
| `vercelToken`             | `string`  | `process.env.VERCEL_API_TOKEN`          | No       | Vercel API token for setting/querying environment variables.                         |
| `slackServiceToken`       | `string`  | `process.env.SLACK_SERVICE_TOKEN`       | No       | Slack CLI service token (`xoxp-...`) for automatic app installation.                 |
| `debug`                   | `boolean` | `false`                                 | No       | Enable verbose debug logging.                                                        |

#### Return Value

Returns a `Promise<SetupResult>` indicating what action was taken:

| Status      | Description                                          |
| ----------- | ---------------------------------------------------- |
| `"skipped"` | Setup was skipped (e.g. missing tokens, not preview). |
| `"failed"`  | Setup encountered an error.                          |
| `"created"` | A new Slack app was created for this branch.          |
| `"updated"` | An existing Slack app's manifest was synced.          |

Each result includes an `appId` (when applicable) and a `warnings` array.

### How it works

Both the CLI and the programmatic API perform the same steps before your framework build to automate Slack app lifecycle management for preview branches:

1. **Checks the configuration token** — verifies the `SLACK_CONFIGURATION_TOKEN` is still valid. If it has expired and `SLACK_CONFIG_REFRESH_TOKEN` is set, it automatically rotates both tokens via [`tooling.tokens.rotate`](https://docs.slack.dev/reference/methods/tooling.tokens.rotate) and persists the new values as Vercel project-level env vars so all future builds pick them up.
2. **Cleans up orphaned apps** — deletes Slack apps tied to branches that no longer exist in your Vercel project.
3. **Loads and prepares your manifest** — reads your `manifest.json`, injects the preview branch URL into all request URLs, and appends deployment metadata.
4. **Configures deployment protection bypass** — generates or reuses a `VERCEL_AUTOMATION_BYPASS_SECRET` so Slack's incoming webhooks can reach your preview deployment even when [Vercel Authentication](https://vercel.com/docs/security/deployment-protection) is enabled.
5. **Creates or updates the Slack app** — on the first deploy for a branch, creates a new Slack app via the Manifest API and stores its credentials (`SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`) as branch-scoped Vercel environment variables. On subsequent deploys, it syncs the manifest to the existing app.
6. **Auto-installs the app** (if `SLACK_SERVICE_TOKEN` is set) — installs the app to your workspace and stores the `SLACK_BOT_TOKEN` as a branch-scoped env var.
7. **Triggers a redeploy** — on first-time app creation, triggers a fresh build so the newly stored env vars are available to your application code.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:

- Check the [Slack Bolt documentation](https://slack.dev/bolt-js/)
- Review [Vercel Functions documentation](https://vercel.com/docs/functions)
- [Open an issue](https://github.com/vercel-labs/slack-bolt/issues) in this repository
