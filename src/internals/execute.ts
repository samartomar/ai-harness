import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { PathContainmentError } from "../errors.js";
import { upsertManagedBlock } from "./envfile.js";
import { FsTransaction, readIfExists } from "./fsxn.js";
import { deepMerge, parseJsoncText } from "./merge.js";
import type { EnvBlockAction, ExecAction, Plan, PlanContext, WriteAction } from "./plan.js";
import { ensureTrailingNewline, indent, jsonFile } from "./render.js";
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
  /** Read-only computed reports surfaced verbatim (text) + machine-readable (`data`). */
  digests: { describe: string; text: string; data?: unknown }[];
  backups: string[];
  report?: VerificationReport;
}

/** Resolve an action path against the context root (absolute paths pass through). */
function resolvePath(ctx: PlanContext, p: string): string {
  return resolve(ctx.root, p);
}

/** realpath, or a plain resolve if the path does not exist yet. */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Fail closed if a repo-scoped action path escapes the target root. Resolves the
 * deepest EXISTING ancestor through realpath first, so a symlinked/junctioned
 * parent that redirects outside the repo is caught (the not-yet-existing suffix
 * cannot contain links). Host/system writes opt out with `external: true`.
 */
function assertContained(root: string, absPath: string): void {
  const realRoot = realpathSafe(root);
  let ancestor = absPath;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const tail = relative(ancestor, absPath);
  const finalReal = resolve(realpathSafe(ancestor), tail);
  const rel = relative(realRoot, finalReal);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new PathContainmentError(
    `refusing to write outside the target root\n  root:   ${realRoot}\n  target: ${absPath}\n` +
      "(an absolute path, a `..` escape, or a symlinked parent — pass an in-repo relative path)",
  );
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
  const digests: PlanResult["digests"] = [];
  const execActions: ExecAction[] = [];
  const envBlockActions: EnvBlockAction[] = [];

  for (const action of plan.actions) {
    if (action.kind === "write") {
      const absPath = resolvePath(ctx, action.path);
      if (!action.external) assertContained(ctx.root, absPath);
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
      if (action.path) {
        const absPath = resolvePath(ctx, action.path);
        // Contain doc-file writes too (they are repo-scoped guidance, never external),
        // BEFORE the readIfExists below follows the path — so a symlinked/escaping doc
        // path can neither leak an out-of-repo read nor redirect the write.
        assertContained(ctx.root, absPath);
        const contents = ensureTrailingNewline(action.text);
        // Same idempotency contract as write actions: skip a doc-file write whose
        // rendered content already matches disk, so re-running never rewrites it or
        // churns a `.aih.bak`. (The guardrails taxonomy doc was re-backed-up every run.)
        if (ctx.apply && readIfExists(absPath) !== contents) {
          txn.stage(absPath, contents);
        }
      }
      docs.push({ describe: action.describe, path: action.path });
    } else if (action.kind === "exec") {
      execActions.push(action);
    } else if (action.kind === "envblock") {
      envBlockActions.push(action);
    } else if (action.kind === "digest") {
      digests.push({ describe: action.describe, text: action.text, data: action.data });
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
    digests,
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
  for (const dg of result.digests) {
    out.push(`  [digest] — ${dg.describe}`);
    out.push(indent(dg.text.replace(/\n+$/, ""), 2));
  }
  for (const e of result.execs) {
    const status = e.ran ? ` (exit ${e.code})` : " (run with --apply)";
    out.push(`  [exec] ${e.argv.join(" ")} — ${e.describe}${status}`);
  }
  // Only list probes when there's no report to supersede them; otherwise the
  // Verification section below already shows each check with its verdict + detail
  // (listing both just duplicates every line).
  if (!result.report) {
    for (const p of result.probes) {
      out.push(`  [probe] ${p.describe} (run with --verify)`);
    }
  }
  // Only show the verification section when a probe actually ran. A command that
  // always-verifies but has no probes this run (e.g. a bare `aih report` without
  // `--gate`) produces an empty report — printing "0 passed" would be noise.
  if (result.report && result.report.checks.length > 0) {
    out.push("Verification:");
    out.push(result.report.summary());
  }
  if (result.backups.length > 0) {
    out.push(`  backups: ${result.backups.length} file(s) saved as *.aih.bak`);
  }
  return out.join("\n");
}
