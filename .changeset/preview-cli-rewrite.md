---
"@vercel/slack-bolt": major
---

Rewrite `preview` and the `vercel-slack` CLI. Preview apps that v1 created keep working, and the environment variables keep their names. See "Migrating from v1 → Previews and the CLI" in the README.

**Breaking**

- `vercel-slack build` exits with code 1 when the branch's Slack app can't be set up, so `vercel-slack build && next build` stops there. Pass `--allow-failure` to exit with 0, as v1 did.
- The flags that mirrored environment variables, like `--slack-configuration-token`, are removed: set the variables. `--manifest-path` is now `--manifest`.
- `preview()` takes one optional object whose options default to a Vercel build's environment variables, so `await preview()` is enough in a build. Options are renamed (`manifest`, `url`, `vercelToken`, `slackConfigToken`, `bypassSecret`, `commit`), `slackAppId` and the `"cli"` argument are removed, and the result is `{ status, branch, app, installation, saved, deployment }`. It no longer returns the app's secrets.
- `preview()` now also rotates an expired configuration token and replaces a deployment that was built without the app's variables, which only the CLI did.
- The manifest file is read and never rewritten in place.
- The app's secrets are saved as Sensitive variables. Pass `--no-sensitive` or `sensitive: false` to keep them readable.
- A preview app is named after `display_information.name` and its bot after `features.bot_user.display_name`. v1 named both after the bot.

**New**

- `vercel-slack cleanup` and `cleanup()` delete the apps and variables of branches that are gone, from any environment. `--branch <name>` removes one branch's app, and `--dry-run` shows what would be removed. `build --cleanup` now also runs in production builds.
- A branch's app is found in the project's variables, not in the build's environment, so a `SLACK_APP_ID` or `SLACK_BOT_TOKEN` set for every environment is never mistaken for the branch's.
- `manifest.yaml` and `manifest.yml` are found without configuration, as `manifest.json` is.
- `preview({ manifest })` also takes the manifest itself, and `preview({ logger: console })` says what it's doing.

**Fixed**

- A branch never gets a second Slack app because Slack was unreachable, rate limiting or rejected the manifest. Its app is only replaced when Slack says it's deleted or owned by another user.
- A new app is deleted again when Vercel doesn't save its credentials.
- Cleanup deletes nothing unless Vercel's list of active branches is one it can trust, deletes a branch's app before its variables, and never touches the branch being built.
- An expired configuration token isn't rotated when Slack couldn't be reached to check it, and a build picks up the token another build rotated to.
- A deployment the CLI started never starts another, and the running one is only canceled once Vercel names the deployment that replaces it.
- A save to Vercel that collides with another build's is sent again, instead of failing the build.
- When Sensitive configuration tokens were rotated by another build, the error says to redeploy instead of to generate new tokens.
- Requests time out after 30 seconds and are retried when that's safe. Tokens and secrets are taken out of everything printed or thrown.
