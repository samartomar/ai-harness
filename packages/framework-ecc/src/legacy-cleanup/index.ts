import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Action,
  type Cli,
  cliRegistryEntry,
  digest,
  ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH,
  ECC_PROFILE_INSTALLATION_TRUST_V1,
  FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH,
  LEGACY_ECC_HOOK_CONTROLS_RECEIPT_PATH,
  NATIVE_ECC_REGISTRATION_RECEIPT,
  type PlanContext,
  parseExplicitAddReceipt,
  planFrameworkHookControlsProjection,
  planNativeEccCleanup,
  readContainedRegularFile,
  readFrameworkHookControlsReceipt,
  readRegistrationLedgerSnapshot,
} from "@aihq/core/framework-host";
import { eccPruneReconciliationActions } from "../ecc/prune-reconcile.js";
import {
  GOVERNED_CODEX_ROLE_RECEIPT,
  planGovernedCodexRoleRegistration,
} from "../profile/governed-codex-roles.js";
import {
  ECC_PROFILE_OWNERSHIP_PATH,
  planInstalledEccProfileLifecycle,
  readEccProfileOwnership,
} from "../profile/lifecycle.js";
import { planExplicitEccMcpRemoveMany } from "./explicit-mcp.js";
import { legacyManifestCleanupActions } from "./manifest.js";
import { materializationPruneActions } from "./materialization.js";

/**
 * Legacy aih ECC ownership inventory. Each row names its proof, never a
 * destination pattern: machine registration ledger + independently verified
 * driver state; profile ownership + native registration receipts; governed
 * Codex role registration receipt; direct
 * materialization receipt; explicit MCP receipt; Codex managed block, TOML and
 * scoped MCP state; Kiro created-file manifest; current and legacy hook-control
 * receipts; and scoped JSON MCP writes by the verified driver. The last family
 * has no per-entry aih receipt, so it is report-only. Unchanged receipt-owned
 * entries may be subtracted; modified, unowned, ambiguous, or shared content
 * stays in place with its evidence for a later retry or manual review.
 */

function manual(path: string, detail: string): Action {
  return digest("Legacy ECC manual review", `${path}: ${detail}`, { path, detail });
}

function retired(target: Cli, dropped: readonly Cli[], kept?: readonly Cli[]): boolean {
  return dropped.includes(target) || (kept !== undefined && !kept.includes(target));
}

function profileTargets(destinations: readonly string[]): Cli[] | undefined {
  const targets: Cli[] = [];
  for (const destination of destinations) {
    const prefix = destination.split("/")[0];
    const target = prefix === ".claude" ? "claude" : prefix === ".codex" ? "codex" : undefined;
    if (target === undefined) return undefined;
    targets.push(target);
  }
  return targets;
}

function profileActions(
  ctx: PlanContext,
  mode: "uninstall" | "prune",
  dropped: readonly Cli[],
  kept?: readonly Cli[],
): Action[] {
  const receipt = readContainedRegularFile(ctx.root, ECC_PROFILE_OWNERSHIP_PATH, {
    maxBytes: 4 * 1024 * 1024,
  });
  if (receipt.state === "absent") return [];
  if (receipt.state !== "present")
    return [
      manual(
        ECC_PROFILE_OWNERSHIP_PATH,
        `unsafe ownership receipt (${receipt.reason}); preserve profile files`,
      ),
    ];
  try {
    if (mode === "prune") {
      const ownership = readEccProfileOwnership(ctx.root);
      const targets = profileTargets(ownership?.files.map((file) => file.destination) ?? []);
      if (targets === undefined || targets.some((target) => !retired(target, dropped, kept))) {
        return [
          manual(
            ECC_PROFILE_OWNERSHIP_PATH,
            "profile spans a live or unknown target; keep the whole receipt and its files",
          ),
        ];
      }
    }
    return planInstalledEccProfileLifecycle(
      ctx.root,
      "uninstall",
      ECC_PROFILE_INSTALLATION_TRUST_V1,
    ).actions;
  } catch (error) {
    return [
      manual(ECC_PROFILE_OWNERSHIP_PATH, `${(error as Error).message}; preserve profile files`),
    ];
  }
}

