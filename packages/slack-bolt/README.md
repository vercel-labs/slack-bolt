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

Gives a preview deployment's branch its own Slack app. It's what `vercel-slack build` runs. Imported from `@vercel/slack-bolt/preview`.

```typescript
import { preview } from "@vercel/slack-bolt/preview";

const result = await preview({ logger: console });
```

In a Vercel build it needs no options: each one defaults to the environment variable the build has. It creates the branch's app from the manifest or updates the one the branch has, saves the app's credentials as preview variables of the branch, installs the app when there's a service token, and starts a new deployment when this one was built without those variables. [How it works](#how-it-works) has the details.

It resolves with `status: "skipped"` in anything but a branch's preview deployment. It rejects when the app couldn't be set up, with a message that says what to do and never contains a secret.

#### Options (`PreviewOptions`)

| Name                      | Default                                                | Description                                                                       |
| ------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `manifest`                | `MANIFEST_PATH`, then `manifest.json`, `.yaml`, `.yml` | The manifest, or the path of its JSON or YAML file. The file is never changed.    |
| `branch`                  | `VERCEL_GIT_COMMIT_REF`                                | The branch the app belongs to.                                                    |
| `url`                     | `VERCEL_BRANCH_URL`, then `VERCEL_URL`                 | The host or URL Slack sends the app's requests to.                                |
| `projectId`               | `VERCEL_PROJECT_ID`                                    | The Vercel project.                                                               |
| `teamId`                  | `VERCEL_TEAM_ID`                                       | The project's team. Needed for a team's project.                                  |
| `deploymentId`            | `VERCEL_DEPLOYMENT_ID`                                 | The deployment to replace when it was built without the app's variables.          |
| `vercelToken`             | `VERCEL_API_TOKEN`                                     | Reads and writes the project's environment variables.                             |
| `slackConfigToken`        | `SLACK_CONFIGURATION_TOKEN`                            | Creates, updates and deletes Slack apps. Without one, the project's stored token. |
| `slackConfigRefreshToken` | `SLACK_CONFIG_REFRESH_TOKEN`                           | Rotates an expired configuration token.                                           |
| `slackServiceToken`       | `SLACK_SERVICE_TOKEN`                                  | Installs the app. Without one, someone has to install it.                         |
| `bypassSecret`            | `VERCEL_AUTOMATION_BYPASS_SECRET`                      | Gets Slack's requests through Deployment Protection. Without one, one is created. |
| `commit`                  | `VERCEL_GIT_COMMIT_SHA`, `_MESSAGE`, `_AUTHOR_LOGIN`   | `{ sha, message, author }`, shown on the app's page in Slack.                     |
| `sensitive`               | `true`                                                 | Save the app's secrets as Sensitive variables, which can't be read back.          |
| `logger`                  | none                                                   | `{ info, warn, debug? }`, like `console`. Says what's being done.                 |

#### Result (`PreviewResult`)

Outside a branch's preview deployment:

```typescript
{ status: "skipped", reason: "not_preview" | "no_branch", message: string }
```

Otherwise:

| Name           | Type                                                           | Description                                                                                 |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `status`       | `"ready" \| "redeployed" \| "outdated"`                        | Whether this deployment has the app's variables, was replaced by one that does, or neither. |
| `branch`       | `string`                                                       | The branch the app belongs to.                                                              |
| `app`          | `{ id, name, created, replaced?, url, installUrl }`            | The app, whether this run created it, its settings page, and where to install it.           |
| `installation` | `{ installed: true }` or `{ installed: false, reason, code? }` | Whether the app is installed, and why not.                                                  |
| `saved`        | `string[]`                                                     | The names of the variables this run saved for the branch.                                   |
| `deployment`   | `{ id, url }`                                                  | The deployment that replaces this one, when `status` is `redeployed`.                       |

`installation.reason` is one of `no_service_token`, `approval_required`, `approval_pending`, `approval_denied`, `no_access` (the service token's user can't see the app), `unavailable` (Slack couldn't be reached) and `refused` (with Slack's error in `code`). An app that isn't installed doesn't make `preview` reject: the app exists, and can be installed from `app.installUrl`.

The result never contains the app's secrets. They go to Vercel, and nowhere else.

### `cleanup`

Deletes the Slack apps and variables of branches that are gone. It's what `vercel-slack cleanup` runs. Imported from `@vercel/slack-bolt/preview`.

```typescript
import { cleanup } from "@vercel/slack-bolt/preview";

const { removed, failed } = await cleanup({ logger: console });
```

It takes `projectId`, `teamId`, `vercelToken`, `slackConfigToken`, `slackConfigRefreshToken` and `logger` as `preview` does, and:

