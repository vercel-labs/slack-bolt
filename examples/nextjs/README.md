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
5. On the Install App tab, click Install to <Workspace_Name>. 
      - You will be redirected to the App Configuration dashboard
6. Copy the Bot User OAuth Token into your environment as `SLACK_BOT_TOKEN`
7. On the Basic Information tab, copy your Signing Secret into your environment as `SLACK_SIGNING_SECRET`

### Prepare for Local Development

1. Add your `NGROK_AUTH_TOKEN` to your `.env` file
    - You can get a free token [here](https://dashboard.ngrok.com/login?state=X1FFBj9sgtS9-oFK_2-h15Xcg0zHPjp_b9edWYrpGBVvIluUPEAarKRIjpp8ZeCHNTljTyreeslpG6n8anuSCFUkgIxwLypEGOa4Ci_cmnXYLhOfYogHWB6TzWBYUmhFLPW0XeGn789mFV_muomVd7QizkgwuYW8Vz2wW315YIK5UPywQaIGFKV8)
2. In the terminal run `slack app link`
3. If prompted `update the manifest source to remote` select `yes`
4. Copy your App ID from the app you just created
5. Select `Local` when prompted
6. Open [`.slack/config.json`](./.slack/config.json) and update your manifest source to `local`
```json
{
  "manifest": {
    "source": "local"
  },
  "project_id": "<project-id-added-by-slack-cli>"
}
```
7. Start your local server using `slack run`. If prompted, select the workspace you'd like to grant access to 
- Select `yes` if asked "Update app settings with changes to the local manifest?"
8. Open your Slack workspace, add your Slackbot to a channel, and send `hello`. Your app should reply with `world!`

## Deploy to Vercel

1. Create a new Slack app for production following the steps from above
2. Create a new Vercel project [here](https://vercel.com/new) and select this repo
2. Copy the Bot User OAuth Token into your Vercel environment variables as `SLACK_BOT_TOKEN`
3. On the Basic Information tab, copy your Signing Secret into your Vercel environment variables as `SLACK_SIGNING_SECRET`
4. When your deployment has finished, open your App Manifest from the Slack App Dashboard
5. Update the manifest so all the `request_url` and `url` fields use `https://<your-app-domain>/api/slack/events`
6. Click save and you will be prompted to verify the URL
7. Open your Slack workspace and add your app to any channel
    - _Note_: Make sure you add the production app, not the local app we setup earlier
8. Send `hello` and your app will respond with `world!`
9. Your app will now automatically build and deploy whenever you commit to your repo. More information [here](https://vercel.com/docs/git)


## Project Structure

### [`manifest.json`](./manifest.json)

[`manifest.json`](./manifest.json) defines your Slack app's configuration. With a manifest, you can create or update an app with a pre-defined configuration

### [`src/bolt/app.ts`](./src/bolt/app.ts)

This is the Bolt app entry. It initializes `@vercel/slack-bolt`'s `VercelReceiver` and registers listeners

### [`src/bolt/listeners`](./src/bolt/listeners)

Every incoming request is routed to a "listener". Inside this directory, we group each listener by Slack Platform feature, e.g. [`messages`](./src/bolt/listeners/messages) for message events

### Route Handler: [`src/app/api/slack/events/route.ts`](./src/app/api/slack/events/route.ts)

This file defines your Next.js Route Handler that receives Slack events. Its pathname matches the URLs defined in your [`manifest.json`](./manifest.json). Next.js uses file-based routing for API handlers. Learn more in the Next.js docs: https://nextjs.org/docs/app/building-your-application/routing/route-handlers

## Custom Scripts
- `pnpm dev:tunnel`: A helper script to automatically start your Slack app with ngrok tunneling

## Notes
- If you see a warning about `express` being externalized: `@slack/bolt` ships an Express receiver. Turbopack may analyze its static import even if you don't use it. Keeping `express` as a dependency or aliasing it to a stub resolves this during development.
