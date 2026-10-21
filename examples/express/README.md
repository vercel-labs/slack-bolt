# Slack Bolt with Express Template

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fslack-bolt%2Ftree%2Fmaster%2Fexamples%2Fexpress&env=EXPRESS_SLACK_SIGNING_SECRET%2CEXPRESS_SLACK_CLIENT_ID%2CEXPRESS_SLACK_CLIENT_SECRET%2CSLACK_STATE_SECRET%2CTOKEN_ENCRYPTION_SECRET&envLink=https%3A%2F%2Fapi.slack.com%2Fapps&project-name=slack-bolt-with-express&repository-name=slack-bolt-with-express)

This is a generic Bolt for JavaScript (TypeScript) template app used to build Slack apps with Express

Before getting started, make sure you have a development workspace where you have permissions to install apps. You can use a [developer sandbox](https://api.slack.com/developer-program) or [create a workspace](https://slack.com/create)

## Installation

### Create your project

```bash
slack create my-slack-app --template vercel-labs/slack-bolt --subdir examples/express
cd my-slack-app
```

The [Slack CLI](https://docs.slack.dev/tools/slack-cli/) copies this example into `my-slack-app` and installs its dependencies with npm. Because the template isn't one of Slack's own samples, it asks you to confirm first.

### Create a Slack App

1. Open https://api.slack.com/apps/new and choose "From an app manifest"
2. Choose the workspace you want to use
3. Copy the contents of [`manifest.json`](./manifest.json) into the text box that says "Paste your manifest code here" (JSON tab) and click Next
4. Review the configuration and click Create, then upload [`app-icon.png`](./app-icon.png) as the App icon under Display Information on the Basic Information tab
5. On the Basic Information tab, copy your Client ID, Client Secret and Signing Secret into `.env.local` as `EXPRESS_SLACK_CLIENT_ID`, `EXPRESS_SLACK_CLIENT_SECRET` and `EXPRESS_SLACK_SIGNING_SECRET`. Start from the example file with `cp .env.example .env.local`
6. Set `SLACK_STATE_SECRET` and `TOKEN_ENCRYPTION_SECRET` to two different random strings, e.g. from `openssl rand -hex 32`. The first signs the OAuth state cookie; the second encrypts tokens in Redis
7. Create an [Upstash Redis](https://vercel.com/marketplace/upstash) database from the Vercel Marketplace. Installations are stored there. You connect it to your Vercel project when you deploy; to run locally, copy its `KV_REST_API_URL` and `KV_REST_API_TOKEN` from the database's page in the Vercel dashboard into `.env.local`

### Run locally

Slack sends requests to a public HTTPS URL, so expose your local server with a tunnel such as [ngrok](https://ngrok.com/docs/getting-started/).

1. Start the app with `npm run dev`. It serves http://localhost:3000
2. In another terminal, start a tunnel to port 3000, e.g. `ngrok http 3000`, and copy its `https://` URL
3. Open your App Manifest from the Slack App Dashboard and update it so all the `request_url`, `url` and `redirect_urls` fields use `https://<your-tunnel-domain>/api/slack/events`
4. Click save and you will be prompted to verify the URL
5. Open `https://<your-tunnel-domain>`, click Install and approve the app for your workspace
6. Open your Slack workspace, add your app to a channel, and send `hello`. Your app should reply with `world!`

## Deploy to Vercel

1. Create a new Slack app for production following the steps from above
2. Push your project to a Git repository, then import it as a new Vercel project [here](https://vercel.com/new). Before you click Deploy, add the environment variables from steps 5 and 6 of [Create a Slack App](#create-a-slack-app) under Environment Variables, with the production app's values and new random secrets. The app needs them from its first deployment
3. When the deployment has finished, connect your Upstash database to the project from its Storage tab, which adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Then redeploy from the Deployments tab so the app picks them up
4. Open your App Manifest from the Slack App Dashboard
5. Update the manifest so all the `request_url`, `url` and `redirect_urls` fields use `https://<your-app-domain>/api/slack/events`, where `<your-app-domain>` is your project's production domain, like `my-slack-app.vercel.app`. Use the domain listed under Domains on the project's page, not a deployment URL: those are protected by Vercel Authentication, so Slack can't reach them
6. Click save and you will be prompted to verify the URL
7. Open `https://<your-app-domain>`, click Install and approve the app for your workspace
8. Open your Slack workspace and add your app to any channel
    - _Note_: Make sure you add the production app, not the one you created to run locally
9. Send `hello` and your app will respond with `world!`
10. Your app will now automatically build and deploy whenever you commit to your repo. More information [here](https://vercel.com/docs/git)


## Project Structure

### [`manifest.json`](./manifest.json)

[`manifest.json`](./manifest.json) defines your Slack app's configuration. With a manifest, you can create or update an app with a pre-defined configuration

### [`src/bolt/app.ts`](./src/bolt/app.ts)

This is the Bolt app entry. It creates `@vercel/slack-bolt`'s `VercelReceiver` with Bolt's OAuth options, registers listeners, and exports the receiver

### [`src/bolt/listeners`](./src/bolt/listeners)

Every incoming request is routed to a "listener". Inside this directory, we group each listener by Slack Platform feature, e.g. [`messages`](./src/bolt/listeners/messages) for message events

### Express app: [`src/index.ts`](./src/index.ts)

This file creates your Express app and mounts the receiver's `fetch` handler, through `toNodeHandler` from `srvx/node`, at `/api/slack/events`. This one route receives every event, command and interaction from Slack, and serves the install page and OAuth callback. Its pathname matches the URLs defined in your [`manifest.json`](./manifest.json). The app also serves the home page at `/`. Vercel finds this file and deploys its default export as a Vercel Function; when you run it directly with `npm run dev`, it listens on `PORT` (3000 by default) and loads `.env` and `.env.local`. Learn more in the Vercel docs: https://vercel.com/docs/frameworks/backend/express

### Installation store: [`src/lib/installation-store.ts`](./src/lib/installation-store.ts)

Bolt calls this to save each workspace's installation and to look up its bot token for every request. It keeps installations in Upstash Redis, with tokens encrypted using `TOKEN_ENCRYPTION_SECRET`. The [`app_uninstalled`](./src/bolt/listeners/events/app-uninstalled.ts) and [`tokens_revoked`](./src/bolt/listeners/events/tokens-revoked.ts) listeners delete installations when a workspace removes the app or revokes its tokens, so the store never keeps dead credentials

## Notes
- Keep the Slack route before any body parser, like `express.json()` or `express.urlencoded()`. Bolt verifies Slack's signature against the raw request body, so a parser that runs first reads the body before Bolt can. Add parsers after the Slack route, or only on the routes that need them.
- This app is an ES module (`"type": "module"`), so relative imports end in `.js` and the `manifest.json` import uses `with { type: "json" }`. It can't be CommonJS: Vercel bundles it as CommonJS then, and `srvx` is ESM-only, so the function fails with `ERR_REQUIRE_ESM`.
