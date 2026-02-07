#!/usr/bin/env node
import fs from "node:fs";
import { setupSlackPreview } from "../preview.js";

declare const __PKG_VERSION__: string;

// Load .env.local if it exists (for local development).
// On Vercel, env vars are injected by the platform so this is a no-op.
if (fs.existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

// Gracefully handle termination signals (e.g. Docker, CI cancellation)
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

const HELP = `
Usage: vercel-slack <command> [options]

Commands:
  build   Create or update the Slack app for the current preview branch

Options:
  --manifest <path>  Path to manifest.json (default: "manifest.json")
  --debug            Enable verbose debug logging
  --version, -v      Print version number
  --help, -h         Show this help message
`.trim();

function parseFlags(args: string[]): {
  manifestPath?: string;
  debug?: boolean;
} {
  let manifestPath: string | undefined;
  let debug = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--manifest" && args[i + 1]) {
      manifestPath = args[i + 1];
      i++;
    } else if (args[i] === "--debug") {
      debug = true;
    }
  }

  return { manifestPath, debug };
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
      const flags = parseFlags(args.slice(1));
      await setupSlackPreview({
        manifestPath: flags.manifestPath,
        debug: flags.debug,
      });
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  vercel-slack: ${msg}\n`);
  if (process.argv.includes("--debug") && err instanceof Error) {
    console.error(err.stack);
  }
  process.exit(1);
});
