import type { Command } from "commander";
import { command as adopt } from "../adopt/index.js";
import { command as bootstrap } from "../bootstrap/index.js";
import { command as bootstrapAi } from "../bootstrap-ai/index.js";
import { command as bundle, verifyCommand as verifyBundle } from "../bundle/index.js";
import { capabilityPruneCommand, capabilityResolveCommand } from "../capability/index.js";
import { command as certs } from "../certs/index.js";
import { command as contract } from "../contract/index.js";
import { command as crispy } from "../crispy/index.js";
import { command as doctor } from "../doctor.js";
import { command as ecc } from "../ecc/index.js";
import { evidenceBuildCommand } from "../evidence/build.js";
import { command as guardrails } from "../guardrails/index.js";
import { command as hardware } from "../hardware/index.js";
import { command as heal } from "../heal/index.js";
import { command as init } from "../init/index.js";
import type { CommandSpec } from "../internals/plan.js";
import { marketplaceBuildCommand } from "../marketplace/build.js";
import { marketplacePublishCommand } from "../marketplace/publish.js";
import { marketplaceValidateCommand } from "../marketplace/validate.js";
import { command as mcp, mcpApproveCommand } from "../mcp/index.js";
import { policyValidateCommand, policyVerifyCommand } from "../org-policy/validate.js";
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
import { sanitizeLabel } from "../plugins/registry.js";
import { command as profile } from "../profile/index.js";
import { command as prune } from "../prune/index.js";
import { command as ready } from "../ready/index.js";
import { verifyReleaseCommand } from "../release/verify-release.js";
import { command as report } from "../report/index.js";
import { command as sandbox } from "../sandbox/index.js";
import { command as scaffold } from "../scaffold/index.js";
import { command as secrets } from "../secrets/index.js";
import { command as sessionGuard } from "../session/index.js";
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
  trustSkillspectorPinCommand,
  trustVerifyCommand,
} from "../trust/commands.js";
import { trustScanCommand } from "../trust/scan.js";
import { command as uninstall } from "../uninstall/index.js";
import { command as usage } from "../usage/index.js";
import { command as vdi } from "../vdi/index.js";
import { runWorkspaceAdd, workspaceAddCommand } from "../workspace/acquire.js";
import {
  command as workspace,
  workspaceHydrateCommand as workspaceHydrate,
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
  uninstall,
  init,
];

/** Read-only commands (always safe). */
export const READONLY: CommandSpec[] = [
  doctor,
  status,
  verifyBundle,
  verifyReleaseCommand,
  sessionGuard,
];

export const ALL_COMMANDS: CommandSpec[] = [...CAPABILITIES, ...READONLY];

/** Parent command groups registered below as bare commander groups (not CommandSpecs). */
export const PARENT_GROUPS = [
  "workspace",
  "capability",
  "trust",
  "skill",
  "pack",
  "marketplace",
  "policy",
  "evidence",
] as const;

export const GROUPED_COMMAND_SPECS = {
  workspace: [workspaceAddCommand, workspaceHydrate, workspaceSnapshot, workspacePlan],
  capability: [capabilityResolveCommand, capabilityPruneCommand],
  trust: [
    trustAllowCommand,
    trustListCommand,
    trustPinCommand,
    trustScanCommand,
    trustSkillspectorPinCommand,
    trustVerifyCommand,
  ],
  skill: [
    skillVetCommand,
    skillCardCommand,
    skillApproveCommand,
    skillInventoryCommand,
    skillRemoveCommand,
    skillQuarantineCommand,
  ],
  pack: [
    packAddCommand,
    packInitCommand,
    packPlanCommand,
    packRemoveEntryCommand,
    packStatusCommand,
    packUninstallCommand,
    packValidateCommand,
    packInstallCommand,
  ],
  marketplace: [marketplaceBuildCommand, marketplaceValidateCommand, marketplacePublishCommand],
  policy: [policyValidateCommand, policyVerifyCommand],
  evidence: [evidenceBuildCommand],
} as const satisfies Record<(typeof PARENT_GROUPS)[number], readonly CommandSpec[]>;

