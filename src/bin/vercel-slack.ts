#!/usr/bin/env node
import fs from "node:fs";
import { log } from "../internal/logger.js";
import { setupSlackPreview } from "../preview.js";

declare const __PKG_VERSION__: string;

// Load .env.local if it exists (for local development).
// On Vercel, env vars are injected by the platform so this is a no-op.
if (fs.existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

// Gracefully handle termination signals (e.g. Docker, CI cancellation)
process.on("SIGTERM", () => {
  process.exit(0);
});
process.on("SIGINT", () => {
  process.exit(0);
});

const HELP = `
Usage: vercel-slack <command> [options]

Commands:
  build   Create or update the Slack app for the current preview branch

Options:
  --manifest <path>              Path to manifest.json (default: "manifest.json")
  --slack-config-token <token>   Slack configuration token (default: process.env.SLACK_CONFIGURATION_TOKEN)
  --vercel-token <token>         Vercel API token (default: process.env.VERCEL_API_TOKEN)
  --slack-service-token <token>  Slack service token for auto-install (default: process.env.SLACK_SERVICE_TOKEN)
  --debug                        Enable verbose debug logging
  --version, -v                  Print version number
  --help, -h                     Show this help message
`.trim();

function parseFlags(args: string[]): {
  manifestPath?: string;
  slackConfigToken?: string;
  vercelToken?: string;
  slackServiceToken?: string;
  debug?: boolean;
} {
  let manifestPath: string | undefined;
  let slackConfigToken: string | undefined;
  let vercelToken: string | undefined;
  let slackServiceToken: string | undefined;
  let debug = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--manifest" && args[i + 1]) {
      manifestPath = args[i + 1];
      i++;
    } else if (args[i] === "--slack-config-token" && args[i + 1]) {
      slackConfigToken = args[i + 1];
      i++;
    } else if (args[i] === "--vercel-token" && args[i + 1]) {
      vercelToken = args[i + 1];
      i++;
    } else if (args[i] === "--slack-service-token" && args[i + 1]) {
      slackServiceToken = args[i + 1];
      i++;
    } else if (args[i] === "--debug") {
      debug = true;
    }
  }

  return {
    manifestPath,
    slackConfigToken,
    vercelToken,
    slackServiceToken,
    debug,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "--version" || command === "-v") {
    console.log(__PKG_VERSION__);
    process.exit(0);
  }

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  switch (command) {
    case "build": {
      log.header();

      const flags = parseFlags(args.slice(1));

      const result = await setupSlackPreview({
        manifestPath: flags.manifestPath,
        slackConfigToken: flags.slackConfigToken,
        vercelToken: flags.vercelToken,
        slackServiceToken: flags.slackServiceToken,
        debug: flags.debug,
      });

      for (const w of result.warnings) {
        log.warn(w);
      }

      switch (result.status) {
        case "skipped":
          log.info("Skipping build", result.reason);
          break;
        case "failed":
          log.error(result.error);
          break;
        case "created":
          log.success(`Created Slack app: ${result.appId}`);
          console.log();
          log.info("Manage app", `https://api.slack.com/apps/${result.appId}`);
          process.exit(0);
          break;
        case "updated":
          log.success(`Synced manifest for app: ${result.appId}`);
          console.log();
          log.info("Manage app", `https://api.slack.com/apps/${result.appId}`);
          break;
      }

      break;
    }

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
  console.log();
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  vercel-slack: ${msg}\n`);
  if (process.argv.includes("--debug") && err instanceof Error) {
    console.error(err.stack);
  }
  process.exit(1);
});
