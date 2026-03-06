---
"@vercel/slack-bolt": patch
---

Fix protection bypass secret generation to meet Vercel API requirements

The automation bypass secret generator was creating 64-character hex strings, but the Vercel API now requires exactly 32 characters without special characters. This change updates the secret generation to use 16 random bytes (resulting in 32 hex characters) instead of 32 random bytes (which resulted in 64 hex characters).

This fixes deployment failures with the error: "Invalid value for `generate.secret` provided. Must be a string with a length of 32 characters. Cannot include special characters."