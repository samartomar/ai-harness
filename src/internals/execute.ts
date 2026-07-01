import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { DirtyWorktreeError, PathContainmentError } from "../errors.js";
import { redactSecrets } from "../guardrails/redact.js";
import { upsertManagedBlock } from "./envfile.js";
import { FsTransaction, readIfExists } from "./fsxn.js";
import { deepMerge, parseJsoncText } from "./merge.js";
import type {
  DigestAction,
  EnvBlockAction,
  ExecAction,
  Plan,
  PlanContext,
  WriteAction,
} from "./plan.js";
import { ensureTrailingNewline, indent, jsonFile, stripTrailingNewlines } from "./render.js";
import { type Check, VerificationReport } from "./verify.js";
import { dirtyWriteTargets, normalizeRel } from "./worktree-gate.js";

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

/**
 * Write a single, explicitly-requested analysis artifact (e.g. a `--sarif` report)
 * to a repo-contained path, transactionally. Returns the backups created (0 or 1).
 *
 * DESIGN — why this is NOT gated on `--apply`: the harness invariant "no writes
 * without --apply" protects the user's MANAGED project surface (bootloaders,
 * configs, the context dir) from being mutated without consent. A `--sarif` file
 * is not part of that surface — it is a report OUTPUT the operator requested by
 * naming its path on the command line, exactly like `report --out` or a test
 * runner writing `junit.xml`. Naming the path IS the consent. Crucially, the
 * primary use case — `aih bootstrap-ai --verify --sarif results.sarif` feeding
 * GitHub code-scanning — runs the drift gate WITHOUT `--apply` (CI must not
 * regenerate the repo it is gating); apply-gating the artifact would make the flag
 * a no-op in exactly the scenario it exists for, or force `--apply` to also rewrite
 * every bootloader. So the artifact is decoupled from the plan's apply gate — but
 * NOT from its safety machinery: the path is still contained to `root`
 * ({@link assertContained}) and an overwrite is still backed up to `*.aih.bak` via
 * {@link FsTransaction}. Re-writing identical bytes is a no-op (no rewrite, no
 * backup churn), matching {@link executePlan}'s idempotency contract.
 */
