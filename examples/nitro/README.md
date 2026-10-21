# Slack Bolt with Nitro Template

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fslack-bolt%2Ftree%2Fmaster%2Fexamples%2Fnitro&env=NITRO_SLACK_SIGNING_SECRET%2CNITRO_SLACK_CLIENT_ID%2CNITRO_SLACK_CLIENT_SECRET%2CSLACK_STATE_SECRET%2CTOKEN_ENCRYPTION_SECRET&envLink=https%3A%2F%2Fapi.slack.com%2Fapps&project-name=slack-bolt-with-nitro&repository-name=slack-bolt-with-nitro)

This is a generic Bolt for JavaScript (TypeScript) template app used to build Slack apps with Nitro

Before getting started, make sure you have a development workspace where you have permissions to install apps. You can use a [developer sandbox](https://api.slack.com/developer-program) or [create a workspace](https://slack.com/create)

## Installation

### Create your project

```bash
slack create my-slack-app --template vercel-labs/slack-bolt --subdir examples/nitro
cd my-slack-app
```

The [Slack CLI](https://docs.slack.dev/tools/slack-cli/) copies this example into `my-slack-app` and installs its dependencies with npm. Because the template isn't one of Slack's own samples, it asks you to confirm first.

### Create a Slack App

1. Open https://api.slack.com/apps/new and choose "From an app manifest"
2. Choose the workspace you want to use
3. Copy the contents of [`manifest.json`](./manifest.json) into the text box that says "Paste your manifest code here" (JSON tab) and click Next. Its URLs point at `example.com` for now; you replace them with your app's URL when you run it locally or deploy it
4. Review the configuration and click Create, then upload [`app-icon.png`](./app-icon.png) as the App icon under Display Information on the Basic Information tab
5. On the Basic Information tab, copy your Client ID, Client Secret and Signing Secret into `.env.local` as `NITRO_SLACK_CLIENT_ID`, `NITRO_SLACK_CLIENT_SECRET` and `NITRO_SLACK_SIGNING_SECRET`. Start from the example file with `cp .env.example .env.local`
6. Set `SLACK_STATE_SECRET` and `TOKEN_ENCRYPTION_SECRET` to two different random strings, e.g. from `openssl rand -hex 32`. The first signs the OAuth state cookie; the second encrypts tokens in Redis
7. Add [Upstash Redis](https://vercel.com/marketplace/upstash) to your Vercel project, which sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Installations are stored there. To run locally, copy both into `.env.local` too

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
2. Push your project to a Git repository, then create a new Vercel project [here](https://vercel.com/new) and import it
3. Add the environment variables from [Create a Slack App](#create-a-slack-app) to your Vercel project
4. When your deployment has finished, open your App Manifest from the Slack App Dashboard
5. Update the manifest so all the `request_url`, `url` and `redirect_urls` fields use `https://<your-app-domain>/api/slack/events`
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

### Route: [`src/routes/api/slack/events.ts`](./src/routes/api/slack/events.ts)

This file defines your Nitro route handler. It passes each request to the receiver's `fetch`, so this one route receives every event, command and interaction from Slack, and serves the install page and OAuth callback. Its pathname matches the URLs defined in your [`manifest.json`](./manifest.json). Nitro uses file-based routing in the `routes` directory of its server directory, which [`nitro.config.ts`](./nitro.config.ts) sets to `src`. Learn more in the Nitro docs: https://nitro.build/docs/routing

### Installation store: [`src/lib/installation-store.ts`](./src/lib/installation-store.ts)

Bolt calls this to save each workspace's installation and to look up its bot token for every request. It keeps installations in Upstash Redis, with tokens encrypted using `TOKEN_ENCRYPTION_SECRET`. The [`app_uninstalled`](./src/bolt/listeners/events/app-uninstalled.ts) and [`tokens_revoked`](./src/bolt/listeners/events/tokens-revoked.ts) listeners delete installations when a workspace removes the app or revokes its tokens, so the store never keeps dead credentials

## Notes
- Nitro's top-level `api` directory isn't compatible with Vercel, so the route lives in `src/routes/api` instead. Learn more in the Nitro docs: https://nitro.build/deploy/providers/vercel
