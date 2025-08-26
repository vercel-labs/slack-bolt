---
"@vercel/slack-bolt": patch
---

Fix empty error log for when createHandler fails. We incorrectly used the app.logger which was not available if app.init failed.
