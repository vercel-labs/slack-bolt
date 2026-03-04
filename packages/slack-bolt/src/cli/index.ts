import { Command } from "commander";
import { logger } from "../logger";
import { registerBuildCommand } from "./build";

export function run(version: string): void {
  const program = new Command()
    .name("vercel-slack")
    .description(
      "Build and configure Slack apps for Vercel preview deployments",
    )
    .version(version);

  registerBuildCommand(program, version);

  program.parseAsync().catch((error: unknown) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
