---
"@vercel/slack-bolt": patch
---

Improve error handling when manifest.json is missing

Previously, when manifest.json was missing, users would see a raw Node.js ENOENT error. This change adds early validation in the CLI build process to provide a clear, actionable error message with documentation link when the manifest file is not found.