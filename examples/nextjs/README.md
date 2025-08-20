# Slack Bolt with Next.js Template App

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)

This is a generic Bolt for JavaScript (TypeScript) template app used to build Slack apps on Next.js (App Router + Route Handlers).

Before getting started, make sure you have a development workspace where you have permissions to install apps. You can [create one here](https://slack.com/create) or use a [developer sandbox](https://api.slack.com/developer-program).

## Installation

#### Create a Slack App

1. Open https://api.slack.com/apps/new and choose "From an app manifest".
2. Choose the workspace you want to install the application to.
3. Copy the contents of [`manifest.json`](./manifest.json) into the text box that says "Paste your manifest code here" (JSON tab) and click Next.
4. Review the configuration and click Create.
5. Open the Install App tab on the left menu. Click Install to <Workspace_Name> and Allow. You'll be redirected to the App Configuration dashboard.
6. Copy the Bot User OAuth Token into your environment as `SLACK_BOT_TOKEN`.
7. Open the Basic Information tab and copy your Signing Secret into your environment as `SLACK_SIGNING_SECRET`.

#### Prepare for Local Development

1. In the terminal run `slack app link`.
2. Copy your App ID from the app you just created.
3. Select `Local` when prompted.
4. Open [`.slack/hooks.json`](./.slack/hooks.json) and add a `start` hook:
```json
{
  "hooks": {
    "get-hooks": "npx -q --no-install -p @slack/cli-hooks slack-cli-get-hooks",
    "start": "pnpm dev"
  }
}
```
5. Open [`.slack/config.json`](./.slack/config.json) and update your manifest source to `local`:
```json
{
  "manifest": {
    "source": "local"
  },
  "project_id": "<project-id-added-by-slack-cli>"
}
```
6. Start your local server with automatic tunneling using `pnpm dev:tunnel`. You can also use `slack run` if you do not want automatic tunneling and manifest updates. If prompted, select the workspace you'd like to grant access to. Select `yes` when asked "Update app settings with changes to the local manifest?".

7. Open your Slack workspace, add your Slackbot to a channel, and send `hi`. The bot should reply with `hi, how are you?`.

## Project Structure

### [`manifest.json`](./manifest.json)

[`manifest.json`](./manifest.json) defines your Slack app's configuration. With a manifest, you can create or update an app with a pre-defined configuration.

### [`src/bolt/app.ts`](./src/bolt/app.ts)

This is the Bolt app entry. It initializes `@vercel/slack-bolt`'s `VercelReceiver` and registers listeners.

### [`src/bolt/listeners`](./src/bolt/listeners)

Every incoming request is routed to a "listener". Inside this directory, we group each listener by Slack Platform feature, e.g. [`messages`](./src/bolt/listeners/messages) for message events.

### Route Handler: [`src/app/api/events/route.ts`](./src/app/api/events/route.ts)

This file defines your Next.js Route Handler that receives Slack events. Its pathname matches the URLs defined in your [`manifest.json`](./manifest.json). Next.js uses file-based routing for API handlers. Learn more in the Next.js docs: https://nextjs.org/docs/app/building-your-application/routing/route-handlers

## Scripts

- `pnpm dev`: Start Next.js in dev mode (Turbopack).
- `pnpm dev:tunnel`: Start dev with Slack CLI tunnel integration.
- `pnpm build`: Build the app (Turbopack).
- `pnpm start`: Start the Next.js server.

## Notes

- Turbopack requires `turbopack.root` to be an absolute path. This example derives it at runtime in `next.config.ts`.
- If you see a warning about `express` being externalized: `@slack/bolt` ships an Express receiver. Turbopack may analyze its static import even if you don't use it. Keeping `express` as a dependency or aliasing it to a stub resolves this during development.
