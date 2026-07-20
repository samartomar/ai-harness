import { AihError } from "../../../errors.js";
import { executePlan, type PlanResult } from "../../../internals/execute.js";
import {
  type Action,
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
  structuredChecksProbe,
} from "../../../internals/plan.js";
import type { Check } from "../../../internals/verify.js";
import {
  applyClaudeCleanup,
  type ClaudeCleanupApplyResult,
  type ClaudeCleanupPlan,
  type ClaudeCleanupRollbackResult,
  type ClaudeCleanupStep,
  planClaudeCleanup,
  rollbackClaudeCleanup,
} from "./cleanup.js";
import { type ClaudeContaminationReport, claudeContaminationReport } from "./contamination.js";
import { claudeHomeDir } from "./plugin-identity.js";

/**
 * `aih cleanup` — CLI registration for the D14 Claude USER-scope cleanup
 * library (`./cleanup.ts` + `./contamination.ts`); this module holds no
 * cleanup/rollback logic of its own, only flag handling + rendering over the
 * already-tested library.
 *
 * Locked product rule: opt-in and PREVIEWED. A bare `aih cleanup` only reads
 * (contamination report + cleanup plan) and never writes; `--apply` executes
 * the plan through {@link applyClaudeCleanup} (backup-first, fail-closed);
 * `--rollback <root>` restores a prior backup through
 * {@link rollbackClaudeCleanup}. The library's own typed errors (a refused,
 * tampered rollback manifest; an unsafe plan target) are never caught here —
 * they propagate so `runCapability` surfaces them as a failed command with
 * the library's message.
 *
 * Registered like `ecc`/`superpowers` (src/commands/index.ts wires
 * `deps.execute = executeClaudeCleanupCommand` for this spec): the real
 * mutation happens directly against the HOME scope, not the project root the
 * shared `executePlan` write engine root-contains against (see cleanup.ts's
 * own "WRITE MECHANISM" note), so apply/rollback run HERE, imperatively,
 * BEFORE a small read-only summary `Plan` (one `digest` action, plus a
 * failing `probe` check when an apply fails) is handed to `executePlan` —
 * purely for its rendering/exit-code plumbing. `skipWorktreeGate` is set
 * because every write this command makes targets the user's home, never the
 * project's git worktree.
 */

function stepLine(step: ClaudeCleanupStep): string {
  return `  - ${step.action} ${step.surface} [${step.attribution}] ${step.path}`;
}

function stepLines(steps: readonly ClaudeCleanupStep[]): string[] {
  return steps.length > 0 ? steps.map(stepLine) : ["  (none)"];
}

function pathLines(paths: readonly string[]): string[] {
  return paths.length > 0 ? paths.map((p) => `  - ${p}`) : ["  (none)"];
}

function leakageLine(report: ClaudeContaminationReport): string {
  const { skills, agents, hooks, rules, plugins, mcpServers } = report.leakage;
  return `Leakage: ${skills} skills, ${agents} agents, ${hooks} hooks, ${rules} rules, ${plugins} plugins, ${mcpServers} mcpServers`;
}

function previewText(report: ClaudeContaminationReport, cleanupPlan: ClaudeCleanupPlan): string {
  const lines = [
    report.clean ? "Claude user scope is clean." : "Claude user scope has contamination.",
    leakageLine(report),
    "",
    "Planned steps:",
    ...stepLines(cleanupPlan.steps),
  ];
  if (cleanupPlan.skipped.length > 0) {
    lines.push(
      "",
      "Skipped (unknown attribution — pass --include-unknown to widen):",
      ...stepLines(cleanupPlan.skipped),
    );
  }
  if (report.warnings.length > 0) {
    lines.push("", "Warnings:", ...report.warnings.map((w) => `  - ${w}`));
  }
  lines.push(
    "",
    "Nothing was changed by this preview. Pass --apply to execute this plan " +
      "(a timestamped backup is written first, and can be undone with --rollback).",
  );
  return lines.join("\n");
}

function applyText(result: ClaudeCleanupApplyResult): string {
  const lines = [
    `Backup: ${result.backupRoot}`,
    `Status: ${result.status}`,
    "Completed:",
    ...stepLines(result.completed),
  ];
  if (result.skippedAbsent.length > 0) {
    lines.push("Skipped (already absent):", ...stepLines(result.skippedAbsent));
  }
  if (result.pending.length > 0) {
    lines.push("Pending (not executed):", ...stepLines(result.pending));
  }
  if (result.error !== undefined) lines.push(`Error: ${result.error}`);
  lines.push(`Rollback with: aih cleanup --rollback ${result.backupRoot}`);
  return lines.join("\n");
}