function nativeActions(
  ctx: PlanContext,
  mode: "uninstall" | "prune",
  dropped: readonly Cli[],
  kept?: readonly Cli[],
): Action[] {
  const receipt = readContainedRegularFile(ctx.root, NATIVE_ECC_REGISTRATION_RECEIPT, {
    maxBytes: 4 * 1024 * 1024,
  });
  if (receipt.state === "absent") return [];
  if (receipt.state !== "present")
    return [
      manual(
        NATIVE_ECC_REGISTRATION_RECEIPT,
        `unsafe ownership receipt (${receipt.reason}); preserve registrations`,
      ),
    ];
  if (mode === "prune" && (!retired("claude", dropped, kept) || !retired("codex", dropped, kept))) {
    return [
      manual(
        NATIVE_ECC_REGISTRATION_RECEIPT,
        "native registration spans Claude and Codex; keep live target entries",
      ),
    ];
  }
  try {
    return planNativeEccCleanup(ctx.root, "uninstall").actions;
  } catch (error) {
    return [
      manual(
        NATIVE_ECC_REGISTRATION_RECEIPT,
        `${(error as Error).message}; preserve registrations`,
      ),
    ];
  }
}

function explicitMcpActions(
  ctx: PlanContext,
  mode: "uninstall" | "prune",
  dropped: readonly Cli[],
  kept?: readonly Cli[],
): Action[] {
  const receipt = readContainedRegularFile(ctx.root, ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH, {
    maxBytes: 2 * 1024 * 1024,
  });
  if (receipt.state === "absent") return [];
  if (receipt.state !== "present")
    return [
      manual(
        ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH,
        `unsafe receipt (${receipt.reason}); preserve MCP entries`,
      ),
    ];
  let records: ReturnType<typeof parseExplicitAddReceipt>["records"];
  try {
    records = parseExplicitAddReceipt(JSON.parse(receipt.contents.toString("utf8"))).records;
  } catch (error) {
    return [
      manual(
        ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH,
        `${(error as Error).message}; preserve MCP entries`,
      ),
    ];
  }
  const selected = records.filter(
    (record) => mode === "uninstall" || retired(record.target as Cli, dropped, kept),
  );
  if (selected.length === 0) return [];
  const home = ctx.env.HOME ?? ctx.env.USERPROFILE;
  return planExplicitEccMcpRemoveMany({
    root: ctx.root,
    ...(home === undefined ? {} : { home }),
    selected,
  }).actions;
}

function hookControlsActions(
  ctx: PlanContext,
  mode: "uninstall" | "prune",
  dropped: readonly Cli[],
  kept?: readonly Cli[],
): Action[] {
  if (mode === "prune" && !retired("claude", dropped, kept)) return [];
  const actions: Action[] = [];
  const legacy = readContainedRegularFile(ctx.root, LEGACY_ECC_HOOK_CONTROLS_RECEIPT_PATH, {
    maxBytes: 64 * 1024,
  });
  if (legacy.state !== "absent") {
    actions.push(
      manual(
        LEGACY_ECC_HOOK_CONTROLS_RECEIPT_PATH,
        "legacy receipt has no authenticated per-key value reader; inspect .claude/settings.json env. Remove ECC_HOOK_PROFILE and ECC_DISABLED_HOOKS only if they match this aih receipt, retain other env entries, then remove the receipt manually",
      ),
    );
  }
  const current = readContainedRegularFile(ctx.root, FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH, {
    maxBytes: 64 * 1024,
  });
  if (current.state === "absent") return actions;
  if (current.state !== "present")
    return [
      ...actions,
      manual(
        FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH,
        `unsafe receipt (${current.reason}); preserve hook settings`,
      ),
    ];
  try {
    const receipt = readFrameworkHookControlsReceipt(ctx.root)?.receipt;
    if (receipt?.frameworks.ecc === undefined) return actions;
    const superpowers = receipt.frameworks.superpowers;
    const plans = new Map();
    if (superpowers !== undefined) plans.set("superpowers", { host: "claude", ...superpowers });
    const projection = planFrameworkHookControlsProjection(ctx, plans);
    return [
      ...actions,
      ...(projection.standaloneSettingsAction === undefined
        ? []
        : [projection.standaloneSettingsAction]),
      ...projection.receiptActions,
    ];
  } catch (error) {
    return [
      ...actions,
      manual(
        FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH,
        `${(error as Error).message}; preserve ECC hook settings`,
      ),
    ];
  }
}

