# @vercel/slack-bolt

## 1.4.0

### Minor Changes

- 73e5d03: Warn users about mismatched service and config tokens that lead to failed installations.

## 1.3.0

### Minor Changes

- cf718ab: Add support for .yml and .yaml files for Slack app manifest
- 0130804: Add support for auto-refresh of Slack Configuration tokens

## 1.2.5

### Patch Changes

- 995aae8: show warning when branch param is missing

## 1.2.4

### Patch Changes

- 75429bf: Add debug logs to fetch when --debug flag is passed

## 1.2.3

### Patch Changes

- c94b47c: Improve error handling when manifest.json is missing

  Previously, when manifest.json was missing, users would see a raw Node.js ENOENT error. This change adds early validation in the CLI build process to provide a clear, actionable error message with documentation link when the manifest file is not found.

## 1.2.2

### Patch Changes

- 952c839: Fix protection bypass secret generation to meet Vercel API requirements

  The automation bypass secret generator was creating 64-character hex strings, but the Vercel API now requires exactly 32 characters without special characters. This change updates the secret generation to use 16 random bytes (resulting in 32 hex characters) instead of 32 random bytes (which resulted in 64 hex characters).

  This fixes deployment failures with the error: "Invalid value for `generate.secret` provided. Must be a string with a length of 32 characters. Cannot include special characters."

## 1.2.1

### Patch Changes

- 2608ccb: fix readme location for monorepo

## 1.2.0

### Minor Changes

- 2506df8: Add preview deployment support with automatic Slack app provisioning

  - New `vercel-slack` CLI that creates and manages a dedicated Slack app per preview branch
  - Rewrites manifest URLs to point to the preview deployment URL
  - Stores app credentials as branch-scoped environment variables
  - Auto-installs the app when `SLACK_SERVICE_TOKEN` is set
  - `--cleanup` flag removes Slack apps and env vars for inactive preview branches
  - New `preview` function exported from `@vercel/slack-bolt/preview` for programmatic usage

## 1.1.0

### Minor Changes

- 3f992a0: Fix late ack() calls after timeout. Previously, if `ack()` was called after the 3-second timeout had already fired, it would silently succeed instead of throwing an error. Now it properly throws `ReceiverMultipleAckError`, making it clear to developers that their acknowledgment was too late.

### Patch Changes

- c098020: Fix init retry after transient failure. Previously, if `app.init()` failed, the rejected promise was cached and all subsequent requests would fail until a cold start. Now the handler resets and retries initialization on the next request, allowing recovery from transient failures like network blips.

## 1.0.4

### Patch Changes

- bf45f37: upgrade vitest to v4
- 17b49fe: bump vercel packages to latest version

## 1.0.3

### Patch Changes

- e7f758f: Bump package dependencies

## 1.0.2

### Patch Changes

- 3ade59d: Bump dependencies

## 1.0.1

### Patch Changes

- e75d60e: Bug fix for empty error log when `createHandler` fails. Use `console.error` instead of `app.logger.error` which is undefined if `app.init` fails.

## 1.0.0

### Major Changes

- 9a99e5b: Release v1 of the package.

## 0.1.5

### Patch Changes

- 1660169: Fix URLs in our package.json for repository and bugs.

## 0.1.4

### Patch Changes

- 40126ec: Added better testing and error logging. Fixed bug where no error was logged for ReceiverAuthenticityError

## 0.1.3

### Patch Changes

- 34bcf47: Remove double error logging when SignatureVerificationError is thrown.
- bf81350: Add coded errors that follow the Bolt pattern

## 0.1.2

### Patch Changes

- 31250d6: Fix a bug that caused Slack commands to fail when the ack() response body is empty.

## 0.1.1

### Patch Changes

- 5749d5a: Update dependencies

## 0.1.0

### Minor Changes

- d3c926d: Improved version

## 0.0.1

### Patch Changes

- 859945e: Initial release
