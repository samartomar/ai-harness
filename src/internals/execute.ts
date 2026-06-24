import { resolve } from "node:path";
import { FsTransaction, readIfExists } from "./fsxn.js";
import { deepMerge, parseJsoncText } from "./merge.js";
import type { Plan, PlanContext, WriteAction } from "./plan.js";
import { ensureTrailingNewline, jsonFile } from "./render.js";
import { VerificationReport } from "./verify.js";

export interface WriteSummary {
  path: string;
  describe: string;
  merged: boolean;
  /** "create" | "overwrite" | "merge" relative to current disk state. */
  effect: "create" | "overwrite" | "merge";
}

export interface PlanResult {
  capability: string;
  applied: boolean;
  writes: WriteSummary[];
  docs: { describe: string; path?: string }[];
  probes: { describe: string }[];
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

  for (const action of plan.actions) {
    if (action.kind === "write") {
      const absPath = resolvePath(ctx, action.path);
      const contents = resolveContents(action, absPath);
      const exists = readIfExists(absPath) !== undefined;
      const effect: WriteSummary["effect"] = !exists
        ? "create"
        : action.merge
          ? "merge"
          : "overwrite";
      if (ctx.apply) txn.stage(absPath, contents, action.mode);
      writes.push({
        path: action.path,
        describe: action.describe,
        merged: Boolean(action.merge),
        effect,
      });
    } else if (action.kind === "doc") {
      if (action.path && ctx.apply) {
        txn.stage(resolvePath(ctx, action.path), ensureTrailingNewline(action.text));
      }
      docs.push({ describe: action.describe, path: action.path });
    } else {
      probes.push({ describe: action.describe });
    }
  }

  let backups: string[] = [];
  if (ctx.apply) {
    backups = txn.commit().backups;
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

  return { capability: plan.capability, applied: ctx.apply, writes, docs, probes, backups, report };
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
