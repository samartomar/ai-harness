import type { DigestAction } from "../internals/plan.js";
import { V4_TEMPLATE } from "./v4-template.js";

/**
 * The **local-report v4** renderer — an additive, opt-in (`--v4`) skin that emits
 * the loved v0.5 dashboard prototype ({@link V4_TEMPLATE}, embedded verbatim) driven
 * by a real {@link AihDataV4} view-model built from the same digests `aih report`
 * already produces. It does NOT replace {@link reportHtml}; the legacy renderer
 * stays the default until every panel is bound (see
 * `docs/research/local-report-v4-plan.md`, Phase 0).
 *
 * Honesty rule (mirrors the rest of the report): a LIVE panel is shown with real
 * numbers ONLY when its data exists today. Everything not yet bound is **gated** to
 * an explicit placeholder rather than left showing the prototype's sample figures as
 * if they were real. The embedded DEMO dataset (the `◑ demo` toggle) is untouched —
 * it remains the full showcase.
 *
 * Phase 0 / commit 1 binds the hero (maturity radar + score + tier from the
 * scorecard) and gates the rest. Subsequent commits bind adoption, events, activity,
 * and MCP wiring and ungate them one at a time.
 */

/** Radar axis labels, in the order the prototype draws them (matches scorecard dims). */
const RADAR_LABELS = ["Layering", "Sharing", "Wiring", "Guardrails", "Discover"] as const;

/**
 * Scorecard dimension `name` → radar axis, in display order. The scorecard emits
 * `layering, sharing, harnessWiring, guardrails, discoverability`; the radar relabels
 * `harnessWiring`→Wiring and `discoverability`→Discover but keeps the order.
 */
const DIM_ORDER = [
  "layering",
  "sharing",
  "harnessWiring",
  "guardrails",
  "discoverability",
] as const;

/**
 * Every LIVE section id in the prototype that carries data. Commit 1 binds only the
 * hero, so all of these start gated (`false`) until a later commit wires each one.
 */
const LIVE_SECTIONS = [
  "sec-anomalies",
  "sec-mcp",
  "sec-sankey",
  "sec-forecast",
  "sec-activity",
  "sec-cost",
  "sec-skills",
  "sec-coherence",
  "sec-replay",
  "sec-guardrails",
  "sec-hooks",
  "sec-adoption",
  "sec-events",
] as const;

export interface V4Radar {
  labels: string[];
  values: number[];
}

export interface V4Maturity {
  overall: number;
  grade: string;
}

export interface AihDataV4 {
  /** Maturity radar (5 axes 0–100) — present only when the scorecard ran (on-canon). */
  radar?: V4Radar;
  /** Overall harness-health score + tier — present only when the scorecard ran. */
  maturity?: V4Maturity;
  /** sectionId → is this LIVE panel backed by real data yet (false = show placeholder). */
  gates: Record<string, boolean>;
}

export interface ReportHtmlV4Options {
  /** Seconds for a meta-refresh (live mode). Absent → the page does not auto-refresh. */
  refresh?: number;
  /** Open with the embedded DEMO dataset shown by default. */
  demo?: boolean;
}

/** The `.data` bag of the first digest whose `describe` starts with `prefix` (else undefined). */
function bag(digests: DigestAction[], prefix: string): Record<string, unknown> | undefined {
  const d = digests.find((x) => x.describe.startsWith(prefix));
  return d?.data && typeof d.data === "object" ? (d.data as Record<string, unknown>) : undefined;
}

/**
 * Build the v4 view-model from the report's digests. Pure + deterministic: the only
 * inputs are the digest `.data` bags (no wall-clock, no IO), so the same report
 * renders byte-identically across runs.
 */
export function buildAihDataV4(digests: DigestAction[]): AihDataV4 {
  const sc = bag(digests, "Harness maturity");
  let radar: V4Radar | undefined;
  let maturity: V4Maturity | undefined;
  if (sc) {
    const dims = Array.isArray(sc.dimensions)
      ? (sc.dimensions as Array<{ name?: unknown; score?: unknown }>)
      : [];
    const scoreByName = new Map(
      dims.map((d) => [String(d.name ?? ""), typeof d.score === "number" ? d.score : 0]),
    );
    radar = { labels: [...RADAR_LABELS], values: DIM_ORDER.map((n) => scoreByName.get(n) ?? 0) };
    if (typeof sc.overall === "number" && typeof sc.grade === "string") {
      maturity = { overall: sc.overall, grade: sc.grade };
    }
  }
  // Commit 1: only the hero is bound — gate every other live panel honestly.
  const gates = Object.fromEntries(LIVE_SECTIONS.map((s) => [s, false]));
  return { radar, maturity, gates };
}

