#!/usr/bin/env node
import { parseArgs } from "node:util";
import { preview } from "./preview";

const NAME = "vercel-slack";
const VERSION = "1.1.0";

const ENV_KEYS = [
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_REF",
  "VERCEL_PROJECT_ID",
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "VERCEL_TEAM_ID",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_MESSAGE",
  "VERCEL_GIT_COMMIT_AUTHOR_LOGIN",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
  "SLACK_APP_ID",
  "SLACK_CONFIGURATION_TOKEN",
  "SLACK_SERVICE_TOKEN",
  "SLACK_CONFIG_REFRESH_TOKEN",
  "MANIFEST_PATH",
  "VERCEL_API_TOKEN",
] as const;

function envKeyToFlag(key: string): string {
  return key.toLowerCase().replace(/_/g, "-");
}

function flagToEnvKey(flag: string): string {
  return flag.toUpperCase().replace(/-/g, "_");
}

function printHelp() {
  console.log(`${NAME} v${VERSION}

Usage: ${NAME} <command> [options]

Commands:
  build    Build and configure the Slack app for a Vercel preview deployment
  help     Show this help message

Options:
  --help, -h       Show help
  --version, -v    Show version

Build options (override environment variables):
${ENV_KEYS.map((key) => `  --${envKeyToFlag(key)}`).join("\n")}

Environment variables are read automatically. Use flags to override them.`);
}

const args = process.argv.slice(2);
const command = args[0];

if (
  !command ||
  command === "help" ||
  command === "--help" ||
  command === "-h"
) {
  printHelp();
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  console.log(VERSION);
  process.exit(0);
}

if (command !== "build") {
  console.error(`Unknown command: ${command}\n`);
  printHelp();
  process.exit(1);
}

const options: Record<string, { type: "string" }> = {};
for (const key of ENV_KEYS) {
  options[envKeyToFlag(key)] = { type: "string" };
}

const { values } = parseArgs({ args: args.slice(1), options, strict: false });

const overrides: Record<string, string> = {};
for (const [flag, value] of Object.entries(values)) {
  if (typeof value === "string") {
    overrides[flagToEnvKey(flag)] = value;
  }
}

preview({ overrides }).catch((error: unknown) => {
  console.error(
    `[@vercel/slack-bolt] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