| Name       | Default | Description                                                                                          |
| ---------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `branches` | none    | The branches whose apps to remove. Without it, every branch with an app that Vercel no longer lists. |
| `dryRun`   | `false` | Say what would be removed, and remove nothing.                                                       |

It resolves with `{ dryRun, removed, failed }`: the branches whose app and variables were removed, and the ones that still have something, each with a `reason`. It rejects, having removed nothing, when it can't tell which branches are gone.

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

A Slack app sends its requests to one URL, and every preview deployment has its own. So `@vercel/slack-bolt` gives each preview branch its own Slack app. On a preview build, `vercel-slack build`:

1. Creates a Slack app for the branch from your manifest, or updates the one the branch has, with every URL pointed at the branch's deployment
2. Saves the app's credentials as environment variables of the branch's previews
3. Installs the app in your workspace, when it has a service token, and saves its bot token
4. Starts a new deployment when this one was built without those variables, so they take effect

In production and development builds it does nothing.

### Setup

#### 1. Add the CLI to your build script

```json
{
  "scripts": {
    "build": "vercel-slack build --cleanup && next build"
  }
}
```

`--cleanup` also deletes the apps of branches that are gone. A branch whose app can't be set up fails its build, with the reason and what to do about it in the build log. To build without the app instead, add `--allow-failure`.

#### 2. Create a `manifest.json`

