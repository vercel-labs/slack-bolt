import { Command } from "commander";
import { validateAndBuildParams } from "../internal/schemas";
import { log, logger, startMessage } from "../logger";
import { executeBuild } from "./build";
import { ENV_KEYS, envKeyToFlag, resolveEnv } from "./env";

export function run(version: string): void {
  const program = new Command()
    .name("vercel-slack")
    .description(
      "Build and configure Slack apps for Vercel preview deployments",
    )
    .version(version);

  const cmd = program
    .command("build")
    .description(
      "Build and configure the Slack app for a Vercel preview deployment",
    );

  for (const key of ENV_KEYS) {
    cmd.option(`--${envKeyToFlag(key)} <value>`, `Override ${key}`);
  }

  cmd.action(async (options: Record<string, string | undefined>) => {
    const env = resolveEnv(options);

    logger.info(
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
      const reason = isLocal ? "local" : isDev ? "development" : "production";
      log.info(`Environment: ${reason} (skipped)\n`);
      return;
    }

    const params = validateAndBuildParams(env);
    await executeBuild(params, version);
  });

  program.parseAsync().catch((error: unknown) => {
    logger.error(error instanceof Error ? error.message : String(error));
    console.log();
  });
}
