---
"@vercel/slack-bolt": patch
---

Reject query strings and fragments in `redirectUri` with a clear initialization error before passing it to Bolt, and document the callback URL restriction.
