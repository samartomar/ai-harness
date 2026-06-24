import type { Command } from "commander";
import { command as bootstrap } from "../bootstrap/index.js";
import { command as certs } from "../certs/index.js";
import { command as crispy } from "../crispy/index.js";
import { command as doctor } from "../doctor.js";
import { command as guardrails } from "../guardrails/index.js";
import { command as hardware } from "../hardware/index.js";
import { command as init } from "../init/index.js";
import type { CommandSpec } from "../internals/plan.js";
import { command as mcp } from "../mcp/index.js";
import { command as profile } from "../profile/index.js";
import { command as sandbox } from "../sandbox/index.js";
import { command as scaffold } from "../scaffold/index.js";
import { command as secrets } from "../secrets/index.js";
import { command as status } from "../status.js";
import { command as telemetry } from "../telemetry/index.js";
import { command as vdi } from "../vdi/index.js";
import { runCapability } from "./run.js";

/** Capability commands (repo/workstation mutators), dry-run by default. */
export const CAPABILITIES: CommandSpec[] = [
  certs,
  hardware,
  vdi,
  profile,
  scaffold,
  guardrails,
  secrets,
  mcp,
  sandbox,
  telemetry,
  crispy,
  bootstrap,
  init,
];

/** Read-only commands (always safe). */
export const READONLY: CommandSpec[] = [doctor, status];

export const ALL_COMMANDS: CommandSpec[] = [...CAPABILITIES, ...READONLY];

/** Flags shared by every subcommand (placed on the subcommand so `aih certs --apply` works). */
function addSharedFlags(cmd: Command): Command {
  return cmd
    .option("--apply", "execute the plan (default: dry-run; nothing is written)")
    .option("--verify", "run verification probes after applying")
    .option("--json", "emit machine-readable JSON")
    .option("--context-dir <dir>", "canonical context directory name", ".ai-context")
    .option("--root <dir>", "target repository/workstation root");
}

export function registerCommands(program: Command): void {
  for (const spec of ALL_COMMANDS) {
    const cmd = program.command(spec.name).description(spec.summary);
    if (!spec.readOnly) addSharedFlags(cmd);
    else cmd.option("--json", "emit machine-readable JSON").option("--root <dir>", "target root");
    for (const o of spec.options ?? []) {
      if (o.default !== undefined) cmd.option(o.flags, o.description, o.default);
      else cmd.option(o.flags, o.description);
    }
    cmd.action(async (_options: Record<string, unknown>, command: Command) => {
      process.exitCode = await runCapability(spec, command);
    });
  }
}