Place a [Slack app manifest](https://docs.slack.dev/reference/app-manifest) in your project root, as `manifest.json`, `manifest.yaml` or `manifest.yml`. Its URLs can be production's or a placeholder's: each preview app gets them with the host of its branch's deployment.

```json
{
  "display_information": {
    "name": "My Slack App"
  },
  "features": {
    "bot_user": {
      "display_name": "My Slack Bot"
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

For a manifest somewhere else, pass `--manifest <path>` or set `MANIFEST_PATH`. The file is only read: nothing in your working tree changes.

#### 3. Configure environment variables

Add these to your Vercel project, for the Preview environment. Add them for Production too if production builds run `--cleanup`.

| Variable                     | Required | Description                                                                                                                                 |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLACK_CONFIGURATION_TOKEN`  | Yes      | App configuration token, which creates and deletes apps. Generate at https://api.slack.com/apps. Expires after 12 hours.                    |
| `SLACK_CONFIG_REFRESH_TOKEN` | No       | The refresh token generated with it. With it, builds [rotate](#token-rotation) the configuration token, so you set both once.               |
| `VERCEL_API_TOKEN`           | Yes      | Vercel token that can write the project's environment variables. Create at https://vercel.com/account/settings/tokens                       |
| `VERCEL_TEAM_ID`             | No       | The team's ID, for a team's project.                                                                                                        |
| `SLACK_SERVICE_TOKEN`        | No       | Service token that installs each app. Without it, someone installs each app once. See https://docs.slack.dev/authentication/tokens/#service |

The project also has to [expose system environment variables](https://vercel.com/docs/environment-variables/system-environment-variables), which is where the CLI reads the branch, the deployment and its URL from. It's on by default.

#### 4. Read the preview app's credentials

The CLI saves each preview app's credentials under fixed names, scoped to the branch: `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, and when it installs the app, `SLACK_BOT_TOKEN`. A variable scoped to a branch wins over one for every preview, so your app reads the same names everywhere.

The receiver reads `SLACK_SIGNING_SECRET` by default. With a `SLACK_SERVICE_TOKEN`, the CLI installs the app and saves its bot token, so a single-workspace app needs nothing else:

```typescript
const receiver = new VercelReceiver();

const app = new App({
  receiver,
  token: process.env.SLACK_BOT_TOKEN,
  deferInitialization: true,
});
```

For an [OAuth](#oauth-multi-workspace-apps) app, pass the client ID and secret under the names the CLI uses, and set `SLACK_STATE_SECRET` for the Preview environment yourself. The preview app's redirect URLs point at the branch's deployment, so installs come back to it:

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
git push
  └─ Vercel preview build
       └─ vercel-slack build
            ├─ Finds the branch's app among the project's variables
            ├─ Creates the app from the manifest, or updates it
            ├─ Saves a new app's credentials for the branch
            ├─ Installs the app (with SLACK_SERVICE_TOKEN), and saves its tokens
            └─ Starts a new deployment, if this one was built without what was saved
```

**The first build of a branch ends as Canceled.** A deployment gets its environment variables when it's created, so the build that creates the app belongs to a deployment that will never have the app's credentials. The CLI starts a new deployment that does, and cancels the one it's running in. Vercel shows that one as Canceled. It isn't a failure, and the deployment the CLI started is the one that goes live. The same happens on a later build that saves a token for the first time, like the one after a workspace admin approves the app. A deployment the CLI started never starts another, so this can't loop.

**The project's variables are the record.** A branch's `SLACK_APP_ID` variable says which app is the branch's, and the CLI reads it from the project on every build. It never takes the app from the build's own environment, where a `SLACK_APP_ID` could be one you set for every preview, or production's.

**A branch's app is only replaced when Slack says it's out of reach**: deleted, or owned by another Slack user. When Slack is down, rate limiting, or rejects the manifest, the build fails and the next one tries again. It never creates a second app for the branch.

One case it doesn't guard against: two builds of a branch that has no app yet, running at the same time, each create one. The branch keeps the app saved last and works with it. The other app is left in Slack, where you can delete it from your apps page. Pushing to a new branch twice before its first build reaches `vercel-slack build` is about the only way to get there.

**Each preview app is named after its branch**, like `My Slack App (feat-thing)` with the bot `My Slack Bot (feat-thing)`. Slack allows 35 characters for an app's name, so a long branch name is cut, and so is a long app name before the branch gets too short to tell apps apart. Characters Slack doesn't accept in a name become `-`. The app's page in Slack says which branch and commit it runs.

**Slack reaches protected previews with a bypass secret.** Every URL Slack calls carries the project's [Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation) secret. If the project has none, the CLI creates one. OAuth redirect URLs don't carry it: a browser follows those, signed in to Vercel.

#### Sensitive variables

The app's secrets (`SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` and its tokens) are saved as [Sensitive](https://vercel.com/docs/environment-variables/sensitive-environment-variables) variables: deployments get them, and nobody can read them back from Vercel. `SLACK_APP_ID` and `SLACK_CLIENT_ID` aren't secret, and are saved readable so the app can be found and deleted later.

With `--no-sensitive` the secrets are saved readable too, for `vercel env pull` and the like.

#### Token rotation

A configuration token expires after 12 hours. With `SLACK_CONFIG_REFRESH_TOKEN` set, a build that finds it expired trades the refresh token for a new pair and saves both over the stored ones, in the environments and with the type each has. You set the two once.

Slack accepts a refresh token once. When two builds start with the same expired token, one rotates it, and the other picks up the token the first one saved. That needs the configuration token to be readable, so store `SLACK_CONFIGURATION_TOKEN` and `SLACK_CONFIG_REFRESH_TOKEN` as regular variables, not Sensitive ones. As Sensitive variables they still rotate, but the second of two such builds fails, saying to redeploy, and a redeploy picks up the new tokens.

Use a pair of tokens in one Vercel project only. A second project would rotate them without the first knowing.

#### Installing

With a `SLACK_SERVICE_TOKEN`, every build installs the app, which also applies scopes you've added to the manifest. Create the service token as the same Slack user as the configuration token: an app is only visible to its owner.

Without one, the build that creates an app prints a link to install it. If your app reads `SLACK_BOT_TOKEN`, save the bot token Slack shows you as a Preview variable for the branch, then redeploy.

A workspace that requires admin approval for apps doesn't fail the build. The build says the app is waiting, and the one after the approval installs it and saves its token.

#### Cleanup

`vercel-slack build --cleanup`, or `vercel-slack cleanup` on its own, deletes the Slack app and the variables of every branch that has a preview app and that Vercel no longer lists as active. It runs in every environment, and a production build is a good place for it: a merge is usually when a branch is deleted, and it starts one.

Cleanup is careful, because it deletes things:

- It deletes a branch's app first and its `SLACK_APP_ID` last. Whatever fails on the way is found and tried again by the next cleanup.
- It never touches the branch being built, even one named with `--branch`.
- Vercel doesn't document the API that lists a project's active branches. So cleanup removes nothing unless the answer is a list of named branches that isn't empty, and in a preview build, includes the branch being built.
- As part of `build`, a cleanup that can't run is a warning. The build goes on.

To remove one branch's app whatever Vercel lists, name it: `vercel-slack cleanup --branch feat/thing`. `--dry-run` says what would be removed.

### CLI Reference

```
vercel-slack build [options]
```

Gives this preview deployment's branch its own Slack app. Does nothing in other deployments.

| Option              | Description                                                                            |
| ------------------- | -------------------------------------------------------------------------------------- |
| `--manifest <path>` | The app's manifest. Default: `MANIFEST_PATH`, then `manifest.json`, `.yaml` or `.yml`. |
| `--cleanup`         | First delete the apps of branches that are gone.                                       |
| `--allow-failure`   | Exit with 0 when the app can't be set up, so the build goes on without it.             |
| `--no-sensitive`    | Save the app's secrets so they can be read back from Vercel.                           |
| `--debug`           | Print every request and what caused each error. Never a token, a header or a body.     |

```
vercel-slack cleanup [options]
```

Deletes the Slack apps and variables of branches that are gone.

| Option               | Description                                                                       |
| -------------------- | --------------------------------------------------------------------------------- |
| `--branch <name...>` | The branches to clean up. Default: every branch Vercel no longer lists as active. |
| `--dry-run`          | Say what would be removed, and remove nothing.                                    |
| `--debug`            | Print every request and what caused each error.                                   |

Everything else comes from environment variables: the ones in [step 3](#3-configure-environment-variables), and the ones Vercel sets. Tokens are never flags, which would put them in the build log.

Setting `VERCEL_SLACK_DEBUG=1` does what `--debug` does, without changing the build script.

**Exit codes.** `build` exits with 0 when the branch has its app, or there was nothing to do, and with 1 when the app couldn't be set up. `cleanup` exits with 1 when it couldn't tell which branches are gone, or left a branch with something. Both exit with 1 for a command or option they don't have.

## Migrating from v1

v2 rebuilds `VercelReceiver` on Bolt's `HTTPReceiver`. Your listeners don't change, apart from the details in [Other changes](#other-changes): what changes is how you create the receiver and serve it. v2 needs `@slack/bolt` 4.7.3 or newer and Node.js 22.12 or newer.

The `preview` API and the `vercel-slack` CLI have no breaking changes: nothing in your build script, your environment variables or your calls to `preview` has to change. [Previews and the CLI](#previews-and-the-cli) lists what's new. The receiver no longer reads `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` itself, so see [Read the preview app's credentials](#4-read-the-preview-apps-credentials) if your previews use OAuth.

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

### Previews and the CLI

`preview` and `vercel-slack` are rewritten. Apps that v1 created keep working: v2 finds each by its branch's `SLACK_APP_ID` variable. Your Vercel environment variables keep their names. What changes:

**The build script.**

- A branch whose app can't be set up now fails its build, where v1 printed the error and exited with 0. Add `--allow-failure` for the old behavior.
- The flags that mirrored environment variables, like `--slack-configuration-token` and `--vercel-api-token`, are gone. Set the variables.
- `--manifest-path` is now `--manifest`.
- `--cleanup` now also runs in production builds, and `vercel-slack cleanup` runs it on its own.

**`preview`.** It takes one optional object, and every option defaults to the environment variable a Vercel build has, so `await preview()` is enough there. It also does what only the CLI did in v1: rotates an expired configuration token, and replaces a deployment that was built without the app's variables.

| v1                                           | v2                                                         |
| -------------------------------------------- | ---------------------------------------------------------- |
| `manifestPath`                               | `manifest`, a path or the manifest itself                  |
| `deploymentUrl`, `branchUrl`                 | `url`                                                      |
| `slackConfigurationToken`                    | `slackConfigToken`                                         |
| `vercelApiToken`                             | `vercelToken`                                              |
| `automationBypassSecret`                     | `bypassSecret`                                             |
| `commitSha`, `commitMessage`, `commitAuthor` | `commit: { sha, message, author }`                         |
| `slackAppId`                                 | Removed. The branch's app is found in the project.         |
| `preview(params, "cli")`                     | `preview({ logger })`                                      |
| `result.isNew`                               | `result.app.created`                                       |
| `result.installStatus`                       | `result.installation`                                      |
| `result.app.app_id`                          | `result.app.id`                                            |
| `result.app.credentials`                     | Removed. The secrets are saved to Vercel and not returned. |

**What it does.**

- The manifest file is no longer rewritten in place. Code that imported it to get the preview's URLs can build them from `VERCEL_BRANCH_URL`.
- The app's secrets are saved as Sensitive variables. Pass `--no-sensitive` or `sensitive: false` to read them back from Vercel, as in v1.
- An app is named after `display_information.name` and its bot after `features.bot_user.display_name`, where v1 named both after the bot. Existing preview apps are renamed on their next build.
- `settings.interactivity.message_menu_options_url` and `features.code_channels.slash_command_url` now point at the preview too.
- A branch never gets a second app because Slack was unreachable or rejected the manifest, a new app is deleted again when its credentials can't be saved, and cleanup deletes nothing when Vercel can't say which branches are active. v1 went wrong in each of these.

## Examples

Starter templates: [Next.js](https://github.com/vercel-labs/slack-bolt/tree/master/examples/nextjs), [Hono](https://github.com/vercel-labs/slack-bolt/tree/master/examples/hono), [Express](https://github.com/vercel-labs/slack-bolt/tree/master/examples/express), [TanStack Start](https://github.com/vercel-labs/slack-bolt/tree/master/examples/tanstack-start), [Nitro](https://github.com/vercel-labs/slack-bolt/tree/master/examples/nitro).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:

- Check the [Slack Bolt documentation](https://slack.dev/bolt-js/)
- Review [Vercel Functions documentation](https://vercel.com/docs/functions)
- [Open an issue](https://github.com/vercel-labs/slack-bolt/issues) in this repository