/** Every built-in CommandSpec, including nested specs under parent groups. */
export const ALL_COMMAND_SPECS: CommandSpec[] = [
  ...ALL_COMMANDS,
  mcpApproveCommand,
  ...Object.values(GROUPED_COMMAND_SPECS).flat(),
];

/** Stable command paths for the spec registry completeness guard. */
export const ALL_COMMAND_SPEC_PATHS: ReadonlyArray<readonly string[]> = [
  ...ALL_COMMANDS.map((spec) => [spec.name] as const),
  ["mcp", mcpApproveCommand.name] as const,
  ...Object.entries(GROUPED_COMMAND_SPECS).flatMap(([parent, specs]) =>
    specs.map((spec) => [parent, spec.name] as const),
  ),
];

/**
 * Names commander itself claims on every program: the implicit `help`
 * subcommand and the `--version`/`version` surface. Reserved so a plugin can
 * never register a command that shadows or impersonates either.
 */
const RESERVED_COMMAND_NAMES = ["help", "version"];

/**
 * Every top-level name the core CLI claims: ALL_COMMANDS' names AND their
 * deprecated aliases (an old name stays reserved for its whole grace window —
 * see CommandSpec.deprecatedAliases), plus the parent group names
 * (`workspace` is both a CommandSpec and a group — the Set folds it) plus
 * commander's own reserved `help`/`version`. The plugin registry refuses any
 * external spec colliding with one of these, so a plugin can never shadow
 * `doctor`, capture the `marketplace` group, impersonate `help`, or squat on
 * a deprecated old name mid-migration. `specs` is a test seam (defaults to
 * ALL_COMMANDS) so the alias reservation is provable while zero built-ins
 * carry one.
 */
export function builtinCommandNames(
  specs: readonly CommandSpec[] = ALL_COMMANDS,
): ReadonlySet<string> {
  return new Set([
    ...specs.map((spec) => spec.name),
    ...specs.flatMap((spec) => spec.aliases ?? []),
    ...specs.flatMap((spec) => spec.deprecatedAliases ?? []),
    ...PARENT_GROUPS,
    ...RESERVED_COMMAND_NAMES,
  ]);
}

/**
 * Flags shared by every subcommand (placed on the subcommand so `aih certs
 * --apply` works). Exported as the authoritative shared-flag surface: the
 * plugin registry's SHARED_FLAG_TOKENS mirror (src/plugins/registry.ts) is
 * pinned against this exact registration by tests, so the two cannot drift.
 */
