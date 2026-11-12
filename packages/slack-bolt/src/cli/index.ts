import { Command } from "commander";
import {
  enableFetchDebugLogging,
  log,
  registerSecret,
  startMessage,
} from "../internal/logger";
import { executeBuild } from "./build";
import { ENV_KEYS, envKeyToFlag, resolveEnv, SECRET_ENV_KEYS } from "./env";
import { validateAndBuildParams } from "./schemas";

export function run(version: string): Promise<void> {
  const program = new Command()
    .name("vercel-slack")
    .description(
      "Build and configure Slack apps for Vercel preview deployments",
    )
    .version(version)
    .option("--debug", "Enable verbose debug logging for all HTTP requests");

  const cmd = program
    .command("build")
    .description(
      "Build and configure the Slack app for a Vercel preview deployment",
    );

  for (const key of ENV_KEYS) {
    cmd.option(`--${envKeyToFlag(key)} <value>`, `Override ${key}`);
  }

  cmd.option(
    "--cleanup",
    "Clean up Slack apps and env vars for inactive preview branches",
  );

  cmd.action(async (options: Record<string, string | boolean | undefined>) => {
    const debug =
      program.opts().debug === true ||
      process.env.VERCEL_SLACK_DEBUG === "1" ||
      process.env.VERCEL_SLACK_DEBUG === "true";
    if (debug) {
      process.env.VERCEL_SLACK_DEBUG = "1";
      enableFetchDebugLogging();
    }

    const cleanup = options.cleanup === true;
    const env = resolveEnv(options as Record<string, string | undefined>);
    // Before anything is printed: nothing this build is given may reach its
    // log, whatever error or answer carries it.
    registerSecret(...SECRET_ENV_KEYS.map((key) => env[key]));

    console.log(
      startMessage(
        version,
        env.VERCEL_GIT_COMMIT_REF,
        env.VERCEL_GIT_COMMIT_SHA,
        env.SLACK_APP_ID,
      ),
    );

    const isLocal = !env.VERCEL_ENV;
    const isDev =
      env.VERCEL_ENV === "development" || env.NODE_ENV === "development";
    const isProd = env.VERCEL_ENV === "production";

    if (isLocal || isDev || isProd) {
      const reason = isLocal
        ? "VERCEL_ENV is not set"
        : isProd
          ? "VERCEL_ENV is production"
          : env.VERCEL_ENV === "development"
            ? "VERCEL_ENV is development"
            : "NODE_ENV is development";
      log.info(`Skipped: only preview deployments get a Slack app (${reason})`);
      return;
    }

    const params = validateAndBuildParams(env);
    await executeBuild(params, { cleanup, env });
  });

  return program.parseAsync().then(
    () => {},
    (error: unknown) => {
      log.failure(error instanceof Error ? error.message : String(error));
      // The message says what to do; each cause says what went wrong, like
      // the status Vercel or Slack answered with.
      for (
        let failure: unknown = error;
        failure instanceof Error;
        failure = failure.cause
      ) {
        if (failure !== error) {
          log.error(
            `  Caused by: ${failure.message.replace(/\n(?=.)/g, "\n    ")}`,
          );
        }
        // Slack rejects a manifest with one entry per problem and where it
        // is, on the error for the call that sent it.
        const problems = (failure as { errors?: unknown }).errors;
        if (Array.isArray(problems)) {
          for (const problem of problems as {
            message?: string;
            pointer?: string;
          }[]) {
            log.error(`    ${problem.pointer ?? ""}: ${problem.message ?? ""}`);
          }
        }
      }
      // Fail the build, so `vercel-slack build && next build` doesn't deploy
      // a preview whose Slack app wasn't set up.
      process.exitCode = 1;
    },
  );
}
