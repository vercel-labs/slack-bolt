const isDebug =
  process.env.VERCEL_SLACK_DEBUG === "1" ||
  process.env.VERCEL_SLACK_DEBUG === "true";

export const logger = {
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => {
    if (isDebug) console.debug(...args);
  },
};

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

export const log = {
  step: (msg: string) => console.log(`  ${msg} ...`),
  success: (msg: string) => console.log(`${GREEN}✓${RESET} ${msg}`),
  info: (msg: string) => console.log(`  ${msg}`),
  warning: (msg: string) => console.log(`${YELLOW}⚠${RESET} ${msg}`),
};

export const startMessage = (
  version?: string,
  branch?: string,
  commit?: string,
  appId?: string,
) => {
  const lines = [`▲ @vercel/slack-bolt ${version ?? ""}`];
  if (branch) lines.push(`  - Branch: ${branch}`);
  if (commit) lines.push(`  - Commit: ${commit.slice(0, 7)}`);
  if (appId) lines.push(`  - App ID: ${appId}`);
  return `${BOLD}${lines.join("\n")}${RESET}\n`;
};
