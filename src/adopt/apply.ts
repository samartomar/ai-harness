import { existsSync } from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import {
  bootloaderPaths,
  ruleRouterDoc,
  SHARED_MARKER,
  sharedCanonicalBlockBody,
} from "../bootstrap-ai/canon.js";
import { command as bootstrapAiCommand } from "../bootstrap-ai/index.js";
import { AIH_CONFIG_FILE, aihConfigJson, readAihConfigBaseline } from "../config/marker.js";
import {
  DEFAULT_BASELINE_SOURCE_ID,
  resolveBaselineSource,
} from "../internals/baseline-sources.js";
import { resolveTargets } from "../internals/cli-detect.js";
import type { Cli } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
import { extractManagedBlock, splitManagedBody } from "../internals/markers.js";
import { type Action, type PlanContext, writeJson, writeText } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { scanRepo } from "../profile/scan.js";
import type { CanonClassification } from "./classify.js";

/**
 * Canonical CLI ↔ markdown-bootloader map. `adopt` must converge EVERY bootloader
 * the repo already has — not just the default `claude` — or it would leave
 * `AGENTS.md`/`GEMINI.md` divergent and never reach `already-adopted` (a re-run would
 * keep re-carving). A repo with all three resolves to claude+codex+gemini so the one
 * canonical block lands in each.
 */
const BOOTLOADER_CLI: ReadonlyArray<readonly [Cli, string]> = [
  ["claude", "CLAUDE.md"],
  ["codex", "AGENTS.md"],
  ["gemini", "GEMINI.md"],
];

/** The CLIs whose root bootloader already exists in the repo (what adopt converges). */
function existingBootloaderTargets(root: string): Cli[] {
  return BOOTLOADER_CLI.filter(([, p]) => existsSync(join(root, p))).map(([c]) => c);
}

/** Repo-relative path of the carved, user-owned project canon. */
export const EXTENSION_PATH = "rules/project-canon-extension.md";

/** Wrap the carved extension in a clearly user-owned doc the router points at. */
function extensionDoc(dir: string, extension: string): string {
  return lines(
    "# Project canon extension",
    "",
    "> Carved by `aih adopt` from project-specific guidance that was folded into this",
    "> repo's bootloader managed block. It is preserved here as a **user-owned** rule so",
    "> canon regeneration never deletes it — aih does NOT regenerate this file.",
    `> \`${dir}/RULE_ROUTER.md\` lists it under "Always read first".`,
    "",
    "<!-- Everything below is yours; edit freely. aih will not overwrite it. -->",
    "",
    extension,
    "",
  );
}

/**
 * Collect the human "project extension" carved from every divergent bootloader
 * (marker-divergent canon only). Dedupes identical extensions — the three
 * bootloaders usually share one. Returns "" when there's nothing to preserve.
 */
function carveExtension(ctx: PlanContext, cls: CanonClassification, dir: string): string {
  if (cls.kind !== "marker-divergent") return "";
  const canonical = sharedCanonicalBlockBody(dir).trim();
  const parts: string[] = [];
  for (const b of cls.bootloaders) {
    if (!b.hasMarker || b.bodyMatches) continue;
    const text = readIfExists(join(ctx.root, b.path));
    if (text === undefined) continue;
    const onDisk = extractManagedBlock(text, SHARED_MARKER) ?? "";
    const ext = splitManagedBody(onDisk, canonical);
    if (ext.length > 0 && !parts.includes(ext)) parts.push(ext);
  }
  return parts.join("\n\n");
}

/**
 * Build the `aih adopt` write/probe actions for a brownfield repo (Phase 2). The
 * design is **non-destructive convergence**: it reuses `bootstrap-ai`'s canon
 * writers (which regenerate the aih-OWNED files and merge the clean managed block
 * into each bootloader, backing up to `.aih.bak`), but FIRST carves any human
 * project extension out of a divergent bootloader into a user-owned
 * `rules/project-canon-extension.md` — so regenerating the block never deletes it —
 * and swaps the router for one that points at that file. It also persists the
 * `.aih-config.json` marker so a re-run reads `already-adopted`.
 *
 * It never deletes the repo's legacy hand artifacts (the executor has no delete
 * seam, and silent removal is unsafe); those are reported by the digest for the
 * user to retire deliberately.
 */
export async function adoptApplyActions(
  ctx: PlanContext,
  cls: CanonClassification,
  contextDir: string,
): Promise<Action[]> {
  const dir = contextDir;
  const extension = carveExtension(ctx, cls, dir);
  const carving = extension.length > 0;

  // Converge EVERY existing bootloader (not just default `claude`), so the repo
  // actually reaches already-adopted and re-runs are no-ops. Thread the targets
  // through ctx so bootstrap-ai regenerates each one.
  const existing = existingBootloaderTargets(ctx.root);
  const applyCtx: PlanContext = existing.length > 0 ? { ...ctx, targets: existing } : ctx;

  const base = await bootstrapAiCommand.plan(applyCtx);
  const { clis } = await resolveTargets(applyCtx);
  const baseline = resolveBaselineSource(applyCtx.options, readAihConfigBaseline(applyCtx.root));
  const routerRel = posix.join(dir, "RULE_ROUTER.md");

  const actions: Action[] = [];

  // Carve FIRST (write-once: a re-run that already converged won't clobber edits).
  if (carving) {
    actions.push(
      writeText(posix.join(dir, EXTENSION_PATH), extensionDoc(dir, extension), EXTENSION_DESCRIBE, {
        once: true,
      }),
    );
  }

  // Reuse bootstrap-ai's writes + probes. Drop its narrative doc (adopt has its own),
  // and when carving, swap the router for one that references the carved extension —
  // computed from the SAME inputs bootstrap-ai used, so they stay byte-identical
  // apart from that one "Always read first" line.
  const repoName = basename(resolve(applyCtx.root)) || "this repo";
  const stack = scanRepo(applyCtx.root, { maxDepth: 8, contextDir: dir });
  const bootloaders = bootloaderPaths(clis);
  for (const a of base.actions) {
    if (a.kind === "doc") continue;
    if (carving && a.kind === "write" && a.path.replace(/\\/g, "/") === routerRel) {
      actions.push(
        writeText(
          routerRel,
          ruleRouterDoc(dir, repoName, stack, bootloaders, {
            projectExtension: true,
            baseline,
          }),
          a.describe,
        ),
      );
      continue;
    }
    actions.push(a);
  }

  // Persist intent so the next run reads already-adopted (merge keeps adopt.acknowledged).
  actions.push(
    writeJson(
      AIH_CONFIG_FILE,
      aihConfigJson(dir, clis, baseline.id),
      "persist adopt intent (context-dir + targets)",
      {
        merge: true,
        removeJsonTopLevelKeys:
          ctx.options.baseline === DEFAULT_BASELINE_SOURCE_ID ? ["baseline"] : undefined,
      },
    ),
  );

  return actions;
}

const EXTENSION_DESCRIBE =
  "carved project canon (preserved from your prior bootloader; aih won't regenerate it)";
