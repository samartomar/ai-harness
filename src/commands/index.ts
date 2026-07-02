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
import { marketplaceBuildCommand } from "../marketplace/build.js";
import { marketplacePublishCommand } from "../marketplace/publish.js";
import { marketplaceValidateCommand } from "../marketplace/validate.js";
import { command as mcp } from "../mcp/index.js";
import {
  packAddCommand,
  packInitCommand,
  packInstallCommand,
  packPlanCommand,
  packRemoveEntryCommand,
  packStatusCommand,
  packUninstallCommand,
  packValidateCommand,
  runPackInstall,
} from "../pack/index.js";
import { command as profile } from "../profile/index.js";
import { command as prune } from "../prune/index.js";
import { command as ready } from "../ready/index.js";
import { command as report } from "../report/index.js";
import { command as sandbox } from "../sandbox/index.js";
import { command as scaffold } from "../scaffold/index.js";
import { command as secrets } from "../secrets/index.js";
import {
  skillApproveCommand,
  skillCardCommand,
  skillInventoryCommand,
  skillQuarantineCommand,
  skillRemoveCommand,
  skillVetCommand,
} from "../skill/index.js";
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
  prune,
  init,
];

/** Read-only commands (always safe). */
export const READONLY: CommandSpec[] = [doctor, status, verifyBundle];

export const ALL_COMMANDS: CommandSpec[] = [...CAPABILITIES, ...READONLY];

/** Parent command groups registered below as bare commander groups (not CommandSpecs). */
const PARENT_GROUPS = ["workspace", "trust", "skill", "pack", "marketplace"];

/**
 * Every top-level name the core CLI claims: ALL_COMMANDS plus the parent group
 * names (`workspace` is both a CommandSpec and a group — the Set folds it).
 * The plugin registry refuses any external spec colliding with one of these,
 * so a plugin can never shadow `doctor` or capture the `marketplace` group.
 */
export function builtinCommandNames(): ReadonlySet<string> {
  return new Set([...ALL_COMMANDS.map((spec) => spec.name), ...PARENT_GROUPS]);
}

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

/**
 * Register every command on the program. `extra` carries EXTERNAL plugin specs
 * (see src/plugins/registry.ts, already gated + collision-free): they flow
 * through the IDENTICAL loop as the built-ins — same shared flags, same
 * optional `[root]` positional, same runCapability action (posture resolution,
 * dirty-worktree gate, run ledger). TOP-LEVEL specs only: a plugin cannot
 * contribute subcommands to a parent group (trust/skill/pack/…) in v1.
 */
export function registerCommands(program: Command, extra: CommandSpec[] = []): void {
  for (const spec of [...ALL_COMMANDS, ...extra]) {
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

  const skill = program
    .command("skill")
    .description("Skill lifecycle operations for external skill sources");
  for (const spec of [skillVetCommand, skillCardCommand, skillApproveCommand]) {
    const sub = skill
      .command(spec.name)
      .description(spec.summary)
      .argument("<source>", "local path or GitHub owner/repo skill source");
    addSharedFlags(sub);
    for (const o of spec.options ?? []) {
      if (o.default !== undefined) sub.option(o.flags, o.description, o.default);
      else sub.option(o.flags, o.description);
    }
    sub.action(async (source: string, _options: Record<string, unknown>, command: Command) => {
      process.exitCode = await runCapability(spec, command, {
        positionalRoot: false,
        optionOverrides: { source },
      });
    });
  }
  // `inventory` takes no <source> — register it outside the vet/card/approve loop
  // (which forces a required positional), modeled on `trust list`.
  const inv = skill.command("inventory").description(skillInventoryCommand.summary);
  addSharedFlags(inv);
  inv.action(async (_options: Record<string, unknown>, command: Command) => {
    process.exitCode = await runCapability(skillInventoryCommand, command, {
      positionalRoot: false,
    });
  });
  // `remove` takes no <source> either (targets an installed skill via `--name`), so
  // register it like `inventory` — separate from the source-forcing vet/card/approve loop.
  const rm = skill.command("remove").description(skillRemoveCommand.summary);
  addSharedFlags(rm);
  for (const o of skillRemoveCommand.options ?? []) rm.option(o.flags, o.description);
  rm.action(async (_options: Record<string, unknown>, command: Command) => {
    process.exitCode = await runCapability(skillRemoveCommand, command, { positionalRoot: false });
  });
  // `quarantine` mirrors `remove`'s registration (no <source>, targets via `--name`).
  const quarantine = skill.command("quarantine").description(skillQuarantineCommand.summary);
  addSharedFlags(quarantine);
  for (const o of skillQuarantineCommand.options ?? []) quarantine.option(o.flags, o.description);
  quarantine.action(async (_options: Record<string, unknown>, command: Command) => {
    process.exitCode = await runCapability(skillQuarantineCommand, command, {
      positionalRoot: false,
    });
  });

  // `pack` mirrors the `skill` group; every subcommand takes NO positional
  // (options only), modeled on `trust list` / `skill remove` — status/validate
  // are read-only joins, plan the read-only install preview, add/init/remove-entry
  // are manifest mutators, uninstall composes per-member skill-remove plans.
  const pack = program
    .command("pack")
    .description("Skill-pack curation over the committed per-skill approvals");
  for (const spec of [
    packAddCommand,
    packInitCommand,
    packPlanCommand,
    packRemoveEntryCommand,
    packStatusCommand,
    packUninstallCommand,
    packValidateCommand,
  ]) {
    const sub = pack.command(spec.name).description(spec.summary);
    addSharedFlags(sub);
    for (const o of spec.options ?? []) {
      if (o.default !== undefined) sub.option(o.flags, o.description, o.default);
      else sub.option(o.flags, o.description);
    }
    sub.action(async (_options: Record<string, unknown>, command: Command) => {
      process.exitCode = await runCapability(spec, command, { positionalRoot: false });
    });
  }
  // `install` composes several plans per invocation (one two-phase pipeline per
  // pack source), so it gets a dedicated runner like `workspace add` instead of
  // the single-plan runCapability path.
  const packInstall = pack.command(packInstallCommand.name).description(packInstallCommand.summary);
  addSharedFlags(packInstall);
  for (const o of packInstallCommand.options ?? []) packInstall.option(o.flags, o.description);
  packInstall.action(async (_options: Record<string, unknown>, command: Command) => {
    process.exitCode = await runPackInstall(command);
  });

  // `marketplace` mirrors the `pack` group: options-only subcommands (no
  // positional), `build` is the artifact writer, `validate` the read-only gate,
  // `publish` the signer.
  const marketplace = program
    .command("marketplace")
    .description(
      "Build, validate + publish a hostable distribution artifact from the skill approval lock",
    );
  for (const spec of [
    marketplaceBuildCommand,
    marketplaceValidateCommand,
    marketplacePublishCommand,
  ]) {
    const sub = marketplace.command(spec.name).description(spec.summary);
    addSharedFlags(sub);
    for (const o of spec.options ?? []) {
      if (o.default !== undefined) sub.option(o.flags, o.description, o.default);
      else sub.option(o.flags, o.description);
    }
    sub.action(async (_options: Record<string, unknown>, command: Command) => {
      process.exitCode = await runCapability(spec, command, { positionalRoot: false });
    });
  }
}
