---
"@vercel/slack-bolt": minor
---

Add preview deployment support with automatic Slack app provisioning

- New `vercel-slack` CLI that creates and manages a dedicated Slack app per preview branch
- Rewrites manifest URLs to point to the preview deployment URL
- Stores app credentials as branch-scoped environment variables
- Auto-installs the app when `SLACK_SERVICE_TOKEN` is set
- `--cleanup` flag removes Slack apps and env vars for inactive preview branches
- New `preview` function exported from `@vercel/slack-bolt/preview` for programmatic usage
