import { SUPPORTED_CLIS } from "../internals/clis.js";
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
 * numbers ONLY when its data exists today. Sections not yet bound are **hidden** in
 * the live view (with one banner pointing to the demo) rather than left showing the
 * prototype's sample figures as if they were real. The embedded DEMO dataset (the
 * `◑ demo` toggle) is untouched — it remains the full showcase.
 *
 * Bound so far: hero (maturity radar + score + tier), **adoption** (tools, checks,
 * repo status, MCP consumers), the **event timeline**, the **activity heatmap**
 * (git commit history) and the **MCP plumbing** panel (wiring + servers; runtime
 * call/uptime metering still pending). Still gated until the capture layer lands:
 * Sankey, cost, forecast, skills, guardrails, hooks, replay, anomalies.
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
 * Every LIVE section id in the prototype that carries data. A section is bound when
 * {@link buildAihDataV4} produces a {@link V4Section} for it; the rest are hidden.
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

/** Friendlier short labels for a few tool binaries (matches the prototype's pills). */
const TOOL_LABELS: Record<string, string> = { "code-review-graph": "cr-graph" };

export interface V4Radar {
  labels: string[];
  values: number[];
}

export interface V4Maturity {
  overall: number;
  grade: string;
}

/** A bound LIVE section: real header text + the `.grid` inner HTML, server-rendered. */
export interface V4Section {
  title: string;
  /** sec-insight inner HTML (may contain `<b>`/`<code>`). */
  insight: string;
  /** sec-count chip text (optional). */
  count?: string;
  /** `.grid` inner HTML — the section's cards. */
  grid: string;
}

