import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";

/**
 * Phase 3 — the Guardrail Rules severity panel (CRITICAL / IMPORTANT / STYLE).
 * GATED on real scan results: aih reads `.aih/guardrail-scan.json` (the contract it
 * owns), which a real scan (lint / gitleaks / ecc-agentshield) writes. When absent,
 * the panel is OMITTED — never shown as zero-as-if-scanned. aih does NOT run the
 * scan inline (respects the action model); the demo mode showcases the panel.
 */

export interface GuardrailCounts {
  critical: number;
  important: number;
  style: number;
}

function parseCounts(text: string): GuardrailCounts | undefined {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const n = (k: string): number | undefined =>
      typeof v[k] === "number" ? (v[k] as number) : undefined;
    const c = n("critical");
    const i = n("important");
    const s = n("style");
    if (c === undefined && i === undefined && s === undefined) return undefined;
    return { critical: c ?? 0, important: i ?? 0, style: s ?? 0 };
  } catch {
    return undefined;
  }
}

/** The Guardrail Rules digest — undefined when no real scan results exist. */
export function guardrailDigest(ctx: PlanContext): DigestAction | undefined {
  const file = readIfExists(join(ctx.root, ".aih", "guardrail-scan.json"));
  if (!file) return undefined;
  const c = parseCounts(file);
  if (!c) return undefined;
  const total = c.critical + c.important + c.style;
  return digest(
    `Guardrail rules — ${c.critical} critical · ${c.important} important · ${c.style} style`,
    lines(
      `CRITICAL:  ${c.critical}`,
      `IMPORTANT: ${c.important}`,
      `STYLE:     ${c.style}`,
      "",
      `${total} findings from the last scan (.aih/guardrail-scan.json).`,
    ),
    { critical: c.critical, important: c.important, style: c.style, total },
  );
}
