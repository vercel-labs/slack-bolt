# @vercel/slack-bolt

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
