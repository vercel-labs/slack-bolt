---
"@vercel/slack-bolt": major
---

`vercel-slack build` now exits with code 1 when it fails, so `vercel-slack build && next build` stops instead of deploying a preview without its Slack credentials. Previews without access to the Slack and Vercel tokens, like those of pull requests from forks, now fail too; use `vercel-slack build || true` to keep building them.
