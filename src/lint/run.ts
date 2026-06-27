/**
 * Wire the {@link RULES} into aih's plan/verify model.
 *
 * `bootstrap-ai` lints the docs it is ABOUT to write — in memory, before they
 * become writes — so reference resolution can see the full set of paths the same
 * plan will create (a forward `#[[file:…]]` ref resolves even on a fresh repo).
 * `doctor` is read-only and can't recompute the plan, so it lints the canon
 * already on disk. Both surface findings as {@link Check}s: a fail-tier finding
 * flips the verify exit code; an info-tier finding is `skip` (report-only).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import { type Action, type PlanContext, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { type LintRuleCtx, lintDoc } from "./rules.js";

/** A doc to lint: its repo-relative POSIX path and the exact string aih emits. */
export interface GeneratedDoc {
  path: string;
  source: string;
}

/** Roll a doc's findings into one fail-closed {@link Check}. */
function checkFor(path: string, source: string, rctx: LintRuleCtx): Check {
  const name = `lint ${path}`;
  const findings = lintDoc(path, source, rctx);
  const fails = findings.filter((f) => f.severity === "fail");
  if (fails.length > 0) {
    return {
      name,
      verdict: "fail",
      detail: fails.map((f) => `${f.ruleId}: ${f.message}`).join("; "),
      code: "canon.lint-failed",
    };
  }
  const infos = findings.filter((f) => f.severity === "info");
  if (infos.length > 0) {
    return {
      name,
      verdict: "skip",
      detail: infos.map((f) => `${f.ruleId}: ${f.message}`).join("; "),
    };
  }
  return { name, verdict: "pass", detail: "weak-model-safe" };
}

/**
 * One lint probe per generated canon doc, for the `bootstrap-ai` plan. Refs
 * resolve against `plannedPaths` (what this run will write) ∪ `existsSync`
 * (pre-existing repo files). Pure: string regex + `existsSync`, no spawn.
 */
export function lintProbes(
  generated: readonly GeneratedDoc[],
  plannedPaths: ReadonlySet<string>,
  root: string,
): Action[] {
  const fileExists = (rel: string): boolean => existsSync(join(root, rel));
  return generated.map(({ path, source }) =>
    probe(
      `lint ${path}`,
      (_ctx: PlanContext): Check => checkFor(path, source, { path, plannedPaths, fileExists }),
    ),
  );
}

/** Recursively collect repo-relative POSIX paths of `.md` files under `absDir`. */
function markdownUnder(root: string, absDir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(absDir).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(absDir, entry);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) markdownUnder(root, abs, out);
    else if (entry.endsWith(".md")) out.push(abs.slice(root.length + 1).replace(/\\/g, "/"));
  }
}

/**
 * Read-only lint of the canon already written under `contextDir`, aggregated into
 * one {@link Check} for `aih doctor`. Lints only the harness-authored context dir
 * tree (never the root bootloaders, which carry user prose outside the managed
 * block). `skip` when the dir isn't scaffolded — never fail a fresh repo.
 */
export function canonLintCheck(root: string, contextDir: string): Check {
  const name = "canon markdown lint";
  const dir = join(root, contextDir);
  if (!existsSync(dir)) {
    return {
      name,
      verdict: "skip",
      detail: `${contextDir} not scaffolded — run \`aih scaffold --apply\``,
    };
  }
  const rels: string[] = [];
  markdownUnder(root, dir, rels);
  const fileExists = (rel: string): boolean => existsSync(join(root, rel));
  // The on-disk canon set IS the resolution target: a bare `RULE_ROUTER.md` ref
  // resolves by basename against `ai-coding/RULE_ROUTER.md` here, exactly as it
  // resolves against `plannedPaths` during `bootstrap-ai`.
  const onDisk: ReadonlySet<string> = new Set(rels);
  const fails: string[] = [];
  const infos: string[] = [];
  for (const rel of rels) {
    const source = readIfExists(join(root, rel));
    if (source === undefined) continue;
    const findings = lintDoc(rel, source.replace(/\r\n/g, "\n"), {
      path: rel,
      plannedPaths: onDisk,
      fileExists,
    });
    for (const f of findings) {
      const line = `${rel} — ${f.ruleId}: ${f.message}`;
      (f.severity === "fail" ? fails : infos).push(line);
    }
  }
  if (fails.length > 0)
    return { name, verdict: "fail", detail: fails.join("; "), code: "canon.lint-failed" };
  if (infos.length > 0) return { name, verdict: "skip", detail: infos.join("; ") };
  return { name, verdict: "pass", detail: `${rels.length} canon file(s) weak-model-safe` };
}
