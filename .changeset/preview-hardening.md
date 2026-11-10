---
"@vercel/slack-bolt": patch
---

Harden preview deployments, and check them against the v2 receiver:

- `vercel-slack build` and `preview` no longer create a second Slack app for a branch when Slack is unreachable, rate limiting or failing while they update the branch's existing app. The build fails instead, and the next one retries.
- `preview` rejects when Vercel saves only some of the app's credentials, naming the variables it refused, where it resolved with a preview missing them.
- `--cleanup` also deletes a stale branch's `SLACK_APP_LEVEL_TOKEN` and `SLACK_USER_TOKEN`.
- The manifest's `settings.interactivity.message_menu_options_url` is rewritten to the preview like the other request URLs, so external selects load their options from the preview, not production.
- `--debug` no longer prints the deployment protection bypass secret, which sat unredacted in manifest request URLs, request URLs and Vercel's `protectionBypass` map. It redacts `cookie` and `x-vercel-protection-bypass` headers too.
- When the configuration token was rotated but the new tokens couldn't be saved to Vercel, the error says so, where it blamed the refresh token. Errors also print what caused them, and each problem Slack found in a manifest.
- `PreviewResult.installStatus` is typed as its possible values, not `string`.
