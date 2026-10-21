---
"@vercel/slack-bolt": major
---

Rebuild `VercelReceiver` on Bolt's `HTTPReceiver`, and serve it with `receiver.fetch`, `receiver.POST` and `receiver.GET` from a route at any path. Listeners keep running with `waitUntil` after Slack is acknowledged.

Breaking changes, with upgrade steps in [Migrating from v1](https://github.com/vercel-labs/slack-bolt/tree/master/packages/slack-bolt#migrating-from-v1):

- `createHandler(app, receiver)` is removed. Export `POST` from your route with `export const { POST } = receiver`, or call `receiver.fetch(request)`.
- The `VercelHandler`, `BeforeProcessFn`, `ScopesResolver` and `VercelInstallerOptions` types are removed.
- `VercelReceiver` takes Bolt's `HTTPReceiver` options. `beforeProcess`, `ackTimeoutMs` and the `scopes` resolver function are removed, and `customPropertiesExtractor` receives Bolt's request instead of a `Request` and body.
- OAuth uses Bolt's own installer. `receiver.handleInstall` and `receiver.handleCallback` are replaced by `GET`, which serves the install page and the callback from one route or from separate ones. `clientId`, `clientSecret` and `stateSecret` are no longer read from `process.env`, and `installationStore` is required whenever `clientId` is set.
- `@slack/bolt` 4.7.3 or newer and Node.js 22.12 or newer are required.