function codexRoleActions(
  ctx: PlanContext,
  mode: "uninstall" | "prune",
  dropped: readonly Cli[],
  kept?: readonly Cli[],
): Action[] {
  if (mode === "prune" && !retired("codex", dropped, kept)) return [];
  const receipt = readContainedRegularFile(ctx.root, GOVERNED_CODEX_ROLE_RECEIPT, {
    maxBytes: 1024 * 1024,
  });
  if (receipt.state === "absent") return [];
  if (receipt.state !== "present")
    return [
      manual(
        GOVERNED_CODEX_ROLE_RECEIPT,
        `unsafe receipt (${receipt.reason}); preserve Codex roles`,
      ),
    ];
  try {
    return planGovernedCodexRoleRegistration(ctx.root, []).actions;
  } catch (error) {
    return [
      manual(GOVERNED_CODEX_ROLE_RECEIPT, `${(error as Error).message}; preserve Codex roles`),
    ];
  }
}

function machineAdvisories(
  ctx: PlanContext,
  mode: "uninstall" | "prune",
  dropped: readonly Cli[],
): Action[] {
  const home = ctx.env.HOME ?? ctx.env.USERPROFILE;
  if (home === undefined) return [];
  const ledger = readRegistrationLedgerSnapshot(home)?.ledger;
  const actions: Action[] = [];
  if (
    !ledger?.targets.some((target) => target.target === "codex") &&
    (existsSync(join(home, ".codex", "ecc-aih-install-state.json")) ||
      existsSync(join(home, ".codex", "AGENTS.md"))) &&
    (mode === "uninstall" || dropped.includes("codex"))
  ) {
    actions.push(
      manual(
        "~/.codex/ecc-aih-install-state.json",
        "Codex home state lacks a project ownership union; inspect ~/.codex/AGENTS.md and config.toml, then subtract only unchanged aih blocks and scoped MCP entries when no other project uses them",
      ),
    );
  }
  for (const target of ledger?.targets ?? []) {
    if (
      target.target === "codex" ||
      target.mcps.length === 0 ||
      (mode === "prune" && !dropped.includes(target.target))
    )
      continue;
    const path = cliRegistryEntry(target.target).mcp.configPath;
    actions.push(
      manual(
        path ?? `${target.target} MCP configuration`,
        `verified-driver scoped MCP entries have no per-entry aih receipt; inspect ${target.mcps.join(", ")} and remove by the host's MCP controls only after confirming each entry is unused`,
      ),
    );
  }
  return actions;
}

export function legacyCleanupActions(
  ctx: PlanContext,
  mode: "uninstall" | "prune",
  dropped: readonly Cli[] = [],
  kept?: readonly Cli[],
): Action[] {
  const native = nativeActions(ctx, mode, dropped, kept);
  const controls = hookControlsActions(ctx, mode, dropped, kept);
  const nativeSettings = native.find(
    (action) => action.kind === "write" && action.path === ".claude/settings.json",
  );
  const controlSettings = controls.find(
    (action) => action.kind === "write" && action.path === ".claude/settings.json",
  );
  if (
    nativeSettings?.kind === "write" &&
    controlSettings?.kind === "write" &&
    typeof nativeSettings.contents === "string" &&
    nativeSettings.expect !== undefined &&
    JSON.stringify(nativeSettings.expect) === JSON.stringify(controlSettings.expect)
  ) {
    const settings = JSON.parse(nativeSettings.contents) as Record<string, unknown>;
    const env = { ...((settings.env ?? {}) as Record<string, unknown>) };
    for (const [key, value] of Object.entries(
      ((controlSettings.json as Record<string, unknown>).env ?? {}) as Record<string, unknown>,
    ))
      env[key] = value;
    for (const key of controlSettings.removeJsonKeys?.env ?? []) delete env[key];
    if (Object.keys(env).length > 0) settings.env = env;
    else delete settings.env;
    nativeSettings.contents = `${JSON.stringify(settings, null, 2)}\n`;
    controls.splice(controls.indexOf(controlSettings), 1);
  }
  return [
    ...profileActions(ctx, mode, dropped, kept),
    ...native,
    ...explicitMcpActions(ctx, mode, dropped, kept),
    ...controls,
    ...codexRoleActions(ctx, mode, dropped, kept),
    ...(mode === "prune" ? materializationPruneActions(ctx.root, dropped, kept) : []),
    ...(mode === "uninstall" || retired("kiro", dropped, kept)
      ? legacyManifestCleanupActions(ctx.root)
      : []),
    ...machineAdvisories(ctx, mode, dropped),
    ...(mode === "uninstall" ? eccPruneReconciliationActions(ctx, [], ctx.root) : []),
  ];
}
