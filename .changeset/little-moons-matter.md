---
"@vercel/slack-bolt": patch
---

Bug fix for empty error log when `createHandler` fails. Use `console.error` instead of `app.logger.error` which is undefined if `app.init` fails.
