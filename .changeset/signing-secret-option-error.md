---
"@vercel/slack-bolt": patch
---

When `signingSecret` is passed but empty, the missing signing secret error now says to check the environment variable you pass it, instead of pointing at `SLACK_SIGNING_SECRET`.