export function addSharedFlags(cmd: Command): Command {
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
 * The deprecated alias this invocation was actually typed with, if any.
 * Commander offers no "which alias matched" API, but the parent keeps
 * `args[0]` as the literal subcommand token right up to dispatch
 * (`this.args = operands.concat(unknown)` precedes `_dispatchSubcommand`), so
 * comparing that token against the spec's alias list identifies an alias
 * invocation. Only meaningful on the top-level registerSpec path, where the
 * parent is the program.
 */
function invokedDeprecatedAlias(spec: CommandSpec, command: Command): string | undefined {
  const aliases = spec.deprecatedAliases;
  if (aliases === undefined || aliases.length === 0) return undefined;
  const typed = command.parent?.args[0];
  return typed !== undefined && typed !== spec.name && aliases.includes(typed) ? typed : undefined;
}

/**
 * ONE stderr line when a command ran under a deprecated old name — emitted
 * BEFORE the action so the migration hint lands even when the run itself
 * fails, and on stderr so `--json`/`--sarif -` stdout stays machine-clean.
 * The alias echoed here is a code-reviewed literal from a built-in spec
 * (plugin specs never carry aliases — the registry strips the field), so no
 * sanitizer is needed.
 */
function warnIfDeprecatedAlias(spec: CommandSpec, command: Command): void {
  const alias = invokedDeprecatedAlias(spec, command);
  if (alias === undefined) return;
  process.stderr.write(
    `aih: ${alias} is deprecated — use ${spec.name} (removal comes with the next major)\n`,
  );
}

/**
 * Register ONE top-level CommandSpec — the identical path for built-ins and
 * gated plugin specs: same shared flags, same optional `[root]` positional,
 * same runCapability action (posture resolution, dirty-worktree gate, run
 * ledger). The command is assembled DETACHED and attached last, so a
 * mid-registration throw (contained per-spec for plugins in registerCommands)
 * cannot leave a half-registered command on the program.
 */
function registerSpec(program: Command, spec: CommandSpec): void {
  // .command() would copy inherited settings and attach immediately; doing the
  // copy explicitly and attaching at the end yields the same net configuration.
  const cmd = program.createCommand(spec.name).description(spec.summary);
  cmd.copyInheritedSettings(program);
  for (const alias of spec.aliases ?? []) cmd.alias(alias);
  // Alias-before-removal (STABILITY.md): each deprecated old name stays a live
  // commander alias — same flags, same action, one stderr warning at dispatch.
  // NOT hidden: commander shows the first alias in help as `name|alias`, which
  // keeps the migration hint discoverable right next to the replacement.
  // Commander itself refuses an alias equal to the command's name or to any
  // sibling command, so a bad built-in alias crashes loudly at startup (a core
  // bug), and a plugin spec's alias throw is contained per-spec upstream.
  for (const alias of spec.deprecatedAliases ?? []) cmd.alias(alias);
  // Optional positional target dir, e.g. `aih init .` or `aih profile ./repo`.
  // A spec can instead name a custom positional (e.g. `verify-release [version]`).
  if (spec.positional) {
    const token = spec.positional.required
      ? `<${spec.positional.name}>`
      : `[${spec.positional.name}]`;
    cmd.argument(token, spec.positional.description ?? spec.positional.name);
  } else {
    cmd.argument("[root]", "target repository/workstation root (defaults to --root or cwd)");
  }
  if (!spec.readOnly) addSharedFlags(cmd);
  else
    cmd
      .option("--json", "emit machine-readable JSON")
      .option("--posture <posture>", "governance posture: vibe | team | enterprise", "vibe")
      .option("--root <dir>", "target root")
      .option("--support-out <dir>", "write IT/support tickets for failed checks to <dir>")
      .option("--no-log", "do not append a row to the local run ledger (.aih/runs/)");
  for (const o of spec.options ?? []) {
    if (o.default !== undefined) cmd.option(o.flags, o.description, o.default);
    else cmd.option(o.flags, o.description);
  }
  cmd.action(
    async (_rootArg: string | undefined, _options: Record<string, unknown>, command: Command) => {
      warnIfDeprecatedAlias(spec, command);
      process.exitCode = await runCapability(
        spec,
        command,
        spec.positional?.optionName
          ? {
              positionalRoot: false,
              optionOverrides: { [spec.positional.optionName]: _rootArg },
            }
          : undefined,
      );
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
      async (_rootArg: string | undefined, _options: Record<string, unknown>, command: Command) => {
        process.exitCode = await runCapability(workspaceSnapshot, command);
      },
    );

    const hydrate = cmd
      .command(workspaceHydrate.name)
      .description(workspaceHydrate.summary)
      .argument("[root]", "target workspace root (defaults to --root or cwd)");
    addSharedFlags(hydrate);
    for (const o of workspaceHydrate.options ?? []) {
      if (o.default !== undefined) hydrate.option(o.flags, o.description, o.default);
      else hydrate.option(o.flags, o.description);
    }
    hydrate.action(
      async (_rootArg: string | undefined, _options: Record<string, unknown>, command: Command) => {
        process.exitCode = await runCapability(workspaceHydrate, command);
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
  if (spec.name === "mcp") {
    const approve = cmd
      .command(mcpApproveCommand.name)
      .description(mcpApproveCommand.summary)
      .argument("<server>", "MCP server name to approve");
    addSharedFlags(approve);
    for (const o of mcpApproveCommand.options ?? []) {
      if (o.default !== undefined) approve.option(o.flags, o.description, o.default);
      else approve.option(o.flags, o.description);
    }
    approve.action(async (server: string, _options: Record<string, unknown>, command: Command) => {
      process.exitCode = await runCapability(mcpApproveCommand, command, {
        positionalRoot: false,
        optionOverrides: { server },
      });
    });
  }
  program.addCommand(cmd);
}

/**
 * Register every command on the program. `extra` carries EXTERNAL plugin specs
 * (see src/plugins/registry.ts, already gated + collision-free): they flow
 * through the IDENTICAL registerSpec path as the built-ins — same shared
 * flags, same optional `[root]` positional, same runCapability action (posture
 * resolution, dirty-worktree gate, run ledger). TOP-LEVEL specs only: a plugin
 * cannot contribute subcommands to a parent group (trust/skill/pack/…) in v1.
 *
 * Containment: built-ins register OUTSIDE any try/catch — a throw there is a
 * core bug that must crash loudly. Each plugin spec registers inside its own
 * try/catch: a Commander throw (e.g. a flag conflict the structural gate
 * cannot predict) drops THAT spec with a warning pushed to the `warnings`
 * sink, and every other command stays live.
 */
export function registerCommands(
  program: Command,
  extra: CommandSpec[] = [],
  warnings?: string[],
): void {
  for (const spec of ALL_COMMANDS) registerSpec(program, spec);
  for (const spec of extra) {
    try {
      registerSpec(program, spec);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warnings?.push(
        `plugin command "${sanitizeLabel(spec.name)}" failed to register (${sanitizeLabel(detail, 200)}); dropped`,
      );
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

  const skillspectorPin = trust
    .command(trustSkillspectorPinCommand.name)
    .description(trustSkillspectorPinCommand.summary);
  addSharedFlags(skillspectorPin);
  for (const o of trustSkillspectorPinCommand.options ?? []) {
    if (o.default !== undefined) skillspectorPin.option(o.flags, o.description, o.default);
    else skillspectorPin.option(o.flags, o.description);
  }
  skillspectorPin.action(async (_options: Record<string, unknown>, command: Command) => {
    process.exitCode = await runCapability(trustSkillspectorPinCommand, command, {
      positionalRoot: false,
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

  // `capability` is the local package-manager surface: read/resolve committed
  // repo intent, then maintain the derived machine cache under ~/.aih.
  const capability = program
    .command("capability")
    .description("Resolve and prune the derived machine capability cache");
  for (const spec of [capabilityResolveCommand, capabilityPruneCommand]) {
    const sub = capability.command(spec.name).description(spec.summary);
    addSharedFlags(sub);
    for (const o of spec.options ?? []) {
      if (o.default !== undefined) sub.option(o.flags, o.description, o.default);
      else sub.option(o.flags, o.description);
    }
    sub.action(async (_options: Record<string, unknown>, command: Command) => {
      process.exitCode = await runCapability(spec, command, { positionalRoot: false });
    });
  }

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

  // `policy` mirrors the `marketplace` group: options-only subcommands (no
  // positional). `validate` is the read-only schema gate over the local
  // aih-org-policy.json (or, under --bundle, a policy-bundle envelope).
  const policy = program
    .command("policy")
    .description("Validate the org policy — the local aih-org-policy.json or a policy-bundle");
  for (const spec of [policyValidateCommand, policyVerifyCommand]) {
    const sub = policy.command(spec.name).description(spec.summary);
    addSharedFlags(sub);
    for (const o of spec.options ?? []) {
      if (o.default !== undefined) sub.option(o.flags, o.description, o.default);
      else sub.option(o.flags, o.description);
    }
    sub.action(async (_options: Record<string, unknown>, command: Command) => {
      process.exitCode = await runCapability(spec, command, { positionalRoot: false });
    });
  }

  // `evidence` mirrors the same options-only shape: `build` packages the
  // governance artifacts aih already emits into a verifiable, bundle-standard
  // directory (re-checked by `aih verify-bundle`).
  const evidence = program
    .command("evidence")
    .description("Package aih's committed governance artifacts into a verifiable evidence bundle");
  for (const spec of [evidenceBuildCommand]) {
    const sub = evidence.command(spec.name).description(spec.summary);
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
