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

const fmtHeader = (version?: string) => `▲ @vercel/slack-bolt ${version ?? ""}`;
const fmtBranch = (branch?: string) => (branch ? `- Branch: ${branch}` : "");
const fmtCommit = (commit?: string) =>
  commit ? `- Commit: ${commit.slice(0, 7)}` : "";
const fmtAppId = (appId?: string) => (appId ? `- App ID: ${appId}` : "");

export const startMessage = (
  version?: string,
  branch?: string,
  commit?: string,
  appId?: string,
) => {
  const BOLD = "\x1b[1m";
  const RESET = "\x1b[0m";
  const msg = [
    fmtHeader(version),
    fmtBranch(branch),
    fmtCommit(commit),
    fmtAppId(appId),
  ]
    .filter(Boolean)
    .join("\n");
  return `${BOLD}${msg}${RESET}`;
};

export const endMessage = () => "\n";
