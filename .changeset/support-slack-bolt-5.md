---
"@vercel/slack-bolt": major
---

Support `@slack/bolt` 5.x.

`@vercel/slack-bolt` 2.x requires `@slack/bolt` `^5.0.0`. If you are still on `@slack/bolt` 4.x, stay on `@vercel/slack-bolt` 1.x.

Breaking changes carried over from the Slack SDK upgrade:

- `@slack/oauth` is bumped to 4.x and `@slack/logger` to 5.x. `@slack/oauth` 4 uses `@slack/web-api` 8, which removed `clientOptions.agent`, `clientOptions.tls`, `clientOptions.requestInterceptor`, `clientOptions.adapter`, and `clientOptions.attachOriginalToWebAPIRequestError`. If you passed any of these via `installerOptions.clientOptions`, use `installerOptions.clientOptions.fetch` to supply a custom `fetch` implementation instead (the original transport error is now always available as `error.cause` on `WebAPIRequestError`).
- `@slack/oauth` 4 error classes now extend `SlackOAuthError`, and `error.name` reflects the concrete class name (for example `InstallerInitializationError`) rather than the generic `'Error'`. Update any code that branches on `error.name`; `instanceof` checks and `error.code` are unaffected.
- `@slack/bolt` 5 itself removes `WorkflowStep`, replaces `axios` with `fetch`, and makes `respond()` throw a `RespondError` on non-2xx responses. See the [Bolt 5.0.0 release notes](https://github.com/slackapi/bolt-js/releases/tag/v5.0.0) for the full list.

The Node.js requirement is unchanged (`>=22`).
