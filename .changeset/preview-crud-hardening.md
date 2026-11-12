---
"@vercel/slack-bolt": patch
---

Keep track of every Slack app the preview flow creates, found by running `vercel-slack build` against Slack and Vercel:

- `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` are saved as Sensitive environment variables, so Vercel never shows their values again.
- `--cleanup` deletes a stale branch's variables only once its app is deleted or Slack says it's gone, and `SLACK_APP_ID` last. It used to delete them when Slack couldn't be reached or refused, which left an app nothing could find again. It also recognises an app that was already deleted, which Slack answers with `no_permission`.
- `vercel-slack build` and `preview` save an app's tokens on any run that installs it, not only the run that created it, so a branch whose first install didn't go through gets its `SLACK_BOT_TOKEN` once it does. The CLI then replaces the deployment, as it does for a new app, and a deployment it started doesn't start another.
- When Vercel doesn't save a new app's credentials, the app is deleted again, so the next build doesn't create a second one next to it.
- When Slack rejects the manifest while updating a branch's app, the build fails with Slack's problems, where it created a second app.
- When Slack doesn't install the app, the build prints Slack's error code, like `service_limits_exceeded` for a workspace that has reached its app limit, where it said "Unknown error". `PreviewResult.installError` has the code.
- Branch names with characters Slack rejects in an app name, like `+`, `@`, `#` or accented letters, no longer fail the build.
- A build that starts with an expired configuration token uses the one another build already rotated, where it rotated again with a refresh token that was already used. Rotated tokens are saved to the environments, and with the type, the old ones had, where they were copied to every environment. The token isn't rotated when Slack couldn't be reached to check it.
- A manifest that isn't valid JSON or YAML, or has no `display_information.name`, fails before anything is created, with the file's path. An empty `MANIFEST_PATH` means `manifest.json`.
- README: the example manifest is one Slack accepts, and the version flag is `-V`.
