# @vercel/slack-bolt

[![npm version](https://img.shields.io/npm/v/%40vercel%2Fslack-bolt)](https://www.npmjs.com/package/@vercel/slack-bolt)
[![npm downloads](https://img.shields.io/npm/dm/%40vercel%2Fslack-bolt?label=downloads)](https://www.npmjs.com/package/@vercel/slack-bolt)

A custom [Slack Bolt](https://slack.dev/bolt-js/) receiver built for Vercel's [Fluid Compute](https://vercel.com/docs/fluid-compute).

## Getting Started

Visit our [template](https://vercel.com/templates/backend/slack-bolt-with-nitro) to get started building a Slack app. If you are building an agent we recommend the [eve](https://eve.dev) framework. You can find the eve template [here](https://github.com/vercel/eve-examples/tree/main/eve-slack-agent-template).

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

### Compatibility

| Dependency    | Supported versions  |
| ------------- | ------------------- |
| `@slack/bolt` | `^4.7.3` or `^5.0.0` |
| Node.js       | `>=22.12`           |

`@slack/bolt` is a peer dependency, so declare it in your own `package.json` alongside this package. Do not install with `--legacy-peer-deps`: Bolt 5's `@slack/socket-mode` declares `undici` as a peer, and skipping peers makes `require('@slack/bolt')` fail with `Cannot find module 'undici'`.

## API Reference

### `VercelReceiver`

A Bolt receiver for Vercel Functions. It extends Bolt's `HTTPReceiver`: your route passes it each request, it answers Slack as soon as your listener calls `ack()`, and [`waitUntil`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil) keeps the listeners running after the response.

This example shows a single-workspace app with a fixed bot token. For an app that other workspaces install, see [OAuth](#oauth-multi-workspace-apps) below.

```typescript
// lib/slack.ts
import { App } from "@slack/bolt";
import { VercelReceiver } from "@vercel/slack-bolt";

const receiver = new VercelReceiver();

const app = new App({
  receiver,
  token: process.env.SLACK_BOT_TOKEN,
  // Checks the token on the first event, and again if that fails.
  deferInitialization: true,
});

app.message(/^(hi|hello|hey).*/, async ({ say }) => {
  await say("Hello, world!");
});

export const { POST } = receiver;
```

```typescript
// app/api/slack/events/route.ts
export { POST } from "@/lib/slack";
```

Point your Slack app's event subscription, interactivity and slash command URLs at the route. It can live at any path. With `deferInitialization`, the receiver runs `app.init()` on the first request, so nothing calls Slack while your app builds.

#### Options

`VercelReceiver` takes Bolt's [`HTTPReceiver` options](https://docs.slack.dev/tools/bolt-js/reference), except `endpoints`, `port`, `customRoutes` and `dispatchErrorHandler`, which configure Bolt's own HTTP server. The ones you're most likely to need:

| Name                        | Type                         | Default                            | Description                                                                                 |
| --------------------------- | ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `signingSecret`             | `string`                     | `process.env.SLACK_SIGNING_SECRET` | Verifies that requests come from Slack. Required unless `signatureVerification` is `false`. |
| `signatureVerification`     | `boolean`                    | `true`                             | Set to `false` to skip signature verification, for example in tests.                        |
| `logger`                    | `Logger`                     | Bolt's `ConsoleLogger`             | Pass it here: Bolt doesn't apply the `App`'s logger to a custom receiver.                   |
| `logLevel`                  | `LogLevel`                   | `LogLevel.INFO`                    | Minimum level for the receiver's logger.                                                    |
| `processBeforeResponse`     | `boolean`                    | `false`                            | Waits for your listeners to finish before answering Slack, instead of answering at `ack()`. |
| `processEventErrorHandler`  | `(args) => Promise<boolean>` | Bolt's default                     | Handles an error from your listeners. The receiver keeps it running with `waitUntil`.       |
| `customPropertiesExtractor` | `(req) => StringIndexed`     | None                               | Adds properties from the request to each event's `context`.                                 |

The OAuth options are described in [OAuth](#oauth-multi-workspace-apps).

The constructor throws Bolt's `AppInitializationError` when the signing secret is missing, when `clientId` is set without an `installationStore`, or when `redirectUri` isn't an absolute URL.

#### `receiver.fetch(request)`

Handles a Slack request and resolves with the `Response` once Slack is acknowledged. `receiver.POST` and `receiver.GET` are the same function, for frameworks that route by exported method names. In any other framework, pass the Web `Request` to `receiver.fetch`.

- `POST` requests are events, slash commands and interactions.
- With the OAuth options, a `GET` with a `code`, `error` or `state` query parameter is the OAuth callback, and any other `GET` is the install page.
- Anything else gets a `404`.

Bolt needs the raw body to verify Slack's signature, so `fetch` throws a `TypeError` if the request body has already been read. If you read it first, pass `request.clone()` instead.

### `preview`

Programmatic API for creating and configuring a Slack app for a Vercel preview deployment. This is the function that powers the `vercel-slack build` CLI. Imported from `@vercel/slack-bolt/preview`.

```typescript
import { preview } from "@vercel/slack-bolt/preview";

const result = await preview({
  branch: "feat/my-feature",
  projectId: "prj_...",
  deploymentUrl: "my-app-abc123.vercel.app",
  manifestPath: "manifest.json",
  slackConfigurationToken: process.env.SLACK_CONFIGURATION_TOKEN,
  vercelApiToken: process.env.VERCEL_API_TOKEN,
});
```

#### Parameters (`PreviewParams`)

| Name                      | Type     | Required | Description                                                      |
| ------------------------- | -------- | -------- | ---------------------------------------------------------------- |
| `branch`                  | `string` | Yes      | Git branch name for the preview deployment.                      |
| `projectId`               | `string` | Yes      | Vercel project ID.                                               |
| `deploymentUrl`           | `string` | Yes      | URL of the current deployment.                                   |
| `manifestPath`            | `string` | Yes      | Path to the Slack app `manifest.json` file.                      |
| `slackConfigurationToken` | `string` | Yes      | Slack app configuration token.                                   |
| `vercelApiToken`          | `string` | Yes      | Vercel API token with write access.                              |
| `branchUrl`               | `string` | No       | Branch-specific URL. Defaults to `deploymentUrl`.                |
| `slackAppId`              | `string` | No       | Existing Slack app ID to update instead of creating a new one.   |
| `slackServiceToken`       | `string` | No       | Service token for auto-installing the app.                       |
| `teamId`                  | `string` | No       | Vercel team ID.                                                  |
| `deploymentId`            | `string` | No       | Current deployment ID (used for cancel-and-redeploy).            |
| `automationBypassSecret`  | `string` | No       | Existing bypass secret. Generated automatically if not provided. |
| `commitSha`               | `string` | No       | Git commit SHA (displayed in the Slack app description).         |
| `commitMessage`           | `string` | No       | Git commit message (displayed in the Slack app description).     |
| `commitAuthor`            | `string` | No       | Git commit author (displayed in the Slack app description).      |

#### Return value (`PreviewResult`)

| Name            | Type      | Description                                                       |
| --------------- | --------- | ----------------------------------------------------------------- |
| `isNew`         | `boolean` | `true` if a new Slack app was created, `false` if updated.        |
| `installStatus` | `string`  | Installation outcome (e.g. `installed`, `missing_service_token`). |
| `app`           | `object`  | Slack API response containing `app_id` and credentials.           |

## OAuth (Multi-Workspace Apps)

`VercelReceiver` uses Bolt's own [OAuth support](https://slack.dev/bolt-js/concepts/authenticating-oauth), so other workspaces can install your app. Pass the OAuth options to the receiver, not the `App`, and leave `token` off the `App`: Bolt looks up each workspace's tokens in your `installationStore`.

```typescript
import { App } from "@slack/bolt";
import { VercelReceiver } from "@vercel/slack-bolt";
import { installationStore } from "./installation-store";

const receiver = new VercelReceiver({
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  scopes: ["chat:write", "commands"],
  installationStore,
});

const app = new App({ receiver, deferInitialization: true });

export const { GET, POST } = receiver;
```

Export `GET` and `POST` from one route, and add its URL as a **Redirect URL** under **OAuth & Permissions** in your Slack app settings. Opening the route in a browser shows the install page, and Slack sends the OAuth callback back to it. Separate install and callback routes also work: export `GET` from each, and the receiver tells them apart by their query parameters. If you set `redirectUri`, it must be a full URL, like `https://example.com/api/slack/oauth`.

`installerOptions` takes Bolt's installer options, except `installPath`, `redirectUriPath` and `port`: the receiver serves the install page and callback at whatever path your route has.

### Environment variables

Set these in your Vercel project (or `.env.local` for local development):

| Variable               | Description                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `SLACK_CLIENT_ID`      | App client ID, found under **Basic Information** on [api.slack.com](https://api.slack.com/apps). |
| `SLACK_CLIENT_SECRET`  | App client secret, found in the same section.                                                    |
| `SLACK_STATE_SECRET`   | A random string used to sign the OAuth state parameter.                                          |
| `SLACK_SIGNING_SECRET` | Signing secret for verifying incoming Slack requests.                                            |

The receiver reads `SLACK_SIGNING_SECRET` from `process.env` automatically. Pass the other three as options, as in the example above.

### Installation store

Bolt's default installation store keeps installations in memory, which Vercel doesn't share between function instances or keep across deployments. So `VercelReceiver` requires an `installationStore` whenever you set `clientId`.

Your store must implement `storeInstallation` and `fetchInstallation`, and optionally `deleteInstallation`. Any persistent backend works (Redis, PostgreSQL, DynamoDB, etc). See the [Bolt InstallationStore docs](https://slack.dev/bolt-js/concepts/authenticating-oauth#the-installation-store) for the full interface, and the [Next.js example](https://github.com/vercel-labs/slack-bolt/tree/master/examples/nextjs) for a working Redis implementation that also deletes installations on `app_uninstalled` and `tokens_revoked`.

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
    "build": "vercel-slack build --cleanup && next build"
  }
}
```

#### 2. Create a `manifest.json`

Place a [Slack app manifest](https://api.slack.com/reference/manifests) in your project root. URLs can use any placeholder domain — they will be rewritten to your preview deployment URL:

> **Note:** The manifest doesn't have to live in the project root. Set the `MANIFEST_PATH` environment variable or pass `--manifest-path <path>` to specify a custom location relative to the working directory.

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

| Variable                     | Required | Description                                                                                                                                            |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SLACK_CONFIGURATION_TOKEN`  | Yes      | App configuration token. Generate at https://api.slack.com/apps. Expires after 12 hours.                                                               |
| `SLACK_CONFIG_REFRESH_TOKEN` | No       | Refresh token for automatic rotation of expired configuration tokens. Provided alongside the configuration token. Strongly recommended.                |
| `VERCEL_API_TOKEN`           | Yes      | Vercel API token with write access. Create at https://vercel.com/account/settings/tokens                                                               |
| `SLACK_SERVICE_TOKEN`        | No       | Service token for auto-installing the app. Without this, the app must be installed manually. See https://docs.slack.dev/authentication/tokens/#service |

You must also enable **Automatically expose System Environment Variables** in your Vercel project settings.

### How it works

```
git push → Vercel preview build
  └─ vercel-slack build --cleanup
       ├─ Skips if production, development, or local
       ├─ Validates Slack and Vercel tokens
       │    └─ If expired and SLACK_CONFIG_REFRESH_TOKEN is set → auto-rotates
       │         and persists new tokens to Vercel env vars
       ├─ Cleans up orphaned preview apps (--cleanup)
       ├─ Reads manifest.json
       ├─ Creates or updates Slack app via apps.manifest API
       ├─ Rewrites manifest URLs → preview deployment URL
       ├─ Stores credentials as branch-scoped env vars
       ├─ Auto-installs app (if SLACK_SERVICE_TOKEN is set)
       └─ Redeploys to pick up new env vars (only needed on first deploy for branch)
```

#### Cleanup

When `--cleanup` is passed, the CLI removes Slack apps and branch-scoped environment variables for preview branches that are no longer active in the Vercel project. This runs before the main provisioning step and failures are non-fatal.

### CLI Reference

```
Usage: vercel-slack <command> [options]

Commands:
  build    Build and configure the Slack app for a Vercel preview deployment

Options:
  --cleanup        Clean up Slack apps and env vars for inactive preview branches
  --help, -h       Show help
  --version, -v    Show version
```

All Vercel and Slack environment variables are read automatically. You can override any of them via CLI flags (e.g. `--vercel-env`, `--slack-app-id`).

## Examples

Starter templates: [Next.js](https://github.com/vercel-labs/slack-bolt/tree/master/examples/nextjs), [Hono](https://github.com/vercel-labs/slack-bolt/tree/master/examples/hono), [Express](https://github.com/vercel-labs/slack-bolt/tree/master/examples/express), [TanStack Start](https://github.com/vercel-labs/slack-bolt/tree/master/examples/tanstack-start).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:

- Check the [Slack Bolt documentation](https://slack.dev/bolt-js/)
- Review [Vercel Functions documentation](https://vercel.com/docs/functions)
- [Open an issue](https://github.com/vercel-labs/slack-bolt/issues) in this repository
