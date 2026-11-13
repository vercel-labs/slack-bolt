import { Command, CommanderError } from "commander";
import { messageOf } from "../internal/errors";
import { scrub } from "../internal/secrets";
import { cleanup, type Logger, preview } from "../preview";

const paint = (code: number, text: string) =>
  process.env.NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`;

const OK = () => paint(32, "✓");
const WARNING = () => paint(33, "⚠");
const FAILURE = () => paint(31, "✗");

/** Prints what a run says: a mark before each thing done, details under it. */
function terminal(debug: boolean): Logger {
  return {
    info: (message) =>
      console.log(message.startsWith("  ") ? message : `${OK()} ${message}`),
    warn: (message) => console.log(`${WARNING()} ${message}`),
    ...(debug && {
      debug: (message: string) => console.log(paint(2, `  ${message}`)),
    }),
  };
}

/**
 * Prints an error: what went wrong, then what to do about it. With `debug`,
 * also what caused it.
 */
function printError(
  error: unknown,
  { mark = FAILURE(), prefix = "", debug = false } = {},
): void {
  const [headline, ...rest] = scrub(messageOf(error)).split("\n");
  console.error(`${mark} ${prefix}${headline}`);
  for (const line of rest) console.error(`  ${line}`);
  if (!debug) return;
  for (
    let cause = error instanceof Error ? error.cause : undefined;
    cause !== undefined;
    cause = cause instanceof Error ? cause.cause : undefined
  ) {
    console.error(paint(2, `  Caused by: ${scrub(messageOf(cause))}`));
  }
}

/**
 * Whether to print debug output: `--debug`, or `VERCEL_SLACK_DEBUG` set to
 * `1` or `true`, which turns it on for a build without changing its command.
 */
const debugging = (flag: boolean | undefined): boolean =>
  flag === true || ["1", "true"].includes(process.env.VERCEL_SLACK_DEBUG ?? "");

interface BuildFlags {
  manifest?: string;
  cleanup?: boolean;
  allowFailure?: boolean;
  sensitive: boolean;
  debug?: boolean;
}

async function build(flags: BuildFlags): Promise<number> {
  const debug = debugging(flags.debug);
  const logger = terminal(debug);

  // First, so the apps of branches that are gone make room for this one's.
  // It's housekeeping: whatever goes wrong with it, the build goes on.
  if (flags.cleanup) {
    try {
      await cleanup({ logger });
    } catch (error) {
      printError(error, {
        mark: WARNING(),
        prefix: "Skipped cleanup: ",
        debug,
      });
    }
  }

  let failure: unknown;
  try {
    const result = await preview({
      logger,
      manifest: flags.manifest,
      sensitive: flags.sensitive,
    });
    if (result.status !== "outdated") return 0;
    // It would go live with an earlier app's credentials, or none, and
    // nothing will replace it: a failure like any other.
    failure = new Error(
      "This deployment doesn't have the variables of the branch's Slack app, so it can't serve the app",
    );
  } catch (error) {
    failure = error;
  }
  printError(failure, { debug });
  if (!flags.allowFailure) return 1;
  console.error("  Carrying on without it: --allow-failure is set.");
  return 0;
}

interface CleanupFlags {
  branch?: string[];
  dryRun?: boolean;
  debug?: boolean;
}

async function clean(flags: CleanupFlags): Promise<number> {
  const debug = debugging(flags.debug);
  try {
    const { failed } = await cleanup({
      logger: terminal(debug),
      branches: flags.branch,
      dryRun: flags.dryRun,
    });
    return failed.length > 0 ? 1 : 0;
  } catch (error) {
    printError(error, { debug });
    return 1;
  }
}

/**
 * Runs the `vercel-slack` command line, and resolves with its exit code: 0
 * when it did what was asked or there was nothing to do, 1 otherwise.
 */
export async function main(argv: string[], version: string): Promise<number> {
  let code = 0;
  const banner = () => console.log(paint(1, `▲ vercel-slack ${version}`));

  const program = new Command("vercel-slack")
    .description("Slack apps for the preview deployments of a Vercel project")
    .version(version)
    .exitOverride();

  program
    .command("build")
    .description(
      "Give this preview deployment's branch its own Slack app. Does nothing in other deployments.",
    )
    .option(
      "--manifest <path>",
      "the app's manifest (default: MANIFEST_PATH, then manifest.json, .yaml or .yml)",
    )
    .option("--cleanup", "first delete the apps of branches that are gone")
    .option(
      "--allow-failure",
      "exit with 0 when the app can't be set up, so the build goes on without it",
    )
    .option(
      "--no-sensitive",
      "save the app's secrets so they can be read back from Vercel",
    )
    .option("--debug", "print every request and what caused each error")
    .action(async (flags: BuildFlags) => {
      banner();
      code = await build(flags);
    });

  program
    .command("cleanup")
    .description(
      "Delete the Slack apps and variables of branches that are gone",
    )
    .option(
      "--branch <name...>",
      "the branches to clean up (default: every branch Vercel no longer lists as active)",
    )
    .option("--dry-run", "say what would be removed, and remove nothing")
    .option("--debug", "print every request and what caused each error")
    .action(async (flags: CleanupFlags) => {
      banner();
      code = await clean(flags);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    // Help, the version, or a mistake in the arguments, which commander has
    // already printed.
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
  return code;
}