export interface AihDataV4 {
  /** Maturity radar (5 axes 0–100) — present only when the scorecard ran (on-canon). */
  radar?: V4Radar;
  /** Overall harness-health score + tier — present only when the scorecard ran. */
  maturity?: V4Maturity;
  /** sectionId → bound live content (absent → the section is hidden in the live view). */
  sections: Record<string, V4Section>;
  /** sectionId → is this LIVE panel backed by real data yet. */
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

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A string[] field off a bag, filtered to strings (or [] when absent/malformed). */
function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

function toolPill(name: string, on: boolean): string {
  const label = TOOL_LABELS[name] ?? name;
  return `<span class="tool ${on ? "on" : "off"}"${on ? "" : ` title="${escHtml(name)}"`}>${escHtml(label)}</span>`;
}

/** Tools-installed card → prototype `.pills` of present/absent tool binaries. */
function renderToolsCard(d: Record<string, unknown> | undefined): string | undefined {
  if (!d) return undefined;
  const present = strs(d.present);
  const absent = strs(d.absent);
  const total = numOr(d.total, present.length + absent.length);
  const coreMissing = strs(d.coreMissing);
  const pills = [
    ...present.map((n) => toolPill(n, true)),
    ...absent.map((n) => toolPill(n, false)),
  ].join("");
  const badge = coreMissing.length > 0 ? "badge bad" : "badge ok";
  return `<div class="card span-4"><div class="card-head"><h3>Tools installed</h3><span class="${badge}">${present.length}/${total}</span></div><div class="card-body"><div class="pills">${pills}</div></div></div>`;
}

/** Configuration card → prototype `.chips` of present/absent adoption artifacts. */
function renderChecksCard(d: Record<string, unknown> | undefined): string | undefined {
  if (!d) return undefined;
  const present = strs(d.present);
  const absent = strs(d.absent);
  const total = numOr(d.total, present.length + absent.length);
  const chip = (name: string, ok: boolean) =>
    `<span class="chip ${ok ? "ok" : "bad"}"><i>${ok ? "✓" : "✗"}</i>${escHtml(name)}</span>`;
  const chips = [...present.map((n) => chip(n, true)), ...absent.map((n) => chip(n, false))].join(
    "",
  );
  const badge = absent.length === 0 ? "badge ok" : "badge warn";
  return `<div class="card span-4"><div class="card-head"><h3>Adoption checks</h3><span class="${badge}">${present.length}/${total}</span></div><div class="card-body"><div class="chips">${chips}</div></div></div>`;
}

interface BranchRow {
  name?: unknown;
  age?: unknown;
  ahead?: unknown;
  behind?: unknown;
}

/** Repo-status card → prototype `.branches` list (current marked, main tagged). */
function renderRepoCard(d: Record<string, unknown> | undefined): string | undefined {
  if (!d) return undefined;
  if (d.isRepo === false) {
    return '<div class="card span-4"><div class="card-head"><h3>Repo status</h3><span class="badge muted">no repo</span></div><div class="card-body"><div class="hint">not a git repository</div></div></div>';
  }
  const current = typeof d.current === "string" ? d.current : "—";
  const main = typeof d.main === "string" ? d.main : "main";
  const rows = Array.isArray(d.branches) ? (d.branches as BranchRow[]) : [];
  const li = (b: BranchRow): string => {
    const name = typeof b.name === "string" ? b.name : "";
    const age = typeof b.age === "string" ? b.age : "";
    const isCur = name === current;
    const isMain = name === main;
    const tag = isMain ? '<span class="tag">main</span>' : "";
    const diffs = isMain
      ? ""
      : `<span class="diff up">+${numOr(b.ahead, 0)}</span><span class="diff down">−${numOr(b.behind, 0)}</span>`;
    return `<li${isCur ? ' class="cur"' : ""}><span class="dot"></span><span class="bname">${escHtml(name)}${tag}</span>${diffs}<span class="age">${escHtml(age)}</span></li>`;
  };
  const items = rows.slice(0, 6).map(li).join("");
  const hint = d.dirty === true ? '<div class="hint">uncommitted changes</div>' : "";
  return `<div class="card span-4"><div class="card-head"><h3>Repo status</h3><span class="badge accent">${escHtml(current)}</span></div><div class="card-body"><ul class="branches">${items}</ul>${hint}</div></div>`;
}

interface CovRow {
  cli?: unknown;
  mcp?: { state?: unknown };
}

/** Set of CLIs whose MCP cell is `wired`, from the AI-CLI-wiring model rows. */
function mcpWiredClis(cov: Record<string, unknown> | undefined): Set<string> {
  const rows = cov && Array.isArray(cov.rows) ? (cov.rows as CovRow[]) : [];
  return new Set(
    rows
      .filter((r) => r.mcp?.state === "wired" && typeof r.cli === "string")
      .map((r) => r.cli as string),
  );
}

/** MCP-consumers card → every supported CLI, lit when this repo has its MCP wired. */
function renderMcpConsumersCard(cov: Record<string, unknown> | undefined): string {
  const wired = mcpWiredClis(cov);
  const pills = SUPPORTED_CLIS.map((cli) =>
    wired.has(cli)
      ? `<span class="tool on mcp">${escHtml(cli)}</span>`
      : `<span class="tool off" title="${escHtml(cli)}">${escHtml(cli)}</span>`,
  ).join("");
  return `<div class="card span-12"><div class="card-head"><h3>AI tooling · MCP consumers</h3><span class="badge mcp">${wired.size}/${SUPPORTED_CLIS.length} MCP-enabled</span></div><div class="card-body"><div class="pills">${pills}</div></div></div>`;
}

/** Adoption section (#sec-adoption): tools, checks, repo status, MCP consumers. */
function renderAdoptionSection(digests: DigestAction[]): V4Section | undefined {
  const tools = bag(digests, "Tools installed");
  const cfg = bag(digests, "Configuration");
  if (!tools && !cfg) return undefined;
  const cov = bag(digests, "AI CLI wiring");
  const cards = [
    renderToolsCard(tools),
    renderChecksCard(cfg),
    renderRepoCard(bag(digests, "Repo status")),
    renderMcpConsumersCard(cov),
  ].filter((c): c is string => Boolean(c));
  const checksPresent = cfg ? strs(cfg.present).length : 0;
  const absentChecks = cfg ? strs(cfg.absent) : [];
  const checksTotal = cfg ? numOr(cfg.total, checksPresent + absentChecks.length) : 0;
  const toolsPresent = tools ? strs(tools.present).length : 0;
  const toolsTotal = tools ? numOr(tools.total, toolsPresent + strs(tools.absent).length) : 0;
  const wired = mcpWiredClis(cov).size;
  const title =
    absentChecks.length === 0
      ? `All ${checksTotal} adoption checks pass`
      : `${checksPresent} of ${checksTotal} adoption checks pass`;
  const gap =
    absentChecks.length > 0
      ? ` Gap${absentChecks.length > 1 ? "s" : ""}: <b class="bad">${absentChecks.map(escHtml).join(", ")}</b>.`
      : "";
  const insight = `${toolsPresent} of ${toolsTotal} tools installed; ${wired} of ${SUPPORTED_CLIS.length} AI CLIs MCP-enabled.${gap}`;
  return { title, insight, count: "adoption", grid: cards.join("") };
}

interface EventRow {
  ts?: unknown;
  tool?: unknown;
  kind?: unknown;
  detail?: unknown;
}

/** Prototype `.tl-event` class for an event kind. */
function eventKindClass(kind: string): string {
  if (kind === "mcp") return "up mcp";
  if (kind === "skill") return "skill";
  if (kind === "commit") return "commit";
  return "other";
}

/** Event-timeline section (#sec-events) from the recorded `.aih/usage.jsonl` feed. */
function renderEventsSection(digests: DigestAction[]): V4Section | undefined {
  const d = bag(digests, "AI events");
  if (!d) return undefined;
  const rows = Array.isArray(d.rows) ? (d.rows as EventRow[]) : [];
  const total = numOr(d.total, rows.length);
  const shown = rows.slice(0, 12);
  const ev = (r: EventRow): string => {
    const ts = typeof r.ts === "string" ? r.ts : "";
    // "YYYY-MM-DD HH:MM" → "HH:MM" for the dense timeline.
    const time = ts.length >= 16 ? ts.slice(11) : ts;
    const kind = typeof r.kind === "string" ? r.kind : "";
    const detail =
      (typeof r.detail === "string" && r.detail) || (typeof r.tool === "string" ? r.tool : "");
    return `<div class="tl-event ${eventKindClass(kind)}"><span class="tag">${escHtml(kind)}</span><span class="dot"></span><span class="time">${escHtml(time)}</span><span class="det">${escHtml(detail)}</span></div>`;
  };
  const items = shown.map(ev).join("");
  const more =
    total > shown.length ? `<div class="tl-more">+${total - shown.length} older events</div>` : "";
  const grid = `<div class="card span-12"><div class="card-head"><h3>Event timeline</h3><span class="badge muted">newest → oldest</span></div><div class="card-body"><div class="timeline"><div class="tl-axis"></div><div class="tl-events">${items}</div></div>${more}</div></div>`;
  return {
    title: `Latest activity — ${total} event${total === 1 ? "" : "s"} recorded`,
    insight:
      "The most recent AI events from <code>.aih/usage.jsonl</code> (commits always; skills/MCP once per-tool hooks are wired).",
    count: `${total} events`,
    grid,
  };
}

interface DayCount {
  date?: unknown;
  count?: unknown;
}

/** Activity-heatmap intensity class for a day's count, relative to the window max. */
function heatLevel(count: number, max: number): string {
  if (count <= 0) return "";
  const r = count / max;
  if (r >= 0.75) return "l4";
  if (r >= 0.5) return "l3";
  if (r >= 0.25) return "l2";
  return "l1";
}

const HEATMAP_CELLS = 105; // 15 cols × 7 rows, matching the prototype grid.

/** Activity section (#sec-activity): a real commit heatmap + streak stats from git. */
function renderActivitySection(digests: DigestAction[]): V4Section | undefined {
  const d = bag(digests, "Daily commits");
  if (!d) return undefined;
  const series = Array.isArray(d.daily90)
    ? (d.daily90 as DayCount[])
    : Array.isArray(d.daily)
      ? (d.daily as DayCount[])
      : [];
  const counts = series.map((x) => numOr(x.count, 0));
  if (counts.length === 0) return undefined;
  const max = Math.max(1, ...counts);
  // Pad the front with no-data cells so the most recent day lands at the grid end.
  const padded =
    counts.length >= HEATMAP_CELLS
      ? counts.slice(-HEATMAP_CELLS)
      : [...Array(HEATMAP_CELLS - counts.length).fill(-1), ...counts];
  const cells = padded
    .map((c) =>
      c < 0 ? '<span class="cell"></span>' : `<span class="cell ${heatLevel(c, max)}"></span>`,
    )
    .join("");
  const total = counts.reduce((a, b) => a + b, 0);
  const activeDays = counts.filter((c) => c > 0).length;
  let current = 0;
  for (let i = counts.length - 1; i >= 0 && (counts[i] ?? 0) > 0; i--) current++;
  let longest = 0;
  let run = 0;
  for (const c of counts) {
    run = c > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  const avg = activeDays > 0 ? Math.round(total / activeDays) : 0;
  const side = `<div class="heatmap-stat"><b>${total}</b><span>commits (${counts.length}d)</span></div><div class="heatmap-stat"><b>${activeDays}</b><span>active days</span></div><div class="heatmap-stat"><b>${current}</b><span>current streak (days)</span></div><div class="heatmap-streak">longest streak · ${longest} days</div><div class="heatmap-streak">avg / active day · ${avg} commits</div>`;
  const grid = `<div class="card span-12"><div class="card-head"><h3>Commit activity · ${counts.length} days</h3><span class="badge muted">${activeDays} active</span></div><div class="card-body"><div class="heatmap-wrap"><div class="heatmap"><div class="heatmap-grid">${cells}</div><div class="heatmap-legend"><span>less</span><div class="cells"><span class="cell"></span><span class="cell l1"></span><span class="cell l2"></span><span class="cell l3"></span><span class="cell l4"></span></div><span>more</span></div></div><div class="heatmap-side">${side}</div></div></div></div>`;
  return {
    title: `Commit activity — ${activeDays} active days, ${current}-day streak`,
    insight:
      "Daily commits over the recent window (git history). Skill/MCP activity joins this once per-tool hooks are wired.",
    count: `${counts.length} days`,
    grid,
  };
}

/** Server count parsed from an MCP cell's detail (e.g. "3 server(s) under `mcpServers`"). */
function mcpServerCount(detail: unknown): number {
  const m = /(\d+)\s+server/.exec(typeof detail === "string" ? detail : "");
  return m?.[1] ? Number.parseInt(m[1], 10) : 0;
}

interface CovRowDetail {
  cli?: unknown;
  mcp?: { state?: unknown; detail?: unknown };
}

/** MCP-plumbing section (#sec-mcp): the honest wiring + servers view (no runtime metering). */
function renderMcpSection(digests: DigestAction[]): V4Section | undefined {
  const cov = bag(digests, "AI CLI wiring");
  if (!cov) return undefined;
  const rows = Array.isArray(cov.rows) ? (cov.rows as CovRowDetail[]) : [];
  const wiredRows = rows.filter((r) => r.mcp?.state === "wired");
  if (wiredRows.length === 0) return undefined; // nothing wired → leave the section hidden
  const wired = mcpWiredClis(cov);
  const servers = Math.max(0, ...wiredRows.map((r) => mcpServerCount(r.mcp?.detail)));
  const consumers = wiredRows
    .map((r) => {
      const cli = typeof r.cli === "string" ? r.cli : "";
      const n = mcpServerCount(r.mcp?.detail);
      return `<div class="consumer"><span class="cdot"></span><span class="cname">${escHtml(cli)}</span><span class="ccalls">${n} server${n === 1 ? "" : "s"}</span></div>`;
    })
    .join("");
  const grid = `<div class="card span-7"><div class="card-head"><h3>MCP wiring · consumers</h3><span class="badge mcp">${wired.size}/${SUPPORTED_CLIS.length} CLIs</span></div><div class="card-body"><div class="consumers">${consumers}</div></div></div><div class="card span-5"><div class="card-head"><h3>Servers configured</h3></div><div class="card-body"><div class="mcp-stat"><span class="v mcp">${servers}</span><span class="l">MCP servers</span><span class="d">written by <code>aih mcp</code></span></div><p style="color:var(--muted);font-size:.78rem;line-height:1.5;margin:.8rem 0 0">Per-tool call volume and uptime arrive with the capture layer (Phase 2) — see <code>docs/research/local-report-v4-plan.md</code>.</p></div></div>`;
  return {
    title: `MCP wired for ${wired.size} CLI${wired.size === 1 ? "" : "s"} — ${servers} server${servers === 1 ? "" : "s"}`,
    insight:
      "aih generates the MCP server config for each targeted CLI (<code>aih mcp</code>). Runtime call volume and uptime are not yet metered locally.",
    count: "flagship · MCP",
    grid,
  };
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
  const sections: Record<string, V4Section> = {};
  const adoption = renderAdoptionSection(digests);
  if (adoption) sections["sec-adoption"] = adoption;
  const events = renderEventsSection(digests);
  if (events) sections["sec-events"] = events;
  const activity = renderActivitySection(digests);
  if (activity) sections["sec-activity"] = activity;
  const mcp = renderMcpSection(digests);
  if (mcp) sections["sec-mcp"] = mcp;
  const gates = Object.fromEntries(LIVE_SECTIONS.map((s) => [s, Boolean(sections[s])]));
  return { radar, maturity, sections, gates };
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

/**
 * Post-render hydration injected after the prototype's own script (so it runs after
 * `initAll()`): binds the hero + every bound section from real data, hides the
 * not-yet-wired sections, and adds one honest banner. The DEMO subtree is untouched.
 */
/**
 * The hydration logic as a `function(doc, d)` source string, so it runs both in the
 * page (wrapped in a `<script>`) and directly in a DOM test — one source, no drift.
 */
export const HYDRATE_FN = `function(doc,d){
var live=doc.getElementById("aih-live");if(!live)return;
if(d.maturity){var b=live.querySelector(".hero-score-big");if(b)b.innerHTML=d.maturity.overall+'<span class="of">/100</span>';var t=live.querySelector(".hero-score-tier");if(t)t.textContent=String(d.maturity.grade);}
var sub=live.querySelector(".hero-sub");if(sub)sub.innerHTML='The hero, adoption, activity, event feed and MCP wiring are bound to your repo. The remaining panels light up as the local capture layer lands \\u2014 see <code>docs/research/local-report-v4-plan.md</code>. Toggle <b>\\u25d1 demo</b> for the full design.';
var pulse=live.querySelector(".pulse-strip");if(pulse&&pulse.parentNode)pulse.parentNode.removeChild(pulse);
var vit=live.querySelector(".hero-vitals");if(vit&&vit.parentNode)vit.parentNode.removeChild(vit);
var S=d.sections||{},g=d.gates||{},hidden=0;
Object.keys(g).forEach(function(id){var sec=doc.getElementById(id);if(!sec)return;var s=S[id];
if(s){var ti=sec.querySelector(".sec-title");if(ti)ti.textContent=s.title;var ins=sec.querySelector(".sec-insight");if(ins)ins.innerHTML=s.insight;if(s.count){var c=sec.querySelector(".sec-count");if(c)c.textContent=s.count;}var gr=sec.querySelector(".grid");if(gr)gr.innerHTML=s.grid;return;}
sec.style.display="none";hidden++;});
if(hidden){var hero=doc.getElementById("sec-hero");if(hero&&hero.parentNode){var n=doc.createElement("div");n.className="whatsnew";n.innerHTML='<span class="tag">preview</span><b>'+hidden+' panel'+(hidden>1?'s':'')+'</b> not yet wired to local data \\u2014 toggle <b>\\u25d1 demo</b> to preview them. <span class="muted">Binding lands as the capture layer ships (docs/research/local-report-v4-plan.md).</span>';hero.parentNode.insertBefore(n,hero);}}
}`;

/** The hydration as an inline `<script>` for the page — runs after the prototype IIFE. */
const HYDRATE_SCRIPT = `<script>(${HYDRATE_FN})(document, window.AIH_DATA||{});</script>`;

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
