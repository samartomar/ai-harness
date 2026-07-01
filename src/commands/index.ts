import type { Command } from "commander";
import { command as adopt } from "../adopt/index.js";
import { command as bootstrap } from "../bootstrap/index.js";
import { command as bootstrapAi } from "../bootstrap-ai/index.js";
import { command as bundle, verifyCommand as verifyBundle } from "../bundle/index.js";
import { command as certs } from "../certs/index.js";
import { command as contract } from "../contract/index.js";
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
import { command as ready } from "../ready/index.js";
import { command as report } from "../report/index.js";
import { command as sandbox } from "../sandbox/index.js";
import { command as scaffold } from "../scaffold/index.js";
import { command as secrets } from "../secrets/index.js";
import { command as status } from "../status.js";
import { command as superpowers } from "../superpowers/index.js";
import { command as telemetry } from "../telemetry/index.js";
import { command as tools } from "../tools/index.js";
import { command as track } from "../track/index.js";
import {
  trustAllowCommand,
  trustListCommand,
  trustPinCommand,
  trustVerifyCommand,
} from "../trust/commands.js";
import { trustScanCommand } from "../trust/scan.js";
import { command as usage } from "../usage/index.js";
import { command as vdi } from "../vdi/index.js";
import { runWorkspaceAdd, workspaceAddCommand } from "../workspace/acquire.js";
import {
  command as workspace,
  taskPlanCommand as workspacePlan,
  snapshotCommand as workspaceSnapshot,
} from "../workspace/index.js";
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
  contract,
  guardrails,
  secrets,
  mcp,
  sandbox,
  telemetry,
  bundle,
  report,
  ready,
  track,
  usage,
  tools,
  crispy,
  bootstrap,
  bootstrapAi,
  workspace,
  adopt,
  init,
];

/** Read-only commands (always safe). */
export const READONLY: CommandSpec[] = [doctor, status, verifyBundle];

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
    .option("--posture <posture>", "governance posture: vibe | team | enterprise", "vibe")
    .option("--support-out <dir>", "write IT/support tickets for failed checks to <dir>")
    .option("--no-log", "do not append a row to the local run ledger (.aih/runs/)")
    .option("--context-dir <dir>", "canonical context directory name (any name works)", "ai-coding")
    .option("--root <dir>", "target repository/workstation root")
    .option("--cli <list>", "target AI CLIs (comma-separated): claude,codex,cursor,antigravity,…")
    .option("--all-tools", "target every supported AI CLI")
    .option(
      "--detect",
      "target only runnable AI CLIs detected on PATH (config-only traces are advisory)",
    )
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
    if (spec.name === "workspace") {
      const add = cmd
        .command(workspaceAddCommand.name)
        .description(workspaceAddCommand.summary)
        .argument("<source>", "local path or GitHub owner/repo trust source");
      addSharedFlags(add);
      for (const o of workspaceAddCommand.options ?? []) {
        if (o.default !== undefined) add.option(o.flags, o.description, o.default);
        else add.option(o.flags, o.description);
      }
      add.action(async (_source: string, _options: Record<string, unknown>, command: Command) => {
        process.exitCode = await runWorkspaceAdd(command);
      });

      const snap = cmd
        .command(workspaceSnapshot.name)
        .description(workspaceSnapshot.summary)
        .argument("[root]", "target workspace root (defaults to --root or cwd)");
      addSharedFlags(snap);
      for (const o of workspaceSnapshot.options ?? []) {
        if (o.default !== undefined) snap.option(o.flags, o.description, o.default);
        else snap.option(o.flags, o.description);
      }
      snap.action(
        async (
          _rootArg: string | undefined,
          _options: Record<string, unknown>,
          command: Command,
        ) => {
          process.exitCode = await runCapability(workspaceSnapshot, command);
        },
      );

      const task = cmd
        .command(workspacePlan.name)
        .description(workspacePlan.summary)
        .argument("<task>", "workspace task description");
      addSharedFlags(task);
      for (const o of workspacePlan.options ?? []) {
        if (o.default !== undefined) task.option(o.flags, o.description, o.default);
        else task.option(o.flags, o.description);
      }
      task.action(async (taskText: string, _options: Record<string, unknown>, command: Command) => {
        process.exitCode = await runCapability(workspacePlan, command, {
          positionalRoot: false,
          optionOverrides: { task: taskText },
        });
      });
    }
  }

  const trust = program.command("trust").description("Trust-gate operations for external sources");
  const allow = trust
    .command(trustAllowCommand.name)
    .description(trustAllowCommand.summary)
    .argument("<source>", "GitHub owner/repo trust source");
  addSharedFlags(allow);
  for (const o of trustAllowCommand.options ?? []) {
    if (o.default !== undefined) allow.option(o.flags, o.description, o.default);
    else allow.option(o.flags, o.description);
  }
  allow.action(async (source: string, _options: Record<string, unknown>, command: Command) => {
    process.exitCode = await runCapability(trustAllowCommand, command, {
      positionalRoot: false,
      optionOverrides: { source },
    });
  });

  const list = trust.command(trustListCommand.name).description(trustListCommand.summary);
  addSharedFlags(list);
  for (const o of trustListCommand.options ?? []) {
    if (o.default !== undefined) list.option(o.flags, o.description, o.default);
    else list.option(o.flags, o.description);
  }
  list.action(async (_options: Record<string, unknown>, command: Command) => {
    process.exitCode = await runCapability(trustListCommand, command, { positionalRoot: false });
  });

  const pin = trust
    .command(trustPinCommand.name)
    .description(trustPinCommand.summary)
    .argument("<source>", "GitHub owner/repo trust source");
  addSharedFlags(pin);
  for (const o of trustPinCommand.options ?? []) {
    if (o.default !== undefined) pin.option(o.flags, o.description, o.default);
    else pin.option(o.flags, o.description);
  }
  pin.action(async (source: string, _options: Record<string, unknown>, command: Command) => {
    process.exitCode = await runCapability(trustPinCommand, command, {
      positionalRoot: false,
      optionOverrides: { source },
    });
  });

  const scan = trust
    .command(trustScanCommand.name)
    .description(trustScanCommand.summary)
    .argument("<target>", "local path or GitHub owner/repo trust source");
  addSharedFlags(scan);
  for (const o of trustScanCommand.options ?? []) {
    if (o.default !== undefined) scan.option(o.flags, o.description, o.default);
    else scan.option(o.flags, o.description);
  }
  scan.action(async (target: string, _options: Record<string, unknown>, command: Command) => {
    process.exitCode = await runCapability(trustScanCommand, command, {
      positionalRoot: false,
      optionOverrides: { target },
    });
  });

  const verify = trust
    .command(trustVerifyCommand.name)
    .description(trustVerifyCommand.summary)
    .argument("[id]", "optional trust-lock source id to verify");
  addSharedFlags(verify);
  for (const o of trustVerifyCommand.options ?? []) {
    if (o.default !== undefined) verify.option(o.flags, o.description, o.default);
    else verify.option(o.flags, o.description);
  }
  verify.action(
    async (id: string | undefined, _options: Record<string, unknown>, command: Command) => {
      process.exitCode = await runCapability(trustVerifyCommand, command, {
        positionalRoot: false,
        optionOverrides: { id },
      });
    },
  );
}
