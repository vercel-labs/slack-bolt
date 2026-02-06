#!/usr/bin/env node
import fs from "node:fs";
import { setupSlackPreview } from "../preview.js";

// Load .env.local if it exists (for local development).
// On Vercel, env vars are injected by the platform so this is a no-op.
if (fs.existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

const HELP = `
Usage: vercel-slack <command> [options]

Commands:
  build   Create or update the Slack app for the current preview branch

Options:
  --manifest <path>  Path to manifest.json (default: "manifest.json")
  --help             Show this help message
`.trim();

function parseFlags(args: string[]): { manifestPath?: string } {
  let manifestPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--manifest" && args[i + 1]) {
      manifestPath = args[i + 1];
      i++;
    }
  }

  return { manifestPath };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  switch (command) {
    case "build": {
      const flags = parseFlags(args.slice(1));
      await setupSlackPreview({ manifestPath: flags.manifestPath });
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
