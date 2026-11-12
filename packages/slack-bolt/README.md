# @vercel/slack-bolt

[![npm version](https://img.shields.io/npm/v/%40vercel%2Fslack-bolt)](https://www.npmjs.com/package/@vercel/slack-bolt)
[![npm downloads](https://img.shields.io/npm/dm/%40vercel%2Fslack-bolt?label=downloads)](https://www.npmjs.com/package/@vercel/slack-bolt)

A custom [Slack Bolt](https://slack.dev/bolt-js/) receiver built for Vercel's [Fluid Compute](https://vercel.com/docs/fluid-compute).

## Getting Started

Start from one of the [examples](#examples): each is a complete Slack app, with OAuth and a Redis installation store, that you can run locally and deploy to Vercel. If you are building an agent we recommend the [eve](https://eve.dev) framework. You can find the eve template [here](https://github.com/vercel/eve/tree/main/apps/templates/eve-slack-agent-template).

Upgrading from v1? See [Migrating from v1](#migrating-from-v1).

## Installation

```bash
npm install @vercel/slack-bolt @slack/bolt
```

```bash
yarn add @vercel/slack-bolt @slack/bolt undici
```

```bash
pnpm add @vercel/slack-bolt @slack/bolt
```

```bash
bun add @vercel/slack-bolt @slack/bolt
```

### Compatibility

| Dependency       | Supported versions   |
| ---------------- | -------------------- |
| `@slack/bolt`    | `^4.7.3` or `^5.0.0` |
| Node.js (Bolt 4) | `>=22.12`            |
| Node.js (Bolt 5) | `>=22.19`            |

Bolt 5 installs `undici` 8 through `@slack/socket-mode` 3.1, and `undici` 8 needs Node.js 22.19 or newer. On 22.12, for example, loading Bolt fails with a `TypeError` from `undici`. To stay on an older Node.js 22, install `undici@7` next to Bolt.

Bolt 5's `@slack/socket-mode` declares `undici` as a peer dependency, so loading Bolt fails with `Cannot find module 'undici'` if nothing installs it. npm and pnpm install peers for you, except with npm's `--legacy-peer-deps` or with pnpm's `autoInstallPeers` turned off. Yarn doesn't, which is why the `yarn add` command above adds `undici` itself: `undici@8` on Node.js 22.19 or newer, `undici@7` on older 22.x.

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

Point your Slack app's event subscription, interactivity and slash command URLs at the route. It can live at any path. With `deferInitialization`, the receiver runs `app.init()` on the first event, command or interaction, so nothing calls Slack while your app builds.

#### Options

`VercelReceiver` takes Bolt's [`HTTPReceiver` options](https://docs.slack.dev/tools/bolt-js/reference), except `endpoints`, `port`, `customRoutes` and `dispatchErrorHandler`, which configure Bolt's own HTTP server. The ones you're most likely to need:

| Name                            | Type                         | Default                            | Description                                                                                              |
| ------------------------------- | ---------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `signingSecret`                 | `string`                     | `process.env.SLACK_SIGNING_SECRET` | Verifies that requests come from Slack. Required unless `signatureVerification` is `false`.              |
| `signatureVerification`         | `boolean`                    | `true`                             | Set to `false` to skip signature verification, for example in tests.                                     |
| `logger`                        | `Logger`                     | Bolt's `ConsoleLogger`             | Pass it here: Bolt doesn't apply the `App`'s logger to a custom receiver.                                |
| `logLevel`                      | `LogLevel`                   | `LogLevel.INFO`                    | Minimum level for Bolt's default logger. Set the level on your own `logger` yourself.                    |
| `processBeforeResponse`         | `boolean`                    | `false`                            | Waits for your listeners to finish before answering Slack, instead of answering at `ack()`.              |
| `processEventErrorHandler`      | `(args) => Promise<boolean>` | Bolt's default                     | Handles an error from your listeners. The receiver keeps it running with `waitUntil`.                    |
| `unhandledRequestTimeoutMillis` | `number`                     | `3001`                             | How long to wait for a listener to call `ack()` before `unhandledRequestHandler` runs.                   |
| `unhandledRequestHandler`       | `(args) => void`             | Logs an error and answers `404`    | Answers Slack when no listener calls `ack()` in time.                                                    |
| `customPropertiesExtractor`     | `(req) => StringIndexed`     | None                               | Adds properties from the request to each event's `context`. See [Custom properties](#custom-properties). |

The OAuth options are described in [OAuth](#oauth-multi-workspace-apps).

The constructor throws Bolt's `AppInitializationError` when the signing secret is missing, when `clientId` is set without an `installationStore`, a `clientSecret` or a `stateSecret`, or when `redirectUri` isn't an absolute `http` or `https` URL with a percent-encoded, normalized path (no `.` or `..` segments, and not starting with `//`) and without a query string, fragment, surrounding whitespace or control characters. An empty `redirectUri` counts as not set. You can leave out `stateSecret` if `installerOptions` has a `stateStore` or sets `stateVerification: false`.

#### Custom properties

`customPropertiesExtractor` gets Bolt's `BufferedIncomingMessage` for each event, command and interaction, and what it returns is added to your listener's `context`:

- `req.url` is the path and query your route was called on, like `/api/slack/events?tenant=acme`, not a full URL. Parse it with a base: `new URL(req.url ?? "/", "http://localhost")`.
- `req.headers` has lowercase names, like `req.headers["x-region"]`.
- `req.rawBody` is a `Buffer` with the raw body: JSON for events, form-encoded for slash commands, and form-encoded with the JSON in a `payload` field for interactions.

```typescript
const receiver = new VercelReceiver({
  customPropertiesExtractor: (req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    return { tenant: url.searchParams.get("tenant") ?? undefined };
  },
});

app.event("app_mention", async ({ context }) => {
  console.log(context.tenant);
});
```

Bolt calls it before your listeners. If it throws, your listeners don't run, and the receiver passes the error to `processEventErrorHandler` as if a listener had failed: with Bolt's default handler, Slack gets a `500`, so it retries events, and a `processEventErrorHandler` of your own gets the original error, or an `Error` wrapping it if it isn't an object. To carry on without the properties instead, catch your own errors and decide what a missing value means. Keep the extractor synchronous: Bolt doesn't await it, so an async extractor's properties never reach `context`, your listeners run without them, and a rejection goes unhandled.

#### `receiver.fetch(request)`

Handles a Slack request and resolves with the `Response` once Slack is acknowledged. `receiver.POST` and `receiver.GET` call it, for frameworks that route by exported method names. In any other framework, pass the Web `Request` to `receiver.fetch`. See [Frameworks](#frameworks) for examples.

- `POST` requests are events, slash commands and interactions.
- With the OAuth options, a `GET` with a `code`, `error` or `state` query parameter is the OAuth callback, and any other `GET` is the install page.
- Anything else gets a `404`.

Bolt needs the raw body to verify Slack's signature, so `fetch` throws a `TypeError` if the request body has already been read, or something holds a reader on it. To read it yourself too, clone the request before you read it, read the original and pass the clone to `fetch`. Do it in that order: in Express, Nitro and other frameworks whose `Request` wraps Node.js's request, reading a clone also uses up the original's body.

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
| `deploymentId`            | `string` | No       | Current deployment ID. Only the CLI uses it, to redeploy.        |
| `slackConfigRefreshToken` | `string` | No       | Only the CLI uses it, to rotate an expired configuration token.  |
| `automationBypassSecret`  | `string` | No       | Existing bypass secret. Generated automatically if not provided. |
| `commitSha`               | `string` | No       | Git commit SHA (displayed in the Slack app description).         |
| `commitMessage`           | `string` | No       | Git commit message (displayed in the Slack app description).     |
| `commitAuthor`            | `string` | No       | Git commit author (displayed in the Slack app description).      |

#### Return value (`PreviewResult`)

| Name            | Type      | Description                                                       |
| --------------- | --------- | ----------------------------------------------------------------- |
| `isNew`         | `boolean` | `true` if a new Slack app was created, `false` if updated.        |
| `installStatus` | `string`  | Installation outcome (e.g. `installed`, `missing_service_token`). |
| `installError`  | `string`  | Why Slack didn't install the app, when it gave a reason.          |
| `app`           | `object`  | Slack API response containing `app_id` and credentials.           |

`installStatus` is one of `installed`, `missing_service_token`, `no_access`, `app_approval_request_eligible`, `app_approval_request_pending`, `app_approval_request_denied`, `invalid_app_id`, `slack_api_error` and `unknown_error`. With the last two, `installError` has Slack's error code, like `service_limits_exceeded` for a workspace that has reached its app limit, or the HTTP status Slack answered with.

`preview` rewrites the manifest file at `manifestPath` in place, creates or updates the Slack app, and saves a new app's credentials as environment variables for the branch. Whenever Slack installs the app, it saves the app's tokens too. It doesn't redeploy: the variables reach the branch's next deployment.

If Vercel doesn't save a new app's credentials, `preview` deletes the app again and rejects, so the branch's next run starts over instead of creating a second app.

## Frameworks

`VercelReceiver` works with any framework that hands your route a Web [`Request`](https://developer.mozilla.org/docs/Web/API/Request) and takes a `Response` back: pass the request to `receiver.fetch` and return what it resolves with. Frameworks that route by exported method names, like Next.js, can export the receiver's `POST` and `GET` directly, as in [`VercelReceiver`](#vercelreceiver). Frameworks built on Node.js's own request and response, like Express, need a small adapter, shown below.

Serve the receiver from one route, and point your Slack app's request URLs at it. The route handles `POST` for events, slash commands and interactions, and with the [OAuth options](#oauth-multi-workspace-apps), `GET` for the install page and OAuth callback. Bolt verifies Slack's signature against the raw request body, so don't add middleware to the Slack route that reads the body first.

The snippets below show a few common frameworks. Each imports `receiver` from the file that creates your `App`, so export it there with `export { receiver };`. The [examples](#examples) show each one in a complete app.

### Hono

```typescript
import { Hono } from "hono";
import { receiver } from "./lib/slack";

const app = new Hono();

app.all("/api/slack/events", (c) => receiver.fetch(c.req.raw));

export default app;
```

### Express

Express hands your route Node.js's request and response, not a Web `Request`, so adapt `receiver.fetch` with `toNodeHandler` from [srvx](https://srvx.h3.dev). Add srvx to your own dependencies to import it.

```typescript
import express, { type RequestHandler } from "express";
import { toNodeHandler } from "srvx/node";
import { receiver } from "./lib/slack";

const app = express();

// srvx types its handler for HTTP/1 and HTTP/2 servers; Express is HTTP/1,
// hence the cast.
app.all("/api/slack/events", toNodeHandler(receiver.fetch) as RequestHandler);

export default app;
```

Add the Slack route before any body parser, like `express.json()` or `express.urlencoded()`, or add parsers only to the routes that need them.

### Nitro

```typescript
// routes/api/slack/events.ts
import { defineHandler } from "nitro";
import { receiver } from "../../../lib/slack";

export default defineHandler((event) => receiver.fetch(event.req));
```

In Nitro 3, `event.req` is the Web `Request`. Put the route under `routes/api`: Nitro's top-level `api` directory [isn't compatible with Vercel](https://nitro.build/deploy/providers/vercel). Nitro 3 doesn't scan for routes until you set `serverDir` in `nitro.config.ts`: `serverDir: "./"` serves the `routes` directory at your project's root, and the [Nitro example](https://github.com/vercel-labs/slack-bolt/tree/master/examples/nitro) sets `"./src"`.

### TanStack Start

```typescript
// src/routes/api/slack/events.ts
import { createFileRoute } from "@tanstack/react-router";
import { receiver } from "~/lib/slack";

export const Route = createFileRoute("/api/slack/events")({
  server: {
    handlers: {
      GET: ({ request }) => receiver.fetch(request),
      POST: ({ request }) => receiver.fetch(request),
    },
  },
});
```

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

const app = new App({ receiver });

export const { GET, POST } = receiver;
```

An OAuth `App` doesn't need `deferInitialization`: its `init()` doesn't call Slack, and without it a missing `clientId` fails when the `App` is created instead of turning OAuth off.

Export `GET` and `POST` from one route, and add its URL as a **Redirect URL** under **OAuth & Permissions** in your Slack app settings. Opening the route in a browser shows the install page, and Slack sends the OAuth callback back to it. Separate install and callback routes also work: export `GET` from each, and the receiver tells them apart by their query parameters. If you set `redirectUri`, it must be a full, percent-encoded URL with a path and without a query string or fragment, like `https://example.com/api/slack/oauth` ([Options](#options) lists the exact rules), and an empty string counts as not set. For a route at the root of your domain, end it with a slash, like `https://example.com/`. Bolt requires the URL to end with its callback pathname. This restriction applies to the configured URL; Slack still adds `code` and `state` query parameters to the callback request.

`installerOptions` takes Bolt's installer options, except `installPath`, `redirectUriPath` and `port`: the receiver serves the install page and callback at whatever path your route has, and installer callbacks like `installPathOptions.beforeRedirection` see your route's own `req.url`. Like listeners, the install page and callback keep running with `waitUntil`, so a `callbackOptions.successAsync` or `failureAsync` can finish after the response.

Bolt doesn't apply the `App`'s `clientOptions` to a custom receiver's installer. If you set `clientOptions` on the `App`, like a `slackApiUrl` for GovSlack, a proxy `agent`, `retryConfig` or `timeout`, pass the same options as `installerOptions.clientOptions` too, so the OAuth callback and token refreshes use them. For a Slack host other than slack.com, also set `installerOptions.authorizationUrl` to its OAuth authorize URL.

### Environment variables

Set these in your Vercel project (or `.env.local` for local development):

| Variable               | Description                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `SLACK_CLIENT_ID`      | App client ID, found under **Basic Information** on [api.slack.com](https://api.slack.com/apps). |
| `SLACK_CLIENT_SECRET`  | App client secret, found in the same section.                                                    |
| `SLACK_STATE_SECRET`   | A random string used to sign the OAuth state parameter.                                          |
| `SLACK_SIGNING_SECRET` | Signing secret for verifying incoming Slack requests.                                            |

The receiver reads `SLACK_SIGNING_SECRET` from `process.env` automatically. Pass the other three as options, as in the example above.

The [examples](#examples) prefix `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` with their framework, like `NEXT_SLACK_SIGNING_SECRET`, and pass them to the receiver themselves. When you start from one, set the names in its `.env.example`: with only the unprefixed names, the example has no client ID, so creating its `App` throws Bolt's `AppInitializationError` at startup.

### Installation store

Bolt's default installation store keeps installations in memory, which Vercel doesn't share between function instances or keep across deployments. So `VercelReceiver` requires an `installationStore` whenever you set `clientId`.

Your store must implement `storeInstallation` and `fetchInstallation`, and optionally `deleteInstallation`. Any persistent backend works (Redis, PostgreSQL, DynamoDB, etc). See the [Bolt InstallationStore docs](https://docs.slack.dev/tools/bolt-js/concepts/authenticating-oauth#installation-store) for the full interface, and the [Next.js example](https://github.com/vercel-labs/slack-bolt/tree/master/examples/nextjs) for a working Redis implementation that also deletes installations on `app_uninstalled` and `tokens_revoked`.

## Preview Deployments

`@vercel/slack-bolt` can automatically create and manage a dedicated Slack app for each preview branch. On every preview build it will:

1. Create a new Slack app (or update the existing one) from your `manifest.json`
2. Rewrite manifest URLs to point to the preview deployment
3. Store the app credentials (`SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`) as branch-scoped environment variables, with the two secrets as [Sensitive](https://vercel.com/docs/environment-variables/sensitive-environment-variables) ones
4. Optionally auto-install the app and persist `SLACK_BOT_TOKEN`
5. Cancel and redeploy when it saved variables the build didn't have, so they take effect

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
  "features": {
    "bot_user": {
      "display_name": "My Slack App"
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": ["app_mentions:read", "chat:write"]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://example.com/api/slack/events",
      "bot_events": ["app_mention"]
    }
  }
}
```

The CLI names each preview app after its branch, like `My Slack App (feat-thing)`. Slack limits app names to 35 characters and to letters, digits, spaces and a few symbols, so the CLI shortens the branch name to fit and replaces anything else in it, like `/`, `+`, `@` or accented letters, with `-`.

#### 3. Configure environment variables

Add the following to your Vercel project:

| Variable                     | Required | Description                                                                                                                                            |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SLACK_CONFIGURATION_TOKEN`  | Yes      | App configuration token. Generate at https://api.slack.com/apps. Expires after 12 hours.                                                               |
| `SLACK_CONFIG_REFRESH_TOKEN` | No       | Refresh token for automatic rotation of expired configuration tokens. Provided alongside the configuration token. Strongly recommended.                |
| `VERCEL_API_TOKEN`           | Yes      | Vercel API token with write access. Create at https://vercel.com/account/settings/tokens                                                               |
| `SLACK_SERVICE_TOKEN`        | No       | Service token for auto-installing the app. Without this, the app must be installed manually. See https://docs.slack.dev/authentication/tokens/#service |

You must also enable **Automatically expose System Environment Variables** in your Vercel project settings.

#### 4. Read the preview app's credentials

The CLI saves each preview app's credentials under fixed names, scoped to the branch: `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, and with a `SLACK_SERVICE_TOKEN`, `SLACK_BOT_TOKEN`. Your receiver has to read those names, or the preview answers Slack with `401` because it verifies requests with another app's signing secret.

The receiver reads `SLACK_SIGNING_SECRET` by default. With a `SLACK_SERVICE_TOKEN`, the CLI installs the app and stores its bot token, so a single-workspace app needs nothing else:

```typescript
const receiver = new VercelReceiver();

const app = new App({
  receiver,
  token: process.env.SLACK_BOT_TOKEN,
  deferInitialization: true,
});
```

For an [OAuth](#oauth-multi-workspace-apps) app, pass the client ID and secret under the names the CLI uses, and set `SLACK_STATE_SECRET` for the Preview environment yourself. The CLI rewrites the manifest's redirect URLs to the preview, so the install page and callback work there without a `redirectUri`:

```typescript
const receiver = new VercelReceiver({
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  scopes: ["chat:write", "commands"],
  installationStore,
});
```

The [examples](#examples) don't use the CLI, and read framework-prefixed names like `NEXT_SLACK_SIGNING_SECRET`. To add previews to an app started from one, switch it to the unprefixed names above.

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
       ├─ Rewrites manifest URLs → preview deployment URL, and writes the file back
       ├─ Creates or updates Slack app via apps.manifest API
       ├─ Stores credentials as branch-scoped env vars
       ├─ Auto-installs app (if SLACK_SERVICE_TOKEN is set), and stores its tokens
       └─ Starts a new deployment to pick up the env vars, and cancels this one
            (when it saved variables this build didn't have)
```

The request URLs the CLI gives Slack carry your project's [Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation) secret, so Slack can reach a preview behind Deployment Protection. The CLI generates one if the project has none. Redirect URLs don't carry it, because the browser follows them.

The first build of a branch creates the app, so it ends as **Canceled** in Vercel and the deployment it started is the one that goes live. The same happens on a later build that saves a token for the first time: when the app only now got installed, because it was waiting for approval, the workspace had no room for another app, or you added `SLACK_SERVICE_TOKEN` since. The CLI replaces a deployment once: a deployment it started doesn't start another, and fails if it had to create the app again.

The CLI only creates an app for a branch that has none, or whose app is out of reach: deleted, or created with a different user's configuration token. If a later build can't reach Slack, Slack is rate limiting, or Slack rejects the manifest, the build fails instead of creating a second app for the branch; fix the manifest or redeploy to try again. If Vercel doesn't save a new app's credentials, the CLI deletes the app again and fails, so the next build starts over.

When Slack doesn't install the app, the build carries on and prints Slack's reason, like `service_limits_exceeded` for a workspace that has reached its app limit (10 on Slack's free plan). Install the app yourself from the URL the build prints, or fix the cause and redeploy.

#### Token rotation

Slack's configuration tokens expire after 12 hours. With `SLACK_CONFIG_REFRESH_TOKEN` set, the CLI rotates an expired token and saves both new tokens to your Vercel project, in the environments and with the type (Sensitive or not) the old ones had.

A build gets its variables when its deployment is created, so a build that waited in the queue can still have the expired token after an earlier build rotated it. Its refresh token has been used by then: rotating with it again may fail, and when it works it saves an older refresh token over the newer one. So such a build first looks for a newer token in your Vercel project and uses that instead of rotating again. It reads the token through the Vercel API, which can't read a Sensitive variable: with a Sensitive `SLACK_CONFIGURATION_TOKEN` the build rotates the token itself, and fails if Slack no longer accepts its refresh token; redeploy it.

The CLI doesn't rotate the token when it couldn't reach Slack to check it. The build fails instead, and the next one tries again.

#### Cleanup

When `--cleanup` is passed, the CLI removes Slack apps and branch-scoped environment variables for preview branches that are no longer active in the Vercel project, which is the case once the branch is deleted from the Git repository. It deletes every variable the CLI stores for a branch, including `SLACK_APP_LEVEL_TOKEN` and `SLACK_USER_TOKEN`. This runs before the main provisioning step and failures are non-fatal.

A branch's `SLACK_APP_ID` is the only record of its app, so the CLI deletes the branch's variables only once the app is deleted, or Slack says it's already gone, and `SLACK_APP_ID` last. If Slack can't be reached, is rate limiting or refuses to delete the app, the app and the branch's variables stay, and the next build with `--cleanup` tries again. Slack refuses with `no_permission` when the app belongs to a different user than the configuration token does, and keeps refusing: delete the app at [api.slack.com/apps](https://api.slack.com/apps), or the branch's Slack variables in your Vercel project.

### CLI Reference

```
Usage: vercel-slack <command> [options]

Commands:
  build    Build and configure the Slack app for a Vercel preview deployment

Options:
  --cleanup        Clean up Slack apps and env vars for inactive preview branches
  --debug          Log every HTTP request and response, with secrets redacted
  --help, -h       Show help
  --version, -V    Show version
```

`vercel-slack build` exits with code 1 when it fails, so a build script like `vercel-slack build && next build` stops and the preview deployment fails instead of going live without its Slack credentials. Production, development and local builds skip it and exit with code 0.

Previews that can't read `SLACK_CONFIGURATION_TOKEN` or `VERCEL_API_TOKEN`, like those of pull requests from forks, fail too. To build them anyway, without a Slack app, use `vercel-slack build || true` instead.

Pass `--debug`, or set `VERCEL_SLACK_DEBUG=1`, to log every request the CLI makes. Tokens, secrets, environment variable values and the protection bypass secret are redacted, with at most their last four characters shown.

All Vercel and Slack environment variables are read automatically. You can override any of them via CLI flags (e.g. `--vercel-env`, `--slack-app-id`).

## Migrating from v1

v2 rebuilds `VercelReceiver` on Bolt's `HTTPReceiver`. Your listeners don't change, apart from the details in [Other changes](#other-changes): what changes is how you create the receiver and serve it. v2 needs `@slack/bolt` 4.7.3 or newer and Node.js 22.12 or newer. The `preview` API and the `vercel-slack` CLI work as before, with stricter failures: `vercel-slack build` now exits with code 1 when it fails, which stops a `vercel-slack build && next build` script (see the [CLI Reference](#cli-reference)), and `preview` rejects when Vercel doesn't save every credential, or when Slack is unreachable, rate limiting or rejects the manifest while it updates a branch's app, where v1 created a second app. Both also save an app's tokens on any run that installs it, where v1 only saved them on the run that created the app, and the CLI then replaces the deployment as it does for a new app (see [How it works](#how-it-works)). v2 no longer reads `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` itself, so see [Read the preview app's credentials](#4-read-the-preview-apps-credentials) if your previews use OAuth.

With Bolt 5, v2 needs Node.js 22.19 or newer. See [Compatibility](#compatibility).

### Replace `createHandler`

`createHandler(app, receiver)` is removed. In v1, your route created the handler:

```typescript
// app/api/slack/events/route.ts
import { createHandler } from "@vercel/slack-bolt";
import { app, receiver } from "@/lib/slack";

export const POST = createHandler(app, receiver);
```

In v2, export the receiver's `POST` where you create the `App`, and re-export it from the route:

```typescript
// lib/slack.ts, after creating the App
export const { POST } = receiver;
```

```typescript
// app/api/slack/events/route.ts
export { POST } from "@/lib/slack";
```

Keep `deferInitialization: true` on an `App` with a `token`. The receiver then runs `app.init()` on the first event, command or interaction, where `createHandler` ran it on the first request. An OAuth `App` doesn't need it; see [OAuth](#oauth-multi-workspace-apps). Outside Next.js, pass each request to `receiver.fetch`, as in [Frameworks](#frameworks).

### Serve OAuth with `GET`

`receiver.handleInstall` and `receiver.handleCallback` are replaced by `receiver.GET`, which tells the install page and the OAuth callback apart by their query parameters. Your v1 routes can keep their paths:

```typescript
// app/api/slack/install/route.ts
import { receiver } from "@/lib/slack";

export const GET = receiver.GET; // was receiver.handleInstall
```

```typescript
// app/api/slack/oauth-redirect/route.ts
import { receiver } from "@/lib/slack";

export const GET = receiver.GET; // was receiver.handleCallback
```

Or serve both from your events route with `export const { GET, POST } = receiver`, and make that route's URL your Slack app's Redirect URL.

### Pass the OAuth credentials

v1 read `clientId`, `clientSecret` and `stateSecret` from `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_STATE_SECRET`. v2 only reads `SLACK_SIGNING_SECRET`, so pass the other three yourself:

```typescript
const receiver = new VercelReceiver({
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  scopes: ["chat:write", "commands"],
  installationStore,
});
```

Without `clientId`, the receiver doesn't set up OAuth: `GET` answers `404`, and Bolt can't initialize an `App` that has neither a token nor OAuth. Whenever you set `clientId`, the receiver also needs `clientSecret`, `stateSecret` (unless `installerOptions` has a `stateStore` or sets `stateVerification: false`) and an `installationStore`, and throws an `AppInitializationError` if one is missing or empty. So a missing `clientSecret` or `stateSecret` fails at startup instead of turning OAuth off. `redirectUri`, if you set it, must be a full, percent-encoded URL with a normalized path and without a query string or fragment ([Options](#options) lists the exact rules), where v1 accepted any string.

### Changed options

`VercelReceiver` takes Bolt's `HTTPReceiver` options, described in [Options](#options). `installerOptions` takes the same fields as in v1.

| v1                                     | v2                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ackTimeoutMs`                         | `unhandledRequestTimeoutMillis`. Pass `unhandledRequestHandler` to change what Slack gets when no listener calls `ack()` in time.                                                                                                                                         |
| `customPropertiesExtractor(req, body)` | `customPropertiesExtractor(req)`, where `req` is Bolt's `BufferedIncomingMessage`. `req.url` is now the path and query, not a full URL, and the body is `req.rawBody`, unparsed. A throw goes to `processEventErrorHandler`. See [Custom properties](#custom-properties). |
| `scopes` as a function                 | Removed. `scopes` takes a fixed list.                                                                                                                                                                                                                                     |
| `beforeProcess`                        | Removed. See [Replace `beforeProcess`](#replace-beforeprocess).                                                                                                                                                                                                           |

`createHandler` and the `VercelHandler`, `BeforeProcessFn`, `ScopesResolver` and `VercelInstallerOptions` types are removed too. For the installer options' type, use `VercelReceiverOptions["installerOptions"]`.

The installer is now Bolt's own, so v1's notes for Bolt 5 no longer apply: `installerOptions.clientOptions` and the errors passed to `installerOptions.callbackOptions.failure` come from the same `@slack/web-api` and `@slack/oauth` versions as your Bolt.

### Replace `beforeProcess`

To run code for every event, command and interaction after Bolt has verified it, use Bolt's [global middleware](https://docs.slack.dev/tools/bolt-js/concepts/global-middleware) with `app.use()`.

To answer a request yourself instead of passing it to Bolt, as `beforeProcess` could, handle it in your route before calling `receiver.fetch`. Your route runs before Bolt verifies Slack's signature, so check it with Bolt's `isValidSlackRequest` before you trust the body:

```typescript
// app/api/slack/events/route.ts
import { isValidSlackRequest } from "@slack/bolt";
import { forward, shouldForward } from "@/lib/forward";
import { receiver } from "@/lib/slack";

export async function POST(request: Request) {
  // Clone before reading, so the receiver gets an untouched body.
  const copy = request.clone();
  const body = await request.text();
  const verified = isValidSlackRequest({
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
    body,
    headers: {
      "x-slack-signature": request.headers.get("x-slack-signature") ?? "",
      "x-slack-request-timestamp": Number(
        request.headers.get("x-slack-request-timestamp"),
      ),
    },
  });
  if (verified && shouldForward(body)) return forward(body);
  return receiver.fetch(copy);
}
```

`shouldForward` and `forward` stand in for your own code. `body` is the raw body: JSON for events, and form data for slash commands and interactions, which put their JSON in a `payload` field.

### Other changes

- The receiver's `toHandler()`, `handleError()` and `getLogger()` methods are removed. Serve it with `fetch`, `POST` and `GET`, and log through the `logger` you pass it.
- Don't call `receiver.start()` or `app.start()`. In v1, `start()` returned the request handler. In v2 it's Bolt's `HTTPReceiver.start()`, which starts Bolt's own HTTP server, on port 3000 unless you pass one. Likewise, `stop()` resolved without doing anything in v1, and in v2 it rejects with a `ReceiverInconsistentStateError` because no server was started, so remove any `app.stop()` or `receiver.stop()` call from your shutdown or test teardown code.
- Error responses are Bolt's, with empty bodies: `401` when a request fails signature verification, `400` for a body Bolt can't parse, `413` for a body over Bolt 5's `bodyLimit`, `500` when a listener throws before `ack()`, and `404` when no listener calls `ack()` in time. v1 answered with JSON bodies, and with `408` in the last two cases.
- `context.retryNum` and `context.retryReason` are `undefined` when Slack isn't retrying a request, where v1 set them to `0` and `""`.
- `logLevel` only sets the level of Bolt's default logger. v1 also applied it to a `logger` you passed, so set your own logger's level yourself.

## Examples

Starter templates: [Next.js](https://github.com/vercel-labs/slack-bolt/tree/master/examples/nextjs), [Hono](https://github.com/vercel-labs/slack-bolt/tree/master/examples/hono), [Express](https://github.com/vercel-labs/slack-bolt/tree/master/examples/express), [TanStack Start](https://github.com/vercel-labs/slack-bolt/tree/master/examples/tanstack-start), [Nitro](https://github.com/vercel-labs/slack-bolt/tree/master/examples/nitro).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:

- Check the [Slack Bolt documentation](https://slack.dev/bolt-js/)
- Review [Vercel Functions documentation](https://vercel.com/docs/functions)
- [Open an issue](https://github.com/vercel-labs/slack-bolt/issues) in this repository
