import { lines } from "../internals/render.js";
import type { OrgDigestData } from "./org.js";
import type { TokenSplit } from "./pricing.js";
import { thousands } from "./render.js";

/** Up to this many skill rows in the digest. */
const TOP_SKILLS = 10;

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Whole-dollar estimate with a leading `~` (savings/cost are never exact). */
function usd(n: number): string {
  return `${n < 0 ? "-" : ""}~$${thousands(Math.round(Math.abs(n)))}`;
}

function total(t: TokenSplit): number {
  return t.input + t.output + t.cacheRead + t.cacheCreation;
}

function empty(d: OrgDigestData): boolean {
  return d.records === 0 && d.skills.length === 0;
}

/** One-line headline (the digest `describe`). */
export function orgHeadline(d: OrgDigestData): string {
  if (empty(d)) return "Org usage — no data in the provided export";
  const parts = [
    `${d.skills.length} skills`,
    `~${thousands(total(d.tokens))} tokens`,
    `${pct(d.savings.efficiency)} cache-served`,
  ];
  if (d.estimatedCostUsd !== undefined) parts.push(`${usd(d.estimatedCostUsd)} est. cost`);
  return `Org usage — ${parts.join(" · ")}`;
}

/** Full digest body (printed verbatim by the summary; mirrors the `--json` data). */
export function orgDigest(d: OrgDigestData): string {
  if (empty(d)) {
    return lines(
      "Org analytics — the export held no usage records or skills.",
      "",
      "  Generate one, then pass it back:",
      "    node <context-dir>/telemetry/fetch-analytics.mjs --run > org.json",
      "    aih report --org org.json",
    );
  }

  const t = d.tokens;
  const s = d.savings;
  const out: Array<string | string[]> = [
    "Org analytics digest (aggregate — no per-developer data)",
    "",
  ];

  if (d.window?.startingAt || d.window?.endingAt) {
    out.push(`  Window: ${d.window.startingAt ?? "?"} → ${d.window.endingAt ?? "?"}`, "");
  }

  out.push(
    "  Tokens:",
    `    input         ${thousands(t.input)}`,
    `    output        ${thousands(t.output)}`,
    `    cache read    ${thousands(t.cacheRead)}`,
    `    cache write   ${thousands(t.cacheCreation)}`,
    `    total        ~${thousands(total(t))}`,
    "",
    ...(d.byModel.length > 0
      ? [
          "  By model:",
          ...d.byModel.map((m) => {
            const denom = m.tokens.cacheRead + m.tokens.input;
            const served = denom > 0 ? pct(m.tokens.cacheRead / denom) : "0%";
            return `    ${m.model.padEnd(20)} ~${thousands(total(m.tokens))} tokens · ${served} cache-served`;
          }),
          "",
        ]
      : []),
    "  Cache savings (estimate · verify rates against current pricing):",
    `    efficiency    ${pct(s.efficiency)} of input served from cache (rate-independent)`,
    `    gross avoided ${usd(s.grossAvoidedUsd)}`,
    `    write premium ${usd(s.writePremiumUsd)}`,
    `    net saved     ${usd(s.netSavedUsd)}`,
  );
  if (s.unpricedModels.length > 0) {
    out.push(`    (no rate for ${s.unpricedModels.join(", ")} — excluded from the $ figures)`);
  }
  out.push("");

  if (d.estimatedCostUsd !== undefined) out.push(`  Est. spend: ${usd(d.estimatedCostUsd)}`, "");

  if (d.toolActions) {
    const { accepted, rejected } = d.toolActions;
    const n = accepted + rejected;
    out.push(
      `  Tool edits: ${thousands(accepted)} accepted · ${thousands(rejected)} rejected` +
        ` (${n > 0 ? pct(rejected / n) : "0%"} block-rate)`,
      "",
    );
  }

  if (d.skills.length > 0) {
    out.push("  Top skills (by distinct users):");
    for (const sk of d.skills.slice(0, TOP_SKILLS)) {
      out.push(`    ${thousands(sk.users)} users · ${thousands(sk.sessions)} sessions  ${sk.name}`);
    }
  } else {
    out.push("  Top skills: (none in export — Enterprise plan + 3-day finalization lag required)");
  }

  return lines(...out);
}
