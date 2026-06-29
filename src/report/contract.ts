import { readAihConfig } from "../config/marker.js";
import type { ProjectContract } from "../contract/schema.js";
import { readProjectContract } from "../contract/schema.js";
import { unportablePaths } from "../contract/synth.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { ContractSnapshot } from "./advisories.js";

/**
 * Phase 2 — the Repo Contract panel + its advisory snapshot. A READ-ONLY consumer of
 * the committed `project.json` (the v1 seam): it never re-derives the stack and never
 * writes the contract. When no contract is committed the panel is OMITTED (exactly like
 * {@link graphDigests}), so a pre-init / `--canon legacy` repo grows no fabricated panel.
 */

/** Honor the committed context dir (the marker is authoritative), like doctor. */
function resolveContract(ctx: PlanContext): ProjectContract | undefined {
  const contextDir = readAihConfig(ctx.root)?.contextDir ?? ctx.contextDir;
  return readProjectContract(ctx.root, contextDir);
}

/** Count the contract's declared commands, and how many are merely inferred. */
function commandCount(c: ProjectContract): { total: number; inferred: number } {
  const slots = [c.commands.test, c.commands.build, c.commands.lint, c.commands.start];
  const present = slots.filter((x): x is NonNullable<typeof x> => x !== undefined);
  return {
    total: present.length,
    inferred: present.filter((x) => x.confidence === "inferred").length,
  };
}

function scaleLine(c: ProjectContract): string {
  if (c.scale.trackedFiles === undefined) return c.scale.class;
  return `${c.scale.trackedFiles} files · ${c.scale.class}${c.scale.isMonorepo ? " · monorepo" : ""}`;
}

/**
 * The Repo Contract digest — what the committed contract says about this repo, plus a
 * portable-path truth check. Returns `[]` (omitted) when no contract is present.
 */
export function contractTruthDigest(ctx: PlanContext): DigestAction[] {
  const c = resolveContract(ctx);
  if (!c) return [];
  const bad = unportablePaths(c);
  const { total, inferred } = commandCount(c);
  const body = lines(
    `Languages:       ${c.languages.join(", ") || "—"}`,
    `Commands:        ${total} (${total - inferred} detected, ${inferred} inferred)`,
    `Scale:           ${scaleLine(c)}`,
    `Sensitive paths: ${c.sensitivePaths.length}`,
    `Known gaps:      ${c.knownGaps.length}`,
    `Portable paths:  ${bad.length === 0 ? "ok" : `${bad.length} NON-PORTABLE — ${bad.join(", ")}`}`,
  );
  const headline = `Repo contract — ${total} command(s) · ${c.knownGaps.length} known gap(s)${
    bad.length > 0 ? " · paths NOT portable" : ""
  }`;
  return [
    digest(headline, body, {
      languages: c.languages,
      commands: { total, inferred },
      scale: c.scale,
      sensitivePaths: c.sensitivePaths.length,
      knownGaps: c.knownGaps.length,
      unportable: bad.length,
    }),
  ];
}

/**
 * The advisory snapshot for {@link reportAdvisories} — `undefined` when no contract is
 * committed (so the advisory never fires on a repo that opted out). A non-portable path
 * makes the contract "untrue" (it misleads the next agent on another machine).
 */
export function contractSnapshot(ctx: PlanContext): ContractSnapshot | undefined {
  const c = resolveContract(ctx);
  if (!c) return undefined;
  return { unportable: unportablePaths(c).length, knownGaps: c.knownGaps.length };
}
