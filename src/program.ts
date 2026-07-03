import { Command } from "commander";
import { builtinCommandNames, registerCommands } from "./commands/index.js";
import type { CommandSpec } from "./internals/plan.js";
import { loadExternalCommands } from "./plugins/registry.js";

export const VERSION = "1.2.1";

/**
 * Build the configured commander program. Imported by both the CLI entry and
 * tests. Stays SYNC: `extra` lets callers merge pre-loaded plugin specs — the
 * async plugin probe lives in {@link buildProgramWithPlugins}. `warnings` is an
 * optional sink for per-spec registration containment: a plugin spec Commander
 * refuses at registration time is dropped with a warning instead of taking the
 * CLI down (see registerCommands in src/commands/index.ts).
 */
export function buildProgram(extra: CommandSpec[] = [], warnings?: string[]): Command {
  const program = new Command();
  program
    .name("aih")
    .description(
      "Enterprise AI Bootstrapping Harness — governed AI coding setup for enterprise workstations and repos",
    )
    .version(VERSION)
    .showHelpAfterError("(add --help for usage)");
  registerCommands(program, extra, warnings);
  return program;
}

/**
 * `aih --version` / `-V` must answer instantly: the CLI entry routes argv
 * through this predicate and takes a sync {@link buildProgram} (zero plugin
 * probing) when it matches. Deliberately EXACT on the first user arg only —
 * `--help` must keep loading plugins (help lists their commands), and a
 * `--version` later in argv belongs to whatever command precedes it.
 */
export function isVersionFastPath(argv: readonly string[]): boolean {
  const first = argv[2];
  return first === "--version" || first === "-V";
}

/**
 * The CLI entry's builder: probe for the optional `@aihq/enterprise` peer
 * (fail-open to local — see src/plugins/registry.ts) and build with whatever
 * validly loaded. `warnings` (probe + registration containment, in that order)
 * is printed to stderr by the entry BEFORE parse; an unenrolled machine gets
 * zero warnings and the exact buildProgram surface.
 */
export async function buildProgramWithPlugins(): Promise<{
  program: Command;
  warnings: string[];
}> {
  const { commands, warnings } = await loadExternalCommands(builtinCommandNames());
  const program = buildProgram(commands, warnings);
  return { program, warnings };
}