export function writeArtifact(ctx: PlanContext, relPath: string, contents: string): string[] {
  const absPath = resolvePath(ctx, relPath);
  assertContained(ctx.root, absPath);
  const next = ensureTrailingNewline(contents);
  if (readIfExists(absPath) === next) return [];
  const txn = new FsTransaction();
  txn.stage(absPath, next);
  return txn.commit().backups;
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
 * Of the plan's repo-local targets that are `dirty`, the ones this apply would
 * actually CHANGE (rendered content ≠ disk) — the true clobber set. A `write`/`doc`
 * whose bytes already match disk is a no-op (the main loop records it `unchanged` and
 * writes nothing), so an idempotent re-apply over an uncommitted-but-unchanged file is
 * NOT a clobber and must not gate. A brand-new file (no existing content) and a
 * `write`-once seed can never clobber. `envblock` targets that are dirty are treated
 * conservatively as changes (they recompose a managed block; repo-local ones are rare).
 */
function changedDirtyTargets(plan: Plan, ctx: PlanContext, dirty: Set<string>): string[] {
  const out: string[] = [];
  for (const a of plan.actions) {
    const p =
      a.kind === "write" && a.external !== true
        ? a.path
        : a.kind === "doc" && typeof a.path === "string"
          ? a.path
          : a.kind === "envblock"
            ? a.path
            : undefined;
    if (p === undefined) continue;
    const abs = resolvePath(ctx, p);
    if (!dirty.has(normalizeRel(relative(ctx.root, abs)))) continue;
    const existing = readIfExists(abs);
    if (
      a.kind === "write" &&
      (existing === undefined || a.once || resolveContents(a, abs) === existing)
    ) {
      continue;
    }
    if (a.kind === "doc" && existing === ensureTrailingNewline(a.text)) continue;
    out.push(normalizeRel(relative(ctx.root, abs)));
  }
  return out;
}

/**
 * Execute a plan. In dry-run (`ctx.apply === false`) nothing is written — the
 * result still reports exactly what would change. With `ctx.apply` writes are
 * committed transactionally; with `ctx.verify` probe actions run and populate a
 * {@link VerificationReport}.
 */
export async function executePlan(
  plan: Plan,
  ctx: PlanContext,
  opts: { skipWorktreeGate?: boolean } = {},
): Promise<PlanResult> {
  // Dirty-worktree --apply preflight: refuse only when this apply would write over a
  // file that ITSELF has uncommitted changes — the precise "clobber your work" case —
  // not merely because some unrelated file in the repo is dirty. So creating a new
  // `opencode.json` is allowed on a repo that just has an untracked `codex/` dir
  // elsewhere, while regenerating a `CLAUDE.md` you have uncommitted edits to still
  // gates. `external` writes (global ~/home configs) and write-free runs are never
  // gated; `skipWorktreeGate` exempts pure-analytics commands (`aih report`, whose only
  // writes are gitignored OUTPUT artifacts). The check runs BEFORE anything is staged,
  // so a refusal leaves the worktree byte-for-byte unchanged; git goes through the
  // read-only Runner seam (git-absent / not-a-repo → nothing dirty → not gated).
  if (ctx.apply && opts.skipWorktreeGate !== true && ctx.options.force !== true) {
    const dirtyTargets = new Set(await dirtyWriteTargets(plan, ctx));
    // Effect-aware: a dirty target is only a real clobber if THIS write would change
    // its content. A write whose rendered bytes already match disk is a no-op (the loop
    // below records it `unchanged` and writes nothing), so re-running `aih mcp --apply`
    // over a still-uncommitted but unchanged config must not be blocked.
    const clobbered = dirtyTargets.size === 0 ? [] : changedDirtyTargets(plan, ctx, dirtyTargets);
    if (clobbered.length > 0) {
      const list = clobbered.join(", ");
      throw new DirtyWorktreeError(
        `Refusing to overwrite uncommitted changes in: ${list}. Commit or stash ${
          clobbered.length > 1 ? "them" : "it"
        } first, or pass --force.`,
      );
    }
  }

  const txn = new FsTransaction();
  const writes: WriteSummary[] = [];
  const docs: PlanResult["docs"] = [];
  const probes: PlanResult["probes"] = [];
  const digests: PlanResult["digests"] = [];
  const digestActions: DigestAction[] = [];
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
      digestActions.push(action);
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
  const execFailureChecks: Check[] = [];
  let skipProbesAfterExecFailure = false;
  for (const a of execActions) {
    if (ctx.apply) {
      const res = await ctx.run(a.argv, { cwd: a.cwd, env: a.env, timeoutMs: a.timeoutMs });
      const ok = res.code === 0 || Boolean(a.allowFailure);
      execs.push({
        describe: a.describe,
        argv: a.argv,
        ran: true,
        code: res.code,
        ok,
      });
      if (!ok && a.failureCheck) {
        execFailureChecks.push(
          typeof a.failureCheck === "function" ? a.failureCheck(res) : a.failureCheck,
        );
        if (a.blockProbesOnFailure) skipProbesAfterExecFailure = true;
      }
    } else {
      execs.push({ describe: a.describe, argv: a.argv, ran: false });
    }
  }

  let report: VerificationReport | undefined;
  if (ctx.verify) {
    report = new VerificationReport();
    for (const check of execFailureChecks) report.add(check);
    if (!skipProbesAfterExecFailure) {
      for (const action of plan.actions) {
        if (action.kind === "probe") {
          if (action.runMany) {
            for (const check of await action.runMany(ctx)) report.add(check);
          } else {
            report.add(await action.run(ctx));
          }
        }
      }
    }
  }

  for (const action of digestActions) {
    const evaluated =
      action.run !== undefined
        ? await action.run(ctx)
        : { text: action.text ?? "", data: action.data };
    const text = typeof evaluated === "string" ? evaluated : evaluated.text;
    const data = typeof evaluated === "string" ? action.data : evaluated.data;
    // The single source-side redaction chokepoint: mask secrets in the digest
    // body HERE, upstream of every renderer, so BOTH the human summary and the
    // `--json` output carry the redacted text — automation reading `--json` is
    // the case that matters most. `data` is the raw structured payload; callers
    // must not embed secrets there (recursively redacting arbitrary JSON would
    // risk corrupting legitimate values).
    digests.push({
      describe: action.describe,
      text: redactSecrets(text),
      data,
    });
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
  // "Applied" must mean a mutation was committed. A plan whose only actions are
  // docs/digests/probes writes nothing even under --apply (e.g. an analytics-only
  // command, or an idempotent re-run with no diff), so claiming "Applied" would be
  // misleading. envblock upserts fold into `writes`, so writes+execs+backups cover
  // every mutating outcome.
  const mutated =
    result.writes.length > 0 || result.execs.some((e) => e.ran) || result.backups.length > 0;
  const head = result.applied
    ? mutated
      ? `Applied ${result.capability}`
      : `${result.capability}: nothing to apply — the plan produced no writes or execs`
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
    // Already redacted at the digest-collection chokepoint in executePlan, so the
    // text here (and in `--json`) is consistently masked — no re-redaction needed.
    out.push(indent(stripTrailingNewlines(dg.text), 2));
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
