import { basename, resolve } from "node:path";
import { readAihConfig } from "../config/marker.js";
import { type CommandSpec, digest, type PlanContext, plan, probe } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { Check } from "../internals/verify.js";
import {
  type BootloaderState,
  type CanonClassification,
  classifyCanon,
  isAdoptable,
} from "./classify.js";

/** Per-bootloader op label for the migration preview (Phase 1: analysis only). */
function bootloaderLine(b: BootloaderState): string {
  if (b.hasMarker && b.bodyMatches) {
    return `  [keep]   ${b.path} — managed block already current`;
  }
  if (b.hasMarker) {
    const ext =
      b.preservedLines > 0
        ? `~${b.preservedLines} project line(s) preserved → rules/project-canon-extension.md`
        : "no project lines to preserve";
    return `  [adopt]  ${b.path} — managed block diverges; ${ext}`;
  }
  return `  [insert] ${b.path} — no managed block; aih block will be inserted (hand-edits preserved)`;
}

/**
 * Human-readable migration preview built purely from the read-only
 * classification. Phase 1 reports intent (`[adopt]`/`[keep]`/`[insert]`/`[retire]`)
 * — it never writes. The `[adopt]`/carve mechanics land in Phase 2.
 */
function migrationReport(cls: CanonClassification, repo: string, contextDir: string): string {
  if (cls.kind === "greenfield") {
    return lines(
      `Adopt analysis for ${repo} — class: greenfield.`,
      "",
      `No adoptable canon under \`${contextDir}\`. Run \`aih init\` (or \`aih bootstrap-ai\`)`,
      "to create the managed canon from scratch.",
    );
  }
  if (cls.kind === "already-adopted") {
    return lines(
      `Adopt analysis for ${repo} — class: already-adopted.`,
      "",
      "Canon is already on aih's managed model — nothing to adopt.",
      "`aih bootstrap-ai --verify` is the ongoing drift gate.",
    );
  }

  const body: string[] = [
    `Adopt analysis for ${repo} — class: ${cls.kind}.`,
    "",
    "Existing canon detected. `aih adopt` converges it onto aih's managed model",
    "WITHOUT overwriting your work. This run is READ-ONLY (Phase 1: analysis only).",
    "",
    "Bootloaders:",
    ...cls.bootloaders.map(bootloaderLine),
  ];
  body.push(
    "",
    "Canon:",
    `  ${cls.routerPresent ? "[converge]" : "[create]"} ${contextDir}/RULE_ROUTER.md — ${cls.routerPresent ? "present; project sections re-referenced" : "missing; will be created"}`,
  );
  if (cls.legacyArtifacts.length > 0) {
    body.push(
      "",
      "Legacy to retire (Phase 2 → .aih/legacy/):",
      ...cls.legacyArtifacts.map((p) => `  [retire] ${p} — superseded by \`aih bootstrap-ai\``),
    );
  }
  body.push(
    "",
    "Next: `aih adopt --apply` (Phase 2) performs the carve + regenerate, then",
    "`aih bootstrap-ai --verify` must report every bootloader in sync.",
  );
  return lines(...body);
}

/**
 * Verify/JSON/support routing for the analysis: a brownfield canon not yet on the
 * managed model surfaces as a `skip` carrying `canon.adoptable` (advisory — never a
 * hard fail), so `--json`/`--support-out` can route it like every other finding.
 */
function adoptableProbe(cls: CanonClassification): Check {
  const name = "adoptable-canon";
  if (isAdoptable(cls.kind) && !cls.configPresent) {
    return {
      name,
      verdict: "skip",
      detail: `existing AI canon detected (${cls.kind}) — run \`aih adopt\` to converge it onto the managed model`,
      code: "canon.adoptable",
    };
  }
  if (cls.kind === "already-adopted") {
    return { name, verdict: "pass", detail: "canon already on the managed model" };
  }
  return { name, verdict: "pass", detail: "no foreign canon to adopt" };
}

/**
 * `aih adopt` — converge a repo's EXISTING AI canon onto aih's managed model
 * instead of bulldozing it (the brownfield path `init`/`bootstrap-ai` lack).
 *
 * Phase 1 (this command today) is READ-ONLY: it classifies the canon
 * ({@link classifyCanon}) and prints a migration preview as a digest, plus a
 * `canon.adoptable` advisory under `--verify`/`--json`. The `--apply` carve +
 * regenerate path lands in Phase 2; until then `--apply` writes nothing.
 */
async function adoptPlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  // The committed marker is authoritative for which context dir to inspect — same
  // precedence `doctor` uses, so adopt and doctor never disagree on the dir.
  const cfg = readAihConfig(ctx.root);
  const contextDir = cfg?.contextDir ?? ctx.contextDir;
  // Resolve before basename so a `.`/relative root still names the repo dir.
  const repo = basename(resolve(ctx.root)) || "this repo";
  const cls = classifyCanon(ctx.root, contextDir);

  return plan(
    "adopt",
    digest("adopt: canon migration analysis", migrationReport(cls, repo, contextDir), cls),
    probe("adoptable canon", () => adoptableProbe(cls)),
  );
}

export const command: CommandSpec = {
  name: "adopt",
  summary:
    "Analyze and converge an existing AI canon onto aih's managed model (brownfield migration; Phase 1: read-only)",
  options: [],
  plan: adoptPlan,
};
