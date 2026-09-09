---
"@vercel/slack-bolt": minor
---

Support `@slack/bolt` 5.x by widening the peer dependency range to `^4.4.0 || ^5.0.0`.

No source changes were needed. The receiver only depends on Bolt symbols that are unchanged in 5.x (`verifySlackRequest`, `ReceiverAuthenticityError`, `ReceiverMultipleAckError` and the `Receiver` interface), and Bolt 5 continues to consume the receiver's OAuth `installer` the same way. CI now runs the full suite against both Bolt 4 and Bolt 5.

Things to know when upgrading to Bolt 5:

- If you previously forced Bolt 5 with `--legacy-peer-deps`, remove it. That flag also skips `@slack/socket-mode`'s `undici` peer, which makes `require('@slack/bolt')` fail with `Cannot find module 'undici'`.
- If you do not list `@slack/bolt` in your own `package.json` and rely on peer auto-install, pin it explicitly. The widened range means a fresh install now resolves to Bolt 5.
- The OAuth installer still uses `@slack/oauth` 3.x internally (Bolt 5 ships 4.x), so Bolt 5 apps carry both. This is harmless: the shared `Installation`, `InstallationStore` and `Logger` types are structurally identical across the two versions. Two consequences:
  - `installerOptions.clientOptions` follows `@slack/web-api` 7's `WebClientOptions` (`agent`, `tls`), not 8's (`fetch`). A custom `fetch` passed to the Bolt `App` is not applied to the OAuth token exchange.
  - Errors passed to `installerOptions.callbackOptions.failure` are `@slack/oauth` 3.x instances. Check `error.code` rather than using `instanceof` against classes imported from `@slack/oauth`.

Moving the installer to `@slack/oauth` 4.x is planned for the next major, when Bolt 4 support is dropped.
