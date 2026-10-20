# Slack Bolt with Hono Template

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fslack-bolt%2Ftree%2Fmaster%2Fexamples%2Fhono&env=SLACK_SIGNING_SECRET%2CSLACK_CLIENT_ID%2CSLACK_CLIENT_SECRET%2CSLACK_STATE_SECRET%2CTOKEN_ENCRYPTION_SECRET&envLink=https%3A%2F%2Fapi.slack.com%2Fapps&project-name=slack-bolt-with-hono&repository-name=slack-bolt-with-hono)

This is a generic Bolt for JavaScript (TypeScript) template app used to build Slack apps with Hono

Before getting started, make sure you have a development workspace where you have permissions to install apps. You can use a [developer sandbox](https://api.slack.com/developer-program) or [create a workspace](https://slack.com/create)

## Installation

### Clone and install dependencies
```bash
git clone https://github.com/vercel-labs/slack-bolt.git && cd slack-bolt/examples/hono && pnpm install
```

### Create a Slack App

1. Open https://api.slack.com/apps/new and choose "From an app manifest"
2. Choose the workspace you want to use
3. Copy the contents of [`manifest.json`](./manifest.json) into the text box that says "Paste your manifest code here" (JSON tab) and click Next
4. Review the configuration and click Create
5. On the Basic Information tab, copy your Client ID, Client Secret and Signing Secret into your environment as `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET`
6. Set `SLACK_STATE_SECRET` and `TOKEN_ENCRYPTION_SECRET` to two different random strings, e.g. from `openssl rand -hex 32`. The first signs the OAuth state cookie; the second encrypts tokens in Redis
7. Add [Upstash Redis](https://vercel.com/marketplace/upstash) to your Vercel project, which sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Installations are stored there

### Prepare for Local Development

1. In the terminal run `slack app link`
2. If prompted `update the manifest source to remote` select `yes`
3. Copy your App ID from the app you just created
4. Select `Local` when prompted
5. Open [`.slack/config.json`](./.slack/config.json) and update your manifest source to `local`
```json
{
  "manifest": {
    "source": "local"
  },
  "project_id": "<project-id-added-by-slack-cli>"
}
```
6. Start your local server using `slack run`. If prompted, select the workspace you'd like to grant access to 
- Select `yes` if asked "Update app settings with changes to the local manifest?"
7. Open your Slack workspace, add your Slackbot to a channel, and send `hello`. Your app should reply with `world!`

## Deploy to Vercel

1. Create a new Slack app for production following the steps from above
2. Create a new Vercel project [here](https://vercel.com/new) and select this repo
2. Add the environment variables from [Create a Slack App](#create-a-slack-app) to your Vercel project
3. When your deployment has finished, open your App Manifest from the Slack App Dashboard
4. Update the manifest so all the `request_url`, `url` and `redirect_urls` fields use `https://<your-app-domain>/api/slack/events`
5. Click save and you will be prompted to verify the URL
6. Open `https://<your-app-domain>`, click Install and approve the app for your workspace
7. Open your Slack workspace and add your app to any channel
    - _Note_: Make sure you add the production app, not the local app we setup earlier
8. Send `hello` and your app will respond with `world!`
9. Your app will now automatically build and deploy whenever you commit to your repo. More information [here](https://vercel.com/docs/git)


## Project Structure

### [`manifest.json`](./manifest.json)

[`manifest.json`](./manifest.json) defines your Slack app's configuration. With a manifest, you can create or update an app with a pre-defined configuration

### [`src/bolt/app.ts`](./src/bolt/app.ts)

This is the Bolt app entry. It creates `@vercel/slack-bolt`'s `VercelReceiver` with Bolt's OAuth options, registers listeners, and exports the receiver

### [`src/bolt/listeners`](./src/bolt/listeners)

Every incoming request is routed to a "listener". Inside this directory, we group each listener by Slack Platform feature, e.g. [`messages`](./src/bolt/listeners/messages) for message events

### Hono app: [`src/index.ts`](./src/index.ts)

This file creates your Hono app and exports it as the default export, which Vercel deploys as a Vercel Function with zero configuration. Its `/api/slack/events` route passes the raw request to the receiver's `fetch`, so this one route receives every event, command and interaction from Slack, and serves the install page and OAuth callback. Its pathname matches the URLs defined in your [`manifest.json`](./manifest.json). Don't add middleware that reads the request body before it: Bolt needs the raw body to verify Slack's signature. The `/` route is the home page with the Install link. Run `pnpm dev` to serve the app locally at http://localhost:3000 with [srvx](https://srvx.h3.dev), which loads `.env` and `.env.local`. Learn more in the Vercel docs: https://vercel.com/docs/frameworks/backend/hono

### Installation store: [`src/lib/installation-store.ts`](./src/lib/installation-store.ts)

Bolt calls this to save each workspace's installation and to look up its bot token for every request. It keeps installations in Upstash Redis, with tokens encrypted using `TOKEN_ENCRYPTION_SECRET`. The [`app_uninstalled`](./src/bolt/listeners/events/app-uninstalled.ts) and [`tokens_revoked`](./src/bolt/listeners/events/tokens-revoked.ts) listeners delete installations when a workspace removes the app or revokes its tokens, so the store never keeps dead credentials

## Notes
- This app is an ES module (`"type": "module"`), so relative imports end in `.js` and the `manifest.json` import uses `with { type: "json" }`. It can't be CommonJS: Vercel bundles it as CommonJS then, and `srvx`, which `@vercel/slack-bolt` uses, is ESM-only, so the function fails with `ERR_REQUIRE_ESM`.
