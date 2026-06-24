import { resolve } from "node:path";
import { upsertManagedBlock } from "./envfile.js";
import { FsTransaction, readIfExists } from "./fsxn.js";
import { deepMerge, parseJsoncText } from "./merge.js";
import type { EnvBlockAction, ExecAction, Plan, PlanContext, WriteAction } from "./plan.js";
import { ensureTrailingNewline, jsonFile } from "./render.js";
import { VerificationReport } from "./verify.js";

export interface WriteSummary {
  path: string;
  describe: string;
  merged: boolean;
  /**
   * Effect relative to current disk state. `unchanged` writes are skipped (no
   * backup); `kept` is a write-once file that already exists (left untouched).
   */
  effect: "create" | "overwrite" | "merge" | "unchanged" | "kept";
}

export interface PlanResult {
  capability: string;
  applied: boolean;
  writes: WriteSummary[];
  docs: { describe: string; path?: string }[];
  probes: { describe: string }[];
  execs: { describe: string; argv: string[]; ran: boolean; code?: number | null; ok?: boolean }[];
  backups: string[];
  report?: VerificationReport;
}

/** Resolve an action path against the context root (absolute paths pass through). */
function resolvePath(ctx: PlanContext, p: string): string {
  return resolve(ctx.root, p);
}

/** Compute final file contents for a write action, applying JSON merge if requested. */
export function resolveContents(action: WriteAction, absPath: string): string {
  if (action.json !== undefined) {
    if (action.merge) {
      const existing = readIfExists(absPath);
      const base = existing !== undefined ? parseJsoncText(existing) : undefined;
      const merged = base !== undefined ? deepMerge(base, action.json) : action.json;
      return jsonFile(merged);
    }
    return jsonFile(action.json);
  }
  return ensureTrailingNewline(action.contents ?? "");
}

/**
 * Execute a plan. In dry-run (`ctx.apply === false`) nothing is written — the
 * result still reports exactly what would change. With `ctx.apply` writes are
 * committed transactionally; with `ctx.verify` probe actions run and populate a
 * {@link VerificationReport}.
 */
export async function executePlan(plan: Plan, ctx: PlanContext): Promise<PlanResult> {
  const txn = new FsTransaction();
  const writes: WriteSummary[] = [];
  const docs: PlanResult["docs"] = [];
  const probes: PlanResult["probes"] = [];
  const execActions: ExecAction[] = [];
  const envBlockActions: EnvBlockAction[] = [];

  for (const action of plan.actions) {
    if (action.kind === "write") {
      const absPath = resolvePath(ctx, action.path);
      const existing = readIfExists(absPath);
      if (action.once && existing !== undefined) {
        // Write-once seed file already present — preserve the user's content.
        writes.push({
          path: action.path,
          describe: action.describe,
          merged: false,
          effect: "kept",
        });
      } else {
        const contents = resolveContents(action, absPath);
        // Skip a write whose rendered content already matches disk — true idempotency:
        // no rewrite, no `.aih.bak`, surfaced as `unchanged` in the plan.
        const effect: WriteSummary["effect"] =
          existing === undefined
            ? "create"
            : existing === contents
              ? "unchanged"
              : action.merge
                ? "merge"
                : "overwrite";
        if (ctx.apply && effect !== "unchanged") txn.stage(absPath, contents, action.mode);
        writes.push({
          path: action.path,
          describe: action.describe,
          merged: Boolean(action.merge),
          effect,
        });
      }
    } else if (action.kind === "doc") {
      if (action.path && ctx.apply) {
        txn.stage(resolvePath(ctx, action.path), ensureTrailingNewline(action.text));
      }
      docs.push({ describe: action.describe, path: action.path });
    } else if (action.kind === "exec") {
      execActions.push(action);
    } else if (action.kind === "envblock") {
      envBlockActions.push(action);
    } else {
      probes.push({ describe: action.describe });
    }
  }

  // Fold env-block actions per file so multiple scopes COMPOSE (rather than the
  // last write clobbering earlier ones): start from on-disk content and upsert
  // each scope's managed block in order.
  const envByPath = new Map<string, { display: string; blocks: EnvBlockAction[] }>();
  for (const b of envBlockActions) {
    const abs = resolvePath(ctx, b.path);
    const group = envByPath.get(abs) ?? { display: b.path, blocks: [] };
    group.blocks.push(b);
    envByPath.set(abs, group);
  }
  for (const [absPath, { display, blocks }] of envByPath) {
    const existing = readIfExists(absPath);
    let content = existing ?? "";
    for (const b of blocks) {
      content = upsertManagedBlock(content, b.scope, b.vars, b.shell);
    }
    const effect: WriteSummary["effect"] =
      existing === undefined ? "create" : existing === content ? "unchanged" : "merge";
    if (ctx.apply && effect !== "unchanged") txn.stage(absPath, content);
    writes.push({
      path: display,
      describe: `managed env block(s): ${blocks.map((b) => b.scope).join(", ")}`,
      merged: true,
      effect,
    });
  }

  let backups: string[] = [];
  if (ctx.apply) {
    backups = txn.commit().backups;
  }

  // Local mutating commands run only on apply, after files are in place.
  const execs: PlanResult["execs"] = [];
  for (const a of execActions) {
    if (ctx.apply) {
      const res = await ctx.run(a.argv);
      execs.push({
        describe: a.describe,
        argv: a.argv,
        ran: true,
        code: res.code,
        ok: res.code === 0 || Boolean(a.allowFailure),
      });
    } else {
      execs.push({ describe: a.describe, argv: a.argv, ran: false });
    }
  }

  let report: VerificationReport | undefined;
  if (ctx.verify) {
    report = new VerificationReport();
    for (const action of plan.actions) {
      if (action.kind === "probe") {
        report.add(await action.run(ctx));
      }
    }
  }

  return {
    capability: plan.capability,
    applied: ctx.apply,
    writes,
    docs,
    probes,
    execs,
    backups,
    report,
  };
}

/** Human-readable summary of a plan result (used when --json is off). */
export function summarizeResult(result: PlanResult): string {
  const head = result.applied
    ? `Applied ${result.capability}`
    : `Plan for ${result.capability} (dry-run — nothing written; pass --apply to execute)`;
  const out: string[] = [head];
  for (const w of result.writes) {
    out.push(`  [${w.effect}] ${w.path} — ${w.describe}`);
  }
  for (const d of result.docs) {
    out.push(`  [doc]${d.path ? ` ${d.path}` : ""} — ${d.describe}`);
  }
  for (const e of result.execs) {
    const status = e.ran ? ` (exit ${e.code})` : " (run with --apply)";
    out.push(`  [exec] ${e.argv.join(" ")} — ${e.describe}${status}`);
  }
  for (const p of result.probes) {
    out.push(`  [probe] ${p.describe}${result.report ? "" : " (run with --verify)"}`);
  }
  if (result.report) {
    out.push("Verification:");
    out.push(result.report.summary());
  }
  if (result.backups.length > 0) {
    out.push(`  backups: ${result.backups.length} file(s) saved as *.aih.bak`);
  }
  return out.join("\n");
}
