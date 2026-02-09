// =============================================================================
// Pretty Build Output
// =============================================================================

const useColor = !process.env.NO_COLOR;

export const c = {
  reset: useColor ? "\x1b[0m" : "",
  bold: useColor ? "\x1b[1m" : "",
  dim: useColor ? "\x1b[2m" : "",
  green: useColor ? "\x1b[32m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  cyan: useColor ? "\x1b[36m" : "",
};

export const log = {
  _debug: false,
  header() {
    console.log(`${c.bold}▲ Vercel Slack Bolt${c.reset}`);
  },
  task(msg: string) {
    console.log(`  ${msg}`);
  },
  info(label: string, value: string) {
    console.log(`${c.dim}-${c.reset} ${label}: ${value}`);
  },
  success(msg: string) {
    console.log(`${c.green}✓${c.reset} ${msg}`);
  },
  warn(msg: string) {
    console.log(`${c.yellow}⚠${c.reset} ${msg}`);
  },
  error(msg: string) {
    console.error(`${c.dim}✖${c.reset} ${msg}`);
  },
  skip(msg: string) {
    console.log(`${c.dim}○ ${msg}${c.reset}`);
  },
  debug(msg: string) {
    if (this._debug) {
      console.log(`${c.dim}  [debug] ${msg}${c.reset}`);
    }
  },
  tree(items: { label: string; value: string }[]) {
    const maxLen = Math.max(...items.map((i) => i.label.length));
    for (let i = 0; i < items.length; i++) {
      const prefix = i === 0 ? "┌" : i === items.length - 1 ? "└" : "├";
      const padded = items[i].label.padEnd(maxLen);
      console.log(
        `${c.dim}${prefix}${c.reset} ${padded}  ${c.cyan}${items[i].value}${c.reset}`,
      );
    }
  },
};

/** Redact a secret for debug output: show last 4 chars + length */
export function redact(value: string | undefined | null): string {
  if (!value) return "<not set>";
  if (value.length <= 4) return "***";
  return `...${value.slice(-4)} (${value.length} chars)`;
}
