import { Command } from "commander";
import { builtinCommandNames, registerCommands } from "./commands/index.js";
import type { CommandSpec } from "./internals/plan.js";
import { loadExternalCommands } from "./plugins/registry.js";

export const VERSION = "0.5.0";

/**
 * Build the configured commander program. Imported by both the CLI entry and
 * tests. Stays SYNC: `extra` lets callers merge pre-loaded plugin specs — the
 * async plugin probe lives in {@link buildProgramWithPlugins}.
 */
export function buildProgram(extra: CommandSpec[] = []): Command {
  const program = new Command();
  program
    .name("aih")
    .description("Enterprise AI Bootstrapping Harness — governed, proxy-safe AI coding setup")
    .version(VERSION)
    .showHelpAfterError("(add --help for usage)");
  registerCommands(program, extra);
  return program;
}

/**
 * The CLI entry's builder: probe for the optional `@aihq/enterprise` peer
 * (fail-open to local — see src/plugins/registry.ts) and build with whatever
 * validly loaded. `warnings` is printed to stderr by the entry BEFORE parse;
 * an unenrolled machine gets zero warnings and the exact buildProgram surface.
 */
export async function buildProgramWithPlugins(): Promise<{
  program: Command;
  warnings: string[];
}> {
  const { commands, warnings } = await loadExternalCommands(builtinCommandNames());
  return { program: buildProgram(commands), warnings };
}
