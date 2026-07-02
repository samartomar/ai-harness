import { Command } from "commander";
import { registerCommands } from "./commands/index.js";

export const VERSION = "0.4.0";

/** Build the configured commander program. Imported by both the CLI entry and tests. */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name("aih")
    .description("Enterprise AI Bootstrapping Harness — governed, proxy-safe AI coding setup")
    .version(VERSION)
    .showHelpAfterError("(add --help for usage)");
  registerCommands(program);
  return program;
}
