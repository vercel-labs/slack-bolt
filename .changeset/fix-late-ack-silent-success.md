---
"@vercel/slack-bolt": minor
---

Fix late ack() calls after timeout. Previously, if `ack()` was called after the 3-second timeout had already fired, it would silently succeed instead of throwing an error. Now it properly throws `ReceiverMultipleAckError`, making it clear to developers that their acknowledgment was too late.
