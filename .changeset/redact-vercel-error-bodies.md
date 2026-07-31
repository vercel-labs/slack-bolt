---
"@vercel/slack-bolt": patch
---

Prevent secret leakage by redacting raw Vercel API error response bodies from error messages on secret-sensitive endpoints (protection bypass and environment variable operations); only the Vercel error code is included.