/** Replace exactly one known occurrence; throw if the template drifted so binding never silently no-ops. */
function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const i = haystack.indexOf(needle);
  if (i === -1) throw new Error(`v4 template anchor not found: ${needle.slice(0, 60)}`);
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

/** Serialize for inline `<script>` embedding — neutralize `<` so a `</script>` can't break out. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Post-render hydration injected after the prototype's own script (so it runs after
 * `initAll()`): binds the hero score/tier from real data and replaces every gated
 * LIVE section with an honest placeholder, leaving the DEMO subtree untouched.
 */
const HYDRATE_SCRIPT = `<script>(function(){var d=window.AIH_DATA||{};
var live=document.getElementById("aih-live");if(!live)return;
if(d.maturity){var b=live.querySelector(".hero-score-big");if(b)b.innerHTML=d.maturity.overall+'<span class="of">/100</span>';var t=live.querySelector(".hero-score-tier");if(t)t.textContent=String(d.maturity.grade);}
var sub=live.querySelector(".hero-sub");if(sub)sub.innerHTML='Maturity radar and overall score are wired to your repo. The remaining panels light up as the local capture layer lands \\u2014 see <code>docs/research/local-report-v4-plan.md</code>. Toggle <b>\\u25d1 demo</b> to preview the full design.';
var pulse=live.querySelector(".pulse-strip");if(pulse&&pulse.parentNode)pulse.parentNode.removeChild(pulse);
var vit=live.querySelector(".hero-vitals");if(vit&&vit.parentNode)vit.parentNode.removeChild(vit);
var g=d.gates||{};var ph='<div class="card span-12"><div class="card-body"><p style="color:var(--muted);font-size:.86rem;line-height:1.5;margin:0">Not yet wired to local data \\u2014 this panel lights up as the capture layer lands (Phase 2/3 of <code>docs/research/local-report-v4-plan.md</code>). Toggle <b>\\u25d1 demo</b> to preview the design.</p></div></div>';
Object.keys(g).forEach(function(id){if(g[id])return;var sec=document.getElementById(id);if(!sec)return;if(sec.classList.contains("anom-strip")){if(sec.parentNode)sec.parentNode.removeChild(sec);return;}var grid=sec.querySelector(".grid");if(grid)grid.innerHTML=ph;});
})();</script>`;

/**
 * Render the v4 dashboard for the local report. Embeds the prototype verbatim and
 * binds the LIVE view to {@link buildAihDataV4}; the DEMO subtree is the prototype's
 * own showcase dataset, unchanged.
 */
export function reportHtmlV4(
  title: string,
  digests: DigestAction[],
  opts: ReportHtmlV4Options = {},
): string {
  const data = buildAihDataV4(digests);
  let html = V4_TEMPLATE;
  html = replaceOnce(
    html,
    "<title>aih report — harness health v0.5</title>",
    `<title>${escHtml(title)}</title>`,
  );
  // The prototype hard-codes a 10s meta-refresh; honor `--refresh`, else strip it so
  // a one-shot report does not reload (matches the legacy renderer's default).
  const refreshMeta =
    opts.refresh && opts.refresh > 0
      ? `<meta http-equiv="refresh" content="${Math.floor(opts.refresh)}">`
      : "";
  html = replaceOnce(html, '<meta http-equiv="refresh" content="10">', refreshMeta);
  if (opts.demo) html = replaceOnce(html, "<body>", '<body data-demo="on">');
  html = replaceOnce(html, "window.AIH_DATA = null;", `window.AIH_DATA = ${jsonForScript(data)};`);
  // Drive the live radar from real data, falling back to the prototype's constants.
  html = replaceOnce(
    html,
    "var liveValues=[100,100,100,67,100];",
    "var liveValues=(window.AIH_DATA&&AIH_DATA.radar&&AIH_DATA.radar.values)||[100,100,100,67,100];",
  );
  html = replaceOnce(
    html,
    'var liveLabels=["Layering","Sharing","Wiring","Guardrails","Discover"];',
    'var liveLabels=(window.AIH_DATA&&AIH_DATA.radar&&AIH_DATA.radar.labels)||["Layering","Sharing","Wiring","Guardrails","Discover"];',
  );
  html = replaceOnce(html, "</body>", `${HYDRATE_SCRIPT}\n</body>`);
  return html;
}
