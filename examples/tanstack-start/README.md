# Slack Bolt with TanStack Start Template

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel-labs%2Fslack-bolt%2Ftree%2Fmaster%2Fexamples%2Ftanstack-start&env=TANSTACK_START_SLACK_SIGNING_SECRET%2CTANSTACK_START_SLACK_CLIENT_ID%2CTANSTACK_START_SLACK_CLIENT_SECRET%2CSLACK_STATE_SECRET%2CTOKEN_ENCRYPTION_SECRET&envDescription=Copy%20the%20signing%20secret%2C%20client%20ID%20and%20client%20secret%20from%20your%20Slack%20app's%20Basic%20Information%20page.%20Set%20SLACK_STATE_SECRET%20and%20TOKEN_ENCRYPTION_SECRET%20to%20two%20different%20random%20strings%2C%20e.g.%20from%20openssl%20rand%20-hex%2032.&envLink=https%3A%2F%2Fapi.slack.com%2Fapps&project-name=slack-bolt-with-tanstack-start&repository-name=slack-bolt-with-tanstack-start&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-kv%22%2C%22protocol%22%3A%22storage%22%7D%5D)

This is a generic Bolt for JavaScript (TypeScript) template app used to build Slack apps with TanStack Start

Before getting started, make sure you have Node.js 22.19 or newer and a development workspace where you have permissions to install apps. You can use a [developer sandbox](https://api.slack.com/developer-program) or [create a workspace](https://slack.com/create)

## Installation

### Create your project

```bash
slack create my-slack-app --template vercel-labs/slack-bolt --subdir examples/tanstack-start
cd my-slack-app
```

The [Slack CLI](https://docs.slack.dev/tools/slack-cli/) copies this example into `my-slack-app` and installs its dependencies with npm. Because the template isn't one of Slack's own samples, it asks you to confirm first.

### Create a Slack App

1. Open https://api.slack.com/apps/new and choose "From an app manifest"
2. Choose the workspace you want to use
3. Copy the contents of [`manifest.json`](./manifest.json) into the text box that says "Paste your manifest code here" (JSON tab) and click Next. Its URLs point at `example.com` for now; you replace them with your app's URL when you run it locally or deploy it
4. Review the configuration and click Create, then upload [`app-icon.png`](./app-icon.png) as the App icon under Display Information on the Basic Information tab
    - _Note_: The manifest turns on token rotation, which can't be turned off once it's on. Bot tokens then expire every 12 hours, and Bolt refreshes them through the installation store
5. On the Basic Information tab, copy your Client ID, Client Secret and Signing Secret into `.env.local` as `TANSTACK_START_SLACK_CLIENT_ID`, `TANSTACK_START_SLACK_CLIENT_SECRET` and `TANSTACK_START_SLACK_SIGNING_SECRET`. Start from the example file with `cp .env.example .env.local`
    - _Note_: The `TANSTACK_START_` prefix is only there so the [slack-bolt repository](https://github.com/vercel-labs/slack-bolt) can deploy all its examples to one Vercel project. To drop it, rename the variables in [`src/bolt/app.ts`](./src/bolt/app.ts) and [`src/lib/installation-store.ts`](./src/lib/installation-store.ts). The receiver reads `SLACK_SIGNING_SECRET` by default, so with that name you can remove the `signingSecret` option
6. Set `SLACK_STATE_SECRET` and `TOKEN_ENCRYPTION_SECRET` to two different random strings, e.g. from `openssl rand -hex 32`. The first signs the OAuth state cookie; the second encrypts tokens in Redis
7. Create an [Upstash Redis](https://vercel.com/marketplace/upstash) database from the Vercel Marketplace. Installations are stored there, and your development and production apps can share it. You connect it to your Vercel project when you deploy; to run locally, copy its `KV_REST_API_URL` and `KV_REST_API_TOKEN` from the database's page in the Vercel dashboard into `.env.local`

### Run locally

Slack sends requests to a public HTTPS URL, so expose your local server with a tunnel such as [ngrok](https://ngrok.com/docs/getting-started/).

1. Start the app with `npm run dev`. It serves http://localhost:3000
2. In another terminal, start a tunnel to port 3000, e.g. `ngrok http 3000`, and copy its `https://` URL. Vite's dev server only answers hosts it knows: [`vite.config.ts`](./vite.config.ts) allows ngrok's domains, so add yours to `server.allowedHosts` if you use another tunnel
3. Open your App Manifest from the Slack App Dashboard and update it so all the `request_url`, `url` and `redirect_urls` fields use `https://<your-tunnel-domain>/api/slack/events`
4. Click save and you will be prompted to verify the URL
5. Open `https://<your-tunnel-domain>`, click Install and approve the app for your workspace
6. Open your Slack workspace, add your app to a public channel, and send `hello`. Your app should reply with `world!`

## Deploy to Vercel

The Deploy button at the top of this page replaces steps 2 and 3: it copies this example to a new repository, asks for the same environment variables, and creates an Upstash database and connects it for you. Create the production Slack app first, then continue from step 4.

1. Create a new Slack app for production following the steps from above
2. Push your project to a Git repository, then import it as a new Vercel project [here](https://vercel.com/new). Before you click Deploy, add the environment variables from steps 5 and 6 of [Create a Slack App](#create-a-slack-app) under Environment Variables, with the production app's values and new random secrets. The app needs them from its first deployment
3. When the deployment has finished, open your Upstash database under Storage in the Vercel dashboard and click Connect Project to connect it to this project. Leave Custom Prefix empty, so it adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Then redeploy from the Deployments tab so the app picks them up
4. Open your App Manifest from the Slack App Dashboard
5. Update the manifest so all the `request_url`, `url` and `redirect_urls` fields use `https://<your-app-domain>/api/slack/events`, where `<your-app-domain>` is your project's production domain, like `my-slack-app.vercel.app`
    - _Note_: Use the domain listed under Domains on the project's page, not a deployment URL. With the default Deployment Protection, Vercel Authentication protects deployment URLs, so Slack can't reach them
6. Click save and you will be prompted to verify the URL
7. Open `https://<your-app-domain>`, click Install and approve the app for your workspace
8. Open your Slack workspace and add your app to a public channel
    - _Note_: Make sure you add the production app, not the one you created to run locally
9. Send `hello` and your app will respond with `world!`
10. Your app will now automatically build and deploy whenever you commit to your repo. More information [here](https://vercel.com/docs/git)


## Project Structure

### [`manifest.json`](./manifest.json)

[`manifest.json`](./manifest.json) defines your Slack app's configuration. With a manifest, you can create or update an app with a pre-defined configuration

### [`src/bolt/app.ts`](./src/bolt/app.ts)

This is the Bolt app entry. It creates `@vercel/slack-bolt`'s `VercelReceiver` with Bolt's OAuth options, registers listeners, and exports the receiver's `GET` and `POST` handlers

### [`src/bolt/listeners`](./src/bolt/listeners)

Every incoming request is routed to a "listener". Inside this directory, we group each listener by Slack Platform feature, e.g. [`messages`](./src/bolt/listeners/messages) for message events

### Server Route: [`src/routes/api/slack/events.ts`](./src/routes/api/slack/events.ts)

This file defines your TanStack Start server route. Its `GET` and `POST` handlers pass the request to `GET` and `POST` from [`src/bolt/app.ts`](./src/bolt/app.ts), so this one route receives every event, command and interaction from Slack, and serves the install page and OAuth callback. Its pathname matches the URLs defined in your [`manifest.json`](./manifest.json). TanStack Start uses file-based routing for server routes. Learn more in the TanStack Start docs: https://tanstack.com/start/latest/docs/framework/react/guide/server-routes

### Installation store: [`src/lib/installation-store.ts`](./src/lib/installation-store.ts)

Bolt calls this to save each workspace's installation and to look up its bot token for every request. It keeps installations in Upstash Redis, with tokens encrypted using `TOKEN_ENCRYPTION_SECRET`. The [`app_uninstalled`](./src/bolt/listeners/events/app-uninstalled.ts) and [`tokens_revoked`](./src/bolt/listeners/events/tokens-revoked.ts) listeners delete installations when a workspace removes the app or revokes its tokens, so the store never keeps dead credentials

## Notes
- Bolt verifies Slack's signature against the raw request body, so the server route hands the untouched `request` to the receiver. Don't add middleware to that route that reads the body first.
- [`vite.config.ts`](./vite.config.ts) adds [Nitro](https://v3.nitro.build/)'s Vite plugin, which builds the app for Vercel when it runs there and for Node.js (`npm start`) everywhere else. Learn more in the Vercel docs: https://vercel.com/docs/frameworks/full-stack/tanstack-start
- If you see `MODULE_LEVEL_DIRECTIVE` warnings about `"use client"` in `@tanstack/react-router` during `npm run build`: Nitro bundles the server and drops those directives, which only matter for React Server Components. They're safe to ignore.
