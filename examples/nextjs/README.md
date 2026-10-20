# Slack Bolt with Next.js Template

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?demo-description=This%20is%20a%20generic%20Bolt%20for%20JavaScript%20(TypeScript)%20template%20app%20used%20to%20build%20out%20Slack%20apps%20with%20Next.js&demo-image=%2F%2Fimages.ctfassets.net%2Fe5382hct74si%2F1BL852bc5uyQQuswDrLggh%2F7f91aaaebace15775b982649b153354a%2FFrame.png&demo-title=Slack%20Bolt%20with%20Next.js&demo-url=https%3A%2F%2Fgithub.com%2Fvercel-partner-solutions%2Fslack-bolt-with-nextjs&env=SLACK_SIGNING_SECRET%2CSLACK_BOT_TOKEN&envDescription=These%20environment%20variables%20are%20required%20to%20deploy%20your%20Slack%20app%20to%20Vercel&envLink=https%3A%2F%2Fapi.slack.com%2Fapps&from=templates&project-name=Slack%20Bolt%20with%20Next.js&project-names=Comma%20separated%20list%20of%20project%20names%2Cto%20match%20the%20root-directories&repository-name=slack-bolt-with-next-js&repository-url=https%3A%2F%2Fgithub.com%2Fvercel-partner-solutions%2Fslack-bolt-with-nextjs&root-directories=List%20of%20directory%20paths%20for%20the%20directories%20to%20clone%20into%20projects&skippable-integrations=1&teamSlug=vercel-partnerships)

This is a generic Bolt for JavaScript (TypeScript) template app used to build Slack apps with Next.js

Before getting started, make sure you have a development workspace where you have permissions to install apps. You can use a [developer sandbox](https://api.slack.com/developer-program) or [create a workspace](https://slack.com/create)

## Installation

### Clone and install dependencies
```bash
git clone https://github.com/vercel-partner-solutions/slack-bolt-with-next.git && cd slack-bolt-with-next && pnpm install
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

This is the Bolt app entry. It creates `@vercel/slack-bolt/v2`'s `VercelReceiver` with Bolt's OAuth options, registers listeners, and exports the receiver's `GET` and `POST` handlers

### [`src/bolt/listeners`](./src/bolt/listeners)

Every incoming request is routed to a "listener". Inside this directory, we group each listener by Slack Platform feature, e.g. [`messages`](./src/bolt/listeners/messages) for message events

### Route Handler: [`src/app/api/slack/events/route.ts`](./src/app/api/slack/events/route.ts)

This file re-exports `GET` and `POST` from [`src/bolt/app.ts`](./src/bolt/app.ts), so this one route receives every event, command and interaction from Slack, and serves the install page and OAuth callback. Its pathname matches the URLs defined in your [`manifest.json`](./manifest.json). Next.js uses file-based routing for API handlers. Learn more in the Next.js docs: https://nextjs.org/docs/app/building-your-application/routing/route-handlers

### Installation store: [`src/lib/installation-store.ts`](./src/lib/installation-store.ts)

Bolt calls this to save each workspace's installation and to look up its bot token for every request. It keeps installations in Upstash Redis, with tokens encrypted using `TOKEN_ENCRYPTION_SECRET`

## Notes
- If you see a warning about `express` being externalized: `@slack/bolt` ships an Express receiver. Turbopack may analyze its static import even if you don't use it. Keeping `express` as a dependency or aliasing it to a stub resolves this during development.
