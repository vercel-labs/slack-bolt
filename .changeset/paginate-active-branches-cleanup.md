---
"@vercel/slack-bolt": patch
---

Paginate through all active branches during orphan cleanup so live branches beyond the first 100 are never misclassified as orphaned and their Slack apps deleted