function rollbackText(result: ClaudeCleanupRollbackResult): string {
  const lines = ["Restored:", ...pathLines(result.restored)];
  if (result.skippedDrifted.length > 0) {
    lines.push(
      "Skipped (drifted — not overwritten):",
      ...result.skippedDrifted.map((d) => `  - ${d.path}: ${d.reason}`),
    );
  }
  return lines.join("\n");
}

/** The contamination report + the cleanup plan it drives, for the current `ctx.options`. */
function buildCleanupPlan(ctx: PlanContext): {
  home: string;
  report: ClaudeContaminationReport;
  cleanupPlan: ClaudeCleanupPlan;
} {
  const home = claudeHomeDir(ctx.env);
  const report = claudeContaminationReport({ home, projectRoot: ctx.root });
  const cleanupPlan = planClaudeCleanup(report, {
    includeUnknown: ctx.options.includeUnknown === true,
  });
  return { home, report, cleanupPlan };
}

/** Read-only preview: the contamination report + the cleanup plan it drives. Never writes. */
async function claudeCleanupPreviewPlan(ctx: PlanContext): Promise<Plan> {
  const { report, cleanupPlan } = buildCleanupPlan(ctx);
  return plan(
    "claude-cleanup: preview",
    digest("Claude user-scope cleanup preview", previewText(report, cleanupPlan), {
      report,
      plan: cleanupPlan,
    }),
  );
}

/**
 * Drive the D14 cleanup library: `--rollback <root>` restores a prior backup;
 * otherwise a bare run previews (read-only) and `--apply` executes. Flag
 * refusals are typed usage errors (`AIH_CONFIG`); the library's own typed
 * errors are never caught, only surfaced.
 */
export async function executeClaudeCleanupCommand(ctx: PlanContext): Promise<PlanResult> {
  const rollbackBackupRoot =
    typeof ctx.options.rollback === "string" && ctx.options.rollback.length > 0
      ? ctx.options.rollback
      : undefined;
  const includeUnknown = ctx.options.includeUnknown === true;

  if (rollbackBackupRoot !== undefined) {
    if (ctx.apply) {
      throw new AihError("--rollback cannot be combined with --apply", "AIH_CONFIG");
    }
    if (includeUnknown) {
      throw new AihError("--rollback cannot be combined with --include-unknown", "AIH_CONFIG");
    }
    const result = rollbackClaudeCleanup(rollbackBackupRoot, { home: claudeHomeDir(ctx.env) });
    return executePlan(
      plan(
        "claude-cleanup: rollback",
        digest("Claude user-scope cleanup rollback", rollbackText(result), result),
      ),
      ctx,
      { skipWorktreeGate: true },
    );
  }

  if (!ctx.apply) {
    return executePlan(await claudeCleanupPreviewPlan(ctx), ctx, { skipWorktreeGate: true });
  }

  const { home, cleanupPlan } = buildCleanupPlan(ctx);
  const applyResult = applyClaudeCleanup(cleanupPlan, { home });

  const actions: Action[] = [
    digest("Claude user-scope cleanup apply", applyText(applyResult), applyResult),
  ];
  if (applyResult.status === "failed") {
    const failure: Check = {
      name: "aih cleanup --apply",
      verdict: "fail",
      detail: applyResult.error ?? "cleanup apply failed",
    };
    actions.push(structuredChecksProbe("aih cleanup --apply", () => [failure]));
  }
  return executePlan(plan("claude-cleanup: apply", ...actions), ctx, { skipWorktreeGate: true });
}

export const command: CommandSpec = {
  name: "cleanup",
  summary:
    "Preview (default) or apply removal of framework-contaminated Claude USER-scope surfaces, with backup + rollback",
  options: [
    {
      flags: "--rollback <backupRoot>",
      description: "restore a prior `aih cleanup --apply` backup by its root path",
    },
    {
      flags: "--include-unknown",
      description: "widen the cleanup plan to include unknown-attribution surfaces too",
    },
  ],
  plan: claudeCleanupPreviewPlan,
  alwaysVerify: true,
  skipWorktreeGate: true,
};
