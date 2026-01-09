---
"@vercel/slack-bolt": patch
---

Fix init retry after transient failure. Previously, if `app.init()` failed, the rejected promise was cached and all subsequent requests would fail until a cold start. Now the handler resets and retries initialization on the next request, allowing recovery from transient failures like network blips.
