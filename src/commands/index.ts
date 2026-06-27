import type { Command } from "commander";
import { command as adopt } from "../adopt/index.js";
import { command as bootstrap } from "../bootstrap/index.js";
import { command as bootstrapAi } from "../bootstrap-ai/index.js";
import { command as certs } from "../certs/index.js";
import { command as crispy } from "../crispy/index.js";
import { command as doctor } from "../doctor.js";
import { command as ecc } from "../ecc/index.js";
import { command as guardrails } from "../guardrails/index.js";
import { command as hardware } from "../hardware/index.js";
import { command as heal } from "../heal/index.js";
import { command as init } from "../init/index.js";
import type { CommandSpec } from "../internals/plan.js";
import { command as mcp } from "../mcp/index.js";
import { command as profile } from "../profile/index.js";
import { command as report } from "../report/index.js";
import { command as sandbox } from "../sandbox/index.js";
import { command as scaffold } from "../scaffold/index.js";
import { command as secrets } from "../secrets/index.js";
import { command as status } from "../status.js";
import { command as superpowers } from "../superpowers/index.js";
import { command as telemetry } from "../telemetry/index.js";
import { command as track } from "../track/index.js";
import { command as usage } from "../usage/index.js";
import { command as vdi } from "../vdi/index.js";
import { command as workspace } from "../workspace/index.js";
import { runCapability } from "./run.js";

/** Capability commands (repo/workstation mutators), dry-run by default. */
export const CAPABILITIES: CommandSpec[] = [
  certs,
  heal,
  hardware,
  vdi,
  profile,
  ecc,
  superpowers,
  scaffold,
  guardrails,
  secrets,
  mcp,
  sandbox,
  telemetry,
  report,
  track,
  usage,
  crispy,
  bootstrap,
  bootstrapAi,
  workspace,
  adopt,
  init,
];

/** Read-only commands (always safe). */
export const READONLY: CommandSpec[] = [doctor, status];

export const ALL_COMMANDS: CommandSpec[] = [...CAPABILITIES, ...READONLY];

/** Flags shared by every subcommand (placed on the subcommand so `aih certs --apply` works). */
function addSharedFlags(cmd: Command): Command {
  return cmd
    .option("--apply", "execute the plan (default: dry-run; nothing is written)")
    .option(
      "--force",
      "apply even when the git worktree is dirty (skip the clean-worktree preflight)",
    )
    .option("--verify", "run verification probes after applying")
    .option("--json", "emit machine-readable JSON")
    .option("--support-out <dir>", "write IT/support tickets for failed checks to <dir>")
    .option("--no-log", "do not append a row to the local run ledger (.aih/runs/)")
    .option("--context-dir <dir>", "canonical context directory name (any name works)", "ai-coding")
    .option("--root <dir>", "target repository/workstation root")
    .option("--cli <list>", "target AI CLIs (comma-separated): claude,codex,cursor,antigravity,…")
    .option("--all-tools", "target every supported AI CLI")
    .option("--detect", "target only the AI CLIs detected on this machine (config dir / binary)")
    .option(
      "--yes",
      "skip the interactive confirmation for --detect (use the detected list as-is)",
    );
}

export function registerCommands(program: Command): void {
  for (const spec of ALL_COMMANDS) {
    const cmd = program.command(spec.name).description(spec.summary);
    // Optional positional target dir, e.g. `aih init .` or `aih profile ./repo`.
    cmd.argument("[root]", "target repository/workstation root (defaults to --root or cwd)");
    if (!spec.readOnly) addSharedFlags(cmd);
    else
      cmd
        .option("--json", "emit machine-readable JSON")
        .option("--root <dir>", "target root")
        .option("--support-out <dir>", "write IT/support tickets for failed checks to <dir>")
        .option("--no-log", "do not append a row to the local run ledger (.aih/runs/)");
    for (const o of spec.options ?? []) {
      if (o.default !== undefined) cmd.option(o.flags, o.description, o.default);
      else cmd.option(o.flags, o.description);
    }
    cmd.action(
      async (_rootArg: string | undefined, _options: Record<string, unknown>, command: Command) => {
        process.exitCode = await runCapability(spec, command);
      },
    );
  }
}
