---
"@vercel/slack-bolt": patch
---

`vercel-slack build` now exits with code 1 when it can't set up the preview's Slack app, so `vercel-slack build && next build` stops instead of deploying a preview without its Slack credentials.
