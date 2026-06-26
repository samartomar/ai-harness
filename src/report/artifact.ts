import type { DigestAction } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { demoDigests } from "./demo.js";
import { GEIST_FONT } from "./font-geist.js";
import { EMBEDDED_FONTS } from "./fonts.js";

/** HTML-escape text for safe embedding in markup. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Group digits with thousands separators, deterministically (no locale). */
function fmt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Render the report's digests as a Markdown document — one section per digest,
 * the verbatim body in a fenced block so the aligned columns survive. Byte-stable
 * (no timestamp) so re-applying the artifact is a no-op when nothing changed.
 */
export function reportMarkdown(title: string, digests: DigestAction[]): string {
  const parts: string[] = [`# ${title}`, ""];
  for (const d of digests) {
    parts.push(`## ${d.describe}`, "", "```text", d.text.replace(/\n+$/, ""), "```", "");
  }
  return lines(...parts);
}

// ---- rich HTML dashboard --------------------------------------------------

type Bag = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The `data` of the first digest whose describe starts with `prefix`. */
function dataFor(digests: DigestAction[], prefix: string): Bag | undefined {
  for (const d of digests) if (d.describe.startsWith(prefix)) return (d.data as Bag) ?? {};
  return undefined;
}

interface Snap {
  commits7d?: number;
  loc?: { net?: number };
  adoptionScore?: number;
  branches?: number;
  sourceFiles?: number;
}
interface FileBloat {
  path: string;
  tokens: number;
}
interface Branch {
  name: string;
  age: string;
  ahead: number;
  behind: number;
}

/** A titled bento panel; `span` is its width in a 12-col grid. */
function panel(title: string, badge: string, body: string, span: number, bodyClass = "pb"): string {
  return `<section class="panel span-${span}"><div class="ph"><h2>${esc(title)}</h2>${badge}</div><div class="${bodyClass}">${body}</div></section>`;
}

/** SVG donut for a 0–100 score (green ≥80 / amber ≥50 / red), with a soft glow. */
function ring(pct: number): string {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const c = 2 * Math.PI * 52;
  const cls = p >= 80 ? "ok" : p >= 50 ? "warn" : "bad";
  return [
    `<svg class="ring ${cls}" viewBox="0 0 120 120" width="124" height="124" role="img" aria-label="adoption ${p} of 100">`,
    '  <circle class="ring-bg" cx="60" cy="60" r="52" fill="none" stroke-width="11"/>',
    `  <circle class="ring-fg" cx="60" cy="60" r="52" fill="none" stroke-width="11" stroke-linecap="round" filter="url(#glow)" stroke-dasharray="${((c * p) / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 60 60)"/>`,
    `  <text x="60" y="57" class="ring-num">${p}</text><text x="60" y="78" class="ring-cap">/ 100</text>`,
    "</svg>",
  ].join("");
}

function kpi(value: string, label: string, over = false): string {
  return `<div class="kpi"><span class="kpi-v${over ? " over" : ""}">${esc(value)}</span><span class="kpi-l">${esc(label)}</span></div>`;
}

/** Context footprint: a budget bar + the heaviest context contributors as bars. */
function budgetPanel(d: Bag): string {
  const tokens = num(d.totalTokens) ?? 0;
  const budget = num(d.budgetTokens) ?? 0;
  const over = d.overBudget === true;
  const files = arr(d.files) as FileBloat[];
  const pct = budget > 0 ? Math.min(100, (tokens / budget) * 100) : 0;
  // Show the FULL range — every file, heaviest first — in a scrollable list, so
  // the whole context is analyzable (not just a top-N slice). Each row carries its
  // share of total so you can see where the budget actually goes.
  const all = [...files].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));
  const max = Math.max(1, ...all.map((f) => f.tokens ?? 0));
  const rows = all
    .map((f) => {
      const tk = f.tokens ?? 0;
      const share = tokens > 0 ? Math.round((tk / tokens) * 100) : 0;
      return `<li><span class="bar-label" title="${esc(f.path)}">${esc(f.path)}</span><span class="bar-track"><span class="bar-fill" style="width:${((tk / max) * 100).toFixed(1)}%"></span></span><span class="bar-val">${fmt(tk)}<i>${share}%</i></span></li>`;
    })
    .join("");
  const badge = over
    ? `<span class="badge over">OVER by ${fmt(tokens - budget)}</span>`
    : `<span class="badge muted">${Math.round(pct)}% of budget</span>`;
  const body = [
    `<div class="budget-track"><div class="budget-fill${over ? " over" : ""}" style="width:${pct.toFixed(1)}%"></div></div>`,
    `<div class="budget-cap"><span>${fmt(tokens)} tokens · ${all.length} files (heaviest first — scroll for all)</span><span>budget ${fmt(budget)}</span></div>`,
    `<ul class="bars scroll" tabindex="0" role="region" aria-label="Context files by token weight">${rows}</ul>`,
  ].join("");
  return panel("Context footprint", badge, body, 12);
}

/** Repo status: branch rows with ahead/behind pills, current highlight, dirty hint. */
function branchesPanel(d: Bag): string {
  const cur = str(d.current) ?? "";
  const main = str(d.main) ?? "";
  const branches = arr(d.branches) as Branch[];
  const rows = branches
    .map((b) => {
      const isMain = b.name === main;
      const pills = isMain
        ? ""
        : `${b.ahead > 0 ? `<span class="pill up">+${b.ahead}</span>` : ""}${b.behind > 0 ? `<span class="pill down">−${b.behind}</span>` : ""}`;
      return `<li class="${b.name === cur ? "cur" : ""}"><span class="dot"></span><span class="bname">${esc(b.name)}${isMain ? '<span class="tag">main</span>' : ""}</span>${pills}<span class="age">${esc(b.age)}</span></li>`;
    })
    .join("");
  const dirty = d.dirty === true ? '<div class="hint">● uncommitted changes</div>' : "";
  return panel(
    "Repo status",
    `<span class="badge muted">${esc(cur)}</span>`,
    `<ul class="branches">${rows}</ul>${dirty}`,
    5,
  );
}

function spark(label: string, v: number[]): string {
  const max = Math.max(1, ...v);
  const min = Math.min(0, ...v);
  const span = max - min || 1;
  const w = 12;
  const gap = 4;
  const h = 40;
  const bars = v
    .map((x, i) => {
      const bh = Math.max(2, ((x - min) / span) * h);
      return `<rect x="${i * (w + gap)}" y="${(h - bh).toFixed(1)}" width="${w}" height="${bh.toFixed(1)}" rx="2"><title>${esc(label)} #${i + 1}: ${fmt(x)}</title></rect>`;
    })
    .join("");
  const last = v[v.length - 1] ?? 0;
  const delta = last - (v[0] ?? 0);
  const trend = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const summary = `${label}: ${v.length} samples, latest ${fmt(last)}, ${trend} ${fmt(Math.abs(delta))} over range`;
  return `<div class="mini"><div class="mini-h"><span>${esc(label)}</span><b>${fmt(last)}<i>${delta >= 0 ? "+" : ""}${fmt(delta)}</i></b></div><svg viewBox="0 0 ${v.length * (w + gap)} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(summary)}">${bars}</svg></div>`;
}

/** Trends: a small bar chart per metric over the recorded samples. */
function trendsPanel(d: Bag): string {
  const rows = arr(d.rows) as Snap[];
  const charts = [
    spark(
      "commits (7d)",
      rows.map((r) => r.commits7d ?? 0),
    ),
    spark(
      "LOC net",
      rows.map((r) => r.loc?.net ?? 0),
    ),
    spark(
      "adoption",
      rows.map((r) => r.adoptionScore ?? 0),
    ),
    spark(
      "branches",
      rows.map((r) => r.branches ?? 0),
    ),
  ].join("");
  return panel(
    "Trends",
    `<span class="badge muted">${rows.length} samples</span>`,
    charts,
    12,
    "trend-grid",
  );
}

/** Adoption checklist: present/absent artifacts as colored chips. */
function checklistPanel(d: Bag): string {
  const present = arr(d.present) as string[];
  const absent = arr(d.absent) as string[];
  const total = num(d.total) ?? present.length + absent.length;
  const chips = [
    ...present.map((n) => `<span class="chip ok"><i>✓</i>${esc(n)}</span>`),
    ...absent.map((n) => `<span class="chip bad"><i>✗</i>${esc(n)}</span>`),
  ].join("");
  const cls = absent.length === 0 ? "ok" : "muted";
  return panel(
    "Adoption checklist",
    `<span class="badge ${cls}">${present.length}/${total}</span>`,
    `<div class="chips">${chips}</div>`,
    5,
  );
}

/**
 * Install / enable hints for tools NOT on PATH (shell tools) or AI CLIs not configured
 * here — surfaced as a hover tooltip on the struck-through pill so a developer can act.
 * Protocol-less URLs (no http/https) keep the page's "no external assets" guarantee.
 */
const TOOL_HINTS: Record<string, string> = {
  rg: "ripgrep — brew install ripgrep · apt install ripgrep · scoop install ripgrep",
  sg: "ast-grep — brew install ast-grep · npm i -g @ast-grep/cli · cargo install ast-grep",
  fd: "fd — brew install fd · apt install fd-find · scoop install fd",
  tree: "tree — brew install tree · apt install tree",
  comby: "comby — brew install comby · bash <(curl -sL get.comby.dev)",
  jq: "jq — brew install jq · apt install jq · scoop install jq",
  gh: "GitHub CLI — brew install gh · winget install GitHub.cli · cli.github.com",
  "code-review-graph": "pip install code-review-graph (or uvx code-review-graph serve)",
  claude: "Claude Code — npm i -g @anthropic-ai/claude-code",
  codex: "Codex CLI — npm i -g @openai/codex",
  cursor: "Cursor editor — cursor.com",
  gemini: "Gemini CLI — npm i -g @google/gemini-cli",
  antigravity: "Antigravity — antigravity.google",
  windsurf: "Windsurf — windsurf.com",
  kiro: "Kiro — kiro.dev",
  copilot: "GitHub Copilot CLI — gh extension install github/gh-copilot",
  opencode: "opencode — npm i -g opencode-ai",
  zed: "Zed — zed.dev",
  kimi: "Kimi CLI — kimi.com",
};

/** A tool/CLI pill — present (filled), or absent (struck-through, with an install hint). */
function toolPill(name: string, on: boolean): string {
  if (on) return `<span class="tool on">${esc(name)}</span>`;
  const hint = TOOL_HINTS[name];
  if (!hint)
    return `<span class="tool off" aria-label="${esc(name)} — not installed">${esc(name)}</span>`;
  // Keyboard/SR-reachable: tabindex + aria-label surface the install hint that
  // `title` alone (hover-only) hides; the `?` glyph gives a visible affordance.
  return `<span class="tool off" tabindex="0" data-hint="1" title="${esc(hint)}" aria-label="${esc(name)} — not installed. ${esc(hint)}">${esc(name)}<i class="tool-i" aria-hidden="true">?</i></span>`;
}

/** Present-then-absent tool pills, shared by Tools installed + Tooling. */
function toolPills(present: string[], absent: string[]): string {
  return [...present.map((n) => toolPill(n, true)), ...absent.map((n) => toolPill(n, false))].join(
    "",
  );
}

/** Tooling: pill per AI CLI — filled when present, struck-through (with hint) when absent. */
function toolingPanel(d: Bag): string {
  const present = arr(d.present) as string[];
  const absent = arr(d.absent) as string[];
  const total = num(d.total) ?? present.length + absent.length;
  return panel(
    "Machine tooling",
    `<span class="badge muted">${present.length}/${total}</span>`,
    `<div class="pills">${toolPills(present, absent)}</div>`,
    7,
  );
}

interface CovCell {
  state: string;
  path?: string;
  detail?: string;
  fix?: string;
}
interface CovRow {
  cli: string;
  label: string;
  targeted: boolean;
  bootloader: CovCell;
  mcp: CovCell;
  settings: CovCell;
}

/** State → CSS class / glyph for a per-CLI wiring cell (matches the terminal legend). */
const CELL_CLASS: Record<string, string> = {
  wired: "ok",
  missing: "bad",
  manual: "warn",
  na: "muted",
};
const CELL_GLYPH: Record<string, string> = { wired: "✓", missing: "✗", manual: "◐", na: "—" };

/** One wiring cell — colored glyph + short file label; full detail/fix in the tooltip. */
function covCell(c: CovCell): string {
  const cls = CELL_CLASS[c.state] ?? "muted";
  const glyph = CELL_GLYPH[c.state] ?? "—";
  const label = c.state === "na" ? "n/a" : (c.path ?? "");
  const tip = [c.path, c.detail, c.fix ? `fix: ${c.fix}` : ""].filter(Boolean).join(" — ");
  return `<span class="cli-cell ${cls}"${tip ? ` title="${esc(tip)}"` : ""}>${glyph} ${esc(label)}</span>`;
}

function covRowHtml(r: CovRow): string {
  const dot = r.targeted ? "●" : "○";
  return `<tr><td class="cli-name">${dot} ${esc(r.label)}</td><td>${covCell(r.bootloader)}</td><td>${covCell(r.mcp)}</td><td>${covCell(r.settings)}</td></tr>`;
}

/**
 * AI CLI wiring matrix — one row per CLI, columns for bootloader / MCP / settings,
 * each a four-state cell (wired / missing / manual / n/a). Targeted tools lead;
 * installed-but-untargeted ones follow, muted. This is the panel that makes every
 * CLI individually visible instead of one global "configured" verdict.
 */
function cliMatrixPanel(d: Bag): string {
  const rows = arr(d.rows) as CovRow[];
  const targeted = rows.filter((r) => r.targeted);
  const other = rows.filter((r) => !r.targeted);
  const configured = num(d.structurallyConfigured) ?? 0;
  const totalT = num(d.totalTargeted) ?? targeted.length;
  const src = str(d.targetSource) ?? "";
  const legend =
    '<div class="cli-legend">' +
    '<span class="cli-cell ok">✓ wired</span>' +
    '<span class="cli-cell bad">✗ missing</span>' +
    '<span class="cli-cell warn">◐ manual</span>' +
    '<span class="cli-cell muted">— n/a</span>' +
    `<span class="cli-src">targets: ${esc(src)}</span></div>`;
  const sep = other.length
    ? '<tr class="cli-sep"><td colspan="4">also installed (not targeted)</td></tr>'
    : "";
  const table =
    '<table class="cli-matrix"><thead><tr><th>Tool</th><th>Bootloader</th><th>MCP</th><th>Settings</th></tr></thead><tbody>' +
    targeted.map(covRowHtml).join("") +
    sep +
    other.map(covRowHtml).join("") +
    "</tbody></table>";
  return panel(
    "AI CLI wiring",
    `<span class="badge muted">${configured}/${totalT} configured</span>`,
    legend + table,
    12,
  );
}

/** A clean styled panel for notes/stubs/unrecognized digests (no data viz). */
function notePanel(d: DigestAction): string {
  return panel(d.describe, "", `<pre class="prose">${esc(d.text.replace(/\n+$/, ""))}</pre>`, 12);
}

interface EvRow {
  ts: string;
  tool: string;
  kind: string;
  detail: string;
  added?: number;
  removed?: number;
}

/** AI events — a chronological feed table (time · event · detail · ±LOC), newest first. */
function eventsTablePanel(d: Bag): string {
  const rows = arr(d.rows) as EvRow[];
  const total = num(d.total) ?? rows.length;
  const shown = num(d.shown) ?? rows.length;
  const kindCls = (k: string): string =>
    k === "commit" ? "k-commit" : k === "skill" ? "k-skill" : k === "mcp" ? "k-mcp" : "k-other";
  const trs = rows
    .map((r) => {
      const loc =
        r.added !== undefined || r.removed !== undefined
          ? `<span class="add">+${fmt(r.added ?? 0)}</span> <span class="del">−${fmt(r.removed ?? 0)}</span>`
          : '<span class="dim">—</span>';
      return `<tr><td class="t">${esc(r.ts)}</td><td><span class="ev ${kindCls(r.kind)}">${esc(r.kind)}</span> ${esc(r.tool)}</td><td class="mono">${esc(r.detail)}</td><td class="loc">${loc}</td></tr>`;
    })
    .join("");
  const more = total > shown ? `<div class="more">+${fmt(total - shown)} older</div>` : "";
  const body = `<div class="ev-wrap" tabindex="0" role="region" aria-label="AI events feed, newest first"><table class="events"><caption class="sr-only">AI events, newest first</caption><thead><tr><th>Time</th><th>Event</th><th>Detail</th><th>Δ lines</th></tr></thead><tbody>${trs}</tbody></table></div>${more}`;
  return panel("AI events", `<span class="badge muted">${fmt(total)}</span>`, body, 12);
}

/** Daily commits — a bar per active day + the 7d/30d/total commit counts. */
function dailyCommitsPanel(d: Bag): string {
  const daily = arr(d.daily) as { date: string; count: number }[];
  const c = (d.commits ?? {}) as { d7?: number; d30?: number; total?: number };
  const counts = daily.map((x) => x.count);
  const max = Math.max(1, ...counts);
  const h = 56;
  const w = 14;
  const gap = 3;
  const bars = counts
    .map((n, i) => {
      const bh = Math.max(2, (n / max) * h);
      return `<rect x="${i * (w + gap)}" y="${(h - bh).toFixed(1)}" width="${w}" height="${bh.toFixed(1)}" rx="2"><title>${esc(daily[i]?.date ?? "")}: ${n}</title></rect>`;
    })
    .join("");
  const chart =
    counts.length > 0
      ? `<svg class="daybars" role="img" aria-label="Daily commits across ${counts.length} days, ${fmt(c.total ?? 0)} total" viewBox="0 0 ${counts.length * (w + gap)} ${h}" preserveAspectRatio="none">${bars}</svg>`
      : '<div class="empty">no commits in range</div>';
  const sub = `<div class="vel-sub"><span><b>${fmt(c.d7 ?? 0)}</b> 7d</span><span><b>${fmt(c.d30 ?? 0)}</b> 30d</span><span><b>${fmt(c.total ?? 0)}</b> total</span></div>`;
  return panel(
    "Daily commits",
    `<span class="badge muted">${counts.length}d</span>`,
    `${chart}${sub}`,
    7,
  );
}

/** Lines of code over a window — added / removed (colored) + net. */
function locPanel(d: Bag): string {
  const loc = (d.loc ?? {}) as { added?: number; removed?: number; net?: number };
  const days = num(d.windowDays) ?? 30;
  const net = loc.net ?? 0;
  const body =
    `<div class="loc-row"><div class="loc-big"><span class="add">+${fmt(loc.added ?? 0)}</span><span class="loc-l">added</span></div>` +
    `<div class="loc-big"><span class="del">−${fmt(loc.removed ?? 0)}</span><span class="loc-l">removed</span></div></div>` +
    `<div class="loc-net">Net: ${net >= 0 ? "+" : ""}${fmt(net)} lines</div>`;
  return panel(`Lines of code (${days}d)`, "", body, 5);
}

/** Test coverage — the test-to-source FILE ratio (not line coverage). */
function testRatioPanel(d: Bag): string {
  const ratio = num(d.ratio) ?? 0;
  const t = num(d.testFiles) ?? 0;
  const s = num(d.sourceFiles) ?? 0;
  const body = `<div class="ratio"><span class="ratio-v">${ratio}%</span><span class="ratio-l">test to source file ratio</span><span class="ratio-sub">${fmt(t)} test files / ${fmt(s)} source files</span></div>`;
  return panel("Test coverage", "", body, 4);
}

/** Repository information — tracked files + git size + file-type breakdown bars. */
function repoInfoPanel(d: Bag): string {
  const files = num(d.files) ?? 0;
  const size = str(d.size) ?? "—";
  const types = arr(d.types) as { name: string; count: number }[];
  const max = Math.max(1, ...types.map((t) => t.count));
  const rows = types
    .map(
      (t) =>
        `<li><span class="bar-label">${esc(t.name)}</span><span class="bar-track"><span class="bar-fill" style="width:${((t.count / max) * 100).toFixed(1)}%"></span></span><span class="bar-val">${fmt(t.count)}</span></li>`,
    )
    .join("");
  const head = `<div class="ri-head"><span><b>${fmt(files)}</b> files</span><span><b>${esc(size)}</b> git size</span></div>`;
  return panel("Repository information", "", `${head}<ul class="bars">${rows}</ul>`, 7);
}

/** Tools installed — agent shell tools, filled when on PATH, struck-through (+ hint) when absent. */
function toolsInstalledPanel(d: Bag): string {
  const present = arr(d.present) as string[];
  const absent = arr(d.absent) as string[];
  const total = num(d.total) ?? present.length + absent.length;
  return panel(
    "Tools installed",
    `<span class="badge muted">${present.length}/${total}</span>`,
    `<div class="pills">${toolPills(present, absent)}</div>`,
    7,
  );
}

/** Code graph health — node/edge/file/density stats from the code-review-graph (Phase 2). */
function graphHealthPanel(d: Bag): string {
  const density = num(d.density);
  const stat = (k: string, v: string): string => `<li><span>${esc(k)}</span><b>${v}</b></li>`;
  const body = `<ul class="statlist">${
    stat("Nodes (functions/classes)", d.nodes !== undefined ? fmt(num(d.nodes) ?? 0) : "—") +
    stat("Edges (relationships)", d.edges !== undefined ? fmt(num(d.edges) ?? 0) : "—") +
    stat("Files indexed", d.files !== undefined ? fmt(num(d.files) ?? 0) : "—") +
    stat("Edge density", density !== undefined ? density.toFixed(1) : "—")
  }</ul>`;
  return panel("Code graph health", "", body, 4);
}

/** Build & analysis times from the code-review-graph (Phase 2). */
function buildTimesPanel(d: Bag): string {
  const ms = num(d.buildMs);
  const body = `<ul class="statlist"><li><span>Graph build time</span><b>${ms !== undefined ? `${(ms / 1000).toFixed(1)}s` : "—"}</b></li><li><span>Files tracked by graph</span><b>${d.files !== undefined ? fmt(num(d.files) ?? 0) : "—"}</b></li></ul>`;
  return panel("Build & analysis", "", body, 5);
}

/** Guardrail rules — severity counts as horizontal bars (Phase 3). */
function guardrailRulesPanel(d: Bag): string {
  const c = num(d.critical) ?? 0;
  const i = num(d.important) ?? 0;
  const s = num(d.style) ?? 0;
  const max = Math.max(1, c, i, s);
  const row = (label: string, n: number, cls: string): string =>
    `<li><span class="gr-l">${label}</span><span class="bar-track"><span class="gr-fill ${cls}" style="width:${((n / max) * 100).toFixed(0)}%"></span></span><span class="gr-v">${fmt(n)}</span></li>`;
  const body = `<ul class="guardrails">${row("CRITICAL", c, "crit") + row("IMPORTANT", i, "imp") + row("STYLE", s, "sty")}</ul>`;
  return panel("Guardrail rules", "", body, 4);
}

/** Route one digest to its rich panel (by stable describe prefix), else a note. */
function panelFor(d: DigestAction): string {
  const data = (d.data as Bag) ?? {};
  if (d.describe.startsWith("Context footprint") && Array.isArray(data.files))
    return budgetPanel(data);
  if (d.describe.startsWith("Repo status") && Array.isArray(data.branches))
    return branchesPanel(data);
  if (d.describe.startsWith("Trends"))
    return arr(data.rows).length >= 2 ? trendsPanel(data) : notePanel(d);
  if (d.describe.startsWith("AI events")) return eventsTablePanel(data);
  if (d.describe.startsWith("Daily commits")) return dailyCommitsPanel(data);
  if (d.describe.startsWith("Lines of code")) return locPanel(data);
  if (d.describe.startsWith("Test coverage")) return testRatioPanel(data);
  if (d.describe.startsWith("Code graph health")) return graphHealthPanel(data);
  if (d.describe.startsWith("Guardrail rules")) return guardrailRulesPanel(data);
  if (d.describe.startsWith("Build & analysis")) return buildTimesPanel(data);
  if (d.describe.startsWith("Repository information")) return repoInfoPanel(data);
  if (d.describe.startsWith("Tools installed")) return toolsInstalledPanel(data);
  if (d.describe.startsWith("AI CLI wiring")) return cliMatrixPanel(data);
  if (d.describe.startsWith("Configuration")) return checklistPanel(data);
  if (d.describe.startsWith("Machine tooling")) return toolingPanel(data);
  return notePanel(d);
}

/**
 * Category sections — panels grouped under labeled headers (the design's sections),
 * each its own bento that tiles cleanly. Per-panel spans are tuned so each category's
 * FULL set tiles into clean 12-col rows; gated/absent panels drop out and the grid
 * reflows (a lone panel stretches to full width). Anything unmatched lands in "More".
 */
const CATEGORIES: { title: string; prefixes: string[] }[] = [
  { title: "Output velocity", prefixes: ["Daily commits", "Lines of code"] },
  { title: "Code quality", prefixes: ["Test coverage", "Code graph health", "Guardrail rules"] },
  {
    title: "Performance",
    prefixes: ["Repository information", "Build & analysis", "Context footprint"],
  },
  {
    title: "Harness adoption",
    prefixes: [
      "Tools installed",
      "Repo status",
      "AI CLI wiring",
      "Configuration",
      "Machine tooling",
    ],
  },
  { title: "Trends over time", prefixes: ["Trends"] },
  { title: "Event log", prefixes: ["AI events"] },
];

/** Deterministic anchor id for a category section. `prefix` keeps the live and
 * demo trees (both rendered into the page) from colliding on the same id. */
function catId(title: string, prefix = ""): string {
  return `${prefix}cat-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

/**
 * Ordered {title,id} for categories that actually render (≥1 matching digest) —
 * drives the topbar jump-nav. Mirrors {@link renderSections}' ordering; category
 * prefixes are disjoint, so this presence `some()` matches its consume-once `take()`.
 * Keep adjacent to renderSections so that coupling stays visible.
 */
function sectionNav(digests: DigestAction[]): { title: string; id: string }[] {
  const has = (p: string): boolean => digests.some((d) => d.describe.startsWith(p));
  const out = CATEGORIES.filter((c) => c.prefixes.some(has)).map((c) => ({
    title: c.title,
    id: catId(c.title),
  }));
  const known = [...new Set(CATEGORIES.flatMap((c) => c.prefixes))];
  if (digests.some((d) => !known.some((p) => d.describe.startsWith(p))))
    out.push({ title: "More", id: catId("More") });
  return out;
}

/** One category section: numbered eyebrow + title + count, then its panel bento. */
function categorySection(title: string, no: number, panels: DigestAction[], idPrefix = ""): string {
  const idx = String(no).padStart(2, "0");
  return (
    `<section class="cat" id="${catId(title, idPrefix)}"><div class="cat-h">` +
    `<span class="cat-no">${idx}</span><h2>${esc(title)}</h2>` +
    `<span class="cat-ct">${panels.length}</span><span class="cat-rule"></span></div>` +
    `<div class="bento">${panels.map(panelFor).join("")}</div></section>`
  );
}

/** Group digests into ordered, labeled category sections; unmatched fall into "More". */
function renderSections(digests: DigestAction[], idPrefix = ""): string {
  const used = new Set<DigestAction>();
  const take = (prefix: string): DigestAction | undefined => {
    const d = digests.find((x) => !used.has(x) && x.describe.startsWith(prefix));
    if (d) used.add(d);
    return d;
  };
  const out: string[] = [];
  let n = 0;
  for (const cat of CATEGORIES) {
    const panels = cat.prefixes.map(take).filter((d): d is DigestAction => d !== undefined);
    if (panels.length > 0) out.push(categorySection(cat.title, ++n, panels, idPrefix));
  }
  const leftover = digests.filter((d) => !used.has(d));
  if (leftover.length > 0) out.push(categorySection("More", ++n, leftover, idPrefix));
  return out.join("");
}

const STYLE = `${EMBEDDED_FONTS}${GEIST_FONT}
:root{ color-scheme:dark;
  --display:'Geist','Inter',ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --bg:#0a0d13; --panel:#11151d; --panel2:#161b25; --line:#222a38; --line2:#2c3548;
  --fg:#e8edf4; --mut:#8893a7; --dim:#7e899e;
  --accent:#5b9dff; --accent2:#8a7bff; --ok:#3fdc8a; --warn:#ffc24b; --bad:#ff6b6b;
  --r:14px; --rs:9px; --sh:0 1px 0 rgba(255,255,255,.03) inset,0 10px 30px -16px rgba(0,0,0,.7); }
:root[data-theme="light"]{ color-scheme:light;
  --bg:#eef1f6; --panel:#fff; --panel2:#f6f8fc; --line:#e4e8f0; --line2:#d6dce8;
  --fg:#161b26; --mut:#5a6577; --dim:#646f83;
  --accent:#1d6fe0; --accent2:#6a4cf0; --ok:#0f9d58; --warn:#9a6700; --bad:#d12d2d;
  --sh:0 1px 2px rgba(20,30,50,.05),0 10px 30px -20px rgba(20,30,50,.25); }
*{box-sizing:border-box} html,body{margin:0}
:where(button,a,[tabindex]):focus-visible,.ev-wrap:focus-visible,.bars.scroll:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
.topbar{position:sticky;top:0;z-index:20;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.7rem 1rem;padding:.7rem clamp(1rem,4vw,2rem);background:color-mix(in oklab,var(--bg) 84%,transparent);backdrop-filter:blur(14px) saturate(1.4);-webkit-backdrop-filter:blur(14px) saturate(1.4);border-bottom:1px solid var(--line)}
.tb-brand h1{font-family:var(--display);font-size:1.15rem;font-weight:680;letter-spacing:-.02em;margin:0;line-height:1.15}
.tb-brand .sub{color:var(--mut);font-size:.73rem;margin-top:.12rem}
.tb-brand .sub code{color:var(--fg)}
.tb-right{display:flex;align-items:center;gap:.55rem}
.clocks{display:flex;gap:1.1rem;margin-right:.3rem}
.clk{display:flex;flex-direction:column;align-items:flex-end;line-height:1.1}
.clk i{font-style:normal;color:var(--dim);font-size:.56rem;letter-spacing:.13em;text-transform:uppercase}
.clk b{font:600 .82rem/1 'JetBrains Mono',ui-monospace,SFMono-Regular,monospace;font-variant-numeric:tabular-nums;color:var(--fg);margin-top:.13rem}
.tb-ico{display:inline-grid;place-items:center;width:34px;height:30px;padding:0;cursor:pointer;color:var(--mut);background:var(--panel);border:1px solid var(--line);border-radius:9px;transition:border-color .15s,color .15s,background .15s}
.tb-ico:hover{border-color:var(--line2);color:var(--fg)}
.tb-ico svg{display:block;width:15px;height:15px}
.tb-demo:hover{border-color:var(--accent);color:var(--accent)}
body[data-demo="on"] .tb-demo{background:color-mix(in oklab,var(--accent) 18%,transparent);border-color:color-mix(in oklab,var(--accent) 45%,transparent);color:var(--accent)}
@media(max-width:640px){.clocks{display:none}.tb-brand .sub{display:none}}
.skip{position:absolute;left:.6rem;top:-3rem;z-index:30;padding:.45rem .8rem;border-radius:9px;background:var(--panel);border:1px solid var(--line);color:var(--fg);font-size:.78rem;font-weight:600;text-decoration:none;transition:top .15s}
.skip:focus{top:.6rem}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
main:focus{outline:none}
.tb-nav{display:flex;gap:.15rem;align-items:center;overflow-x:auto;scrollbar-width:none;margin:0 .4rem}
.tb-nav::-webkit-scrollbar{display:none}
.tb-nav a{white-space:nowrap;color:var(--mut);font-size:.74rem;font-weight:550;padding:.32rem .55rem;border-radius:9px;text-decoration:none;transition:color .15s,background .15s}
.tb-nav a:hover{color:var(--fg);background:color-mix(in oklab,var(--fg) 6%,transparent)}
@media(max-width:820px){.tb-nav{display:none}}
.tool-i{margin-left:.34rem;font-style:normal;font-weight:700;font-size:.66rem;opacity:.7;border:1px solid currentColor;border-radius:999px;width:.95em;height:.95em;line-height:.85em;display:inline-grid;place-items:center;vertical-align:baseline}
.tool.off[data-hint]:hover .tool-i,.tool.off[data-hint]:focus-visible .tool-i{opacity:1}
body{ background:radial-gradient(1100px 520px at 78% -8%,color-mix(in oklab,var(--accent) 13%,transparent),transparent 58%),radial-gradient(900px 600px at 6% 108%,color-mix(in oklab,var(--accent2) 9%,transparent),transparent 60%),var(--bg);
  color:var(--fg); font:14px/1.5 'Inter',ui-sans-serif,system-ui,-apple-system,"Segoe UI Variable","Segoe UI",sans-serif; -webkit-font-smoothing:antialiased; }
main{max-width:1120px;margin:0 auto;padding:1.8rem 1.5rem 5rem}
.hero{display:grid;grid-template-columns:auto 1fr;gap:1rem;margin-bottom:1rem}
@media(max-width:680px){.hero{grid-template-columns:1fr}}
.ring-card{display:grid;place-items:center;gap:.35rem;background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:var(--r);padding:1.1rem 1.5rem;box-shadow:var(--sh)}
.ring-label{color:var(--mut);font-size:.7rem;text-transform:uppercase;letter-spacing:.09em}
.ring-bg{stroke:color-mix(in oklab,var(--fg) 9%,transparent)}
.ring.ok .ring-fg{stroke:var(--ok)} .ring.warn .ring-fg{stroke:var(--warn)} .ring.bad .ring-fg{stroke:var(--bad)}
.ring-num{font-family:var(--display);text-anchor:middle;font-size:30px;font-weight:660;fill:var(--fg);font-variant-numeric:tabular-nums}
.ring-cap{text-anchor:middle;font-size:11px;fill:var(--mut)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.7rem}
.kpi{display:flex;flex-direction:column;justify-content:center;gap:.2rem;background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:var(--r);padding:.95rem 1.05rem;box-shadow:var(--sh);transition:border-color .15s,transform .15s}
.kpi:hover{border-color:var(--line2);transform:translateY(-1px)}
.kpi-v{font-family:var(--display);font-size:1.55rem;font-weight:640;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi-v.over{color:var(--bad)}
.kpi-l{color:var(--mut);font-size:.7rem;text-transform:uppercase;letter-spacing:.06em}
.bento{display:grid;grid-template-columns:repeat(12,1fr);gap:1rem;grid-auto-flow:row dense}
.panel{grid-column:span 12;background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden;position:relative;transition:border-color .15s,box-shadow .15s,transform .15s}
.panel::before{content:"";position:absolute;inset:0 0 auto;height:1px;background:linear-gradient(90deg,transparent,color-mix(in oklab,var(--fg) 10%,transparent) 18%,color-mix(in oklab,var(--fg) 10%,transparent) 82%,transparent);pointer-events:none}
.panel:hover{border-color:var(--line2);transform:translateY(-1px);box-shadow:0 1px 0 rgba(255,255,255,.04) inset,0 18px 40px -20px rgba(0,0,0,.8)}
.span-4{grid-column:span 4}.span-5{grid-column:span 5}.span-7{grid-column:span 7}.span-12{grid-column:span 12}
.bento>.panel:only-child{grid-column:1/-1}
@media(max-width:820px){.span-5,.span-7{grid-column:span 12}.span-4{grid-column:span 6}}
@media(max-width:520px){.span-4{grid-column:span 12}}
.ph{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.8rem 1.1rem;border-bottom:1px solid var(--line)}
.ph h2{font-family:var(--display);font-size:.82rem;font-weight:640;text-transform:uppercase;letter-spacing:.07em;margin:0}
.pb{padding:1.05rem 1.1rem}
.badge{font-size:.71rem;font-weight:600;padding:.18rem .5rem;border-radius:999px;white-space:nowrap;background:color-mix(in oklab,var(--accent) 16%,transparent);color:var(--accent)}
.badge.muted{background:color-mix(in oklab,var(--mut) 15%,transparent);color:var(--mut)}
.badge.ok{background:color-mix(in oklab,var(--ok) 16%,transparent);color:var(--ok)}
.badge.over{background:color-mix(in oklab,var(--bad) 18%,transparent);color:var(--bad)}
.budget-track{height:10px;border-radius:999px;background:color-mix(in oklab,var(--fg) 8%,transparent);overflow:hidden}
.budget-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.budget-fill.over{background:linear-gradient(90deg,var(--warn),var(--bad))}
.budget-cap{display:flex;justify-content:space-between;color:var(--mut);font-size:.77rem;margin-top:.5rem;font-variant-numeric:tabular-nums}
.bars{list-style:none;margin:1rem 0 0;padding:0;display:grid;gap:.5rem}
.bars.scroll{max-height:340px;overflow-y:auto;padding-right:.5rem;scrollbar-width:thin;scrollbar-color:var(--line2) transparent}
.bars.scroll::-webkit-scrollbar{width:8px}
.bars.scroll::-webkit-scrollbar-thumb{background:var(--line2);border-radius:999px}
.bars li{display:grid;grid-template-columns:minmax(0,1fr) 84px 84px;align-items:center;gap:.7rem}
.bar-label{font:12px/1.4 'JetBrains Mono',ui-monospace,"Cascadia Code",SFMono-Regular,Consolas,monospace;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{display:block;height:7px;border-radius:999px;background:color-mix(in oklab,var(--fg) 8%,transparent);overflow:hidden}
.bar-fill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.bar-val{font:12px/1 'JetBrains Mono',ui-monospace,SFMono-Regular,monospace;color:var(--dim);text-align:right;font-variant-numeric:tabular-nums}
.bar-val i{font-style:normal;color:var(--mut);margin-left:.4rem;opacity:.8}
.branches{list-style:none;margin:0;padding:0;display:grid;gap:.1rem}
.branches li{display:flex;align-items:center;gap:.55rem;padding:.45rem .5rem;border-radius:var(--rs)}
.branches li:hover{background:color-mix(in oklab,var(--fg) 5%,transparent)}
.branches .dot{width:7px;height:7px;border-radius:999px;background:var(--dim);flex:none}
.branches li.cur .dot{background:var(--accent);box-shadow:0 0 0 3px color-mix(in oklab,var(--accent) 22%,transparent)}
.bname{font-weight:560;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bname .tag{color:var(--dim);font-weight:400;font-size:.76rem;margin-left:.35rem}
.age{color:var(--dim);font-size:.75rem;white-space:nowrap}
.pill{font-size:.71rem;font-weight:600;padding:.1rem .42rem;border-radius:999px;font-variant-numeric:tabular-nums}
.pill.up{background:color-mix(in oklab,var(--ok) 16%,transparent);color:var(--ok)}
.pill.down{background:color-mix(in oklab,var(--bad) 16%,transparent);color:var(--bad)}
.hint{margin-top:.7rem;color:var(--warn);font-size:.77rem}
.trend-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.9rem;padding:1.05rem 1.1rem}
.mini{background:var(--panel2);border:1px solid var(--line);border-radius:var(--rs);padding:.65rem .8rem}
.mini-h{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:.45rem}
.mini-h span{color:var(--mut);font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}
.mini-h b{font-size:1rem;font-variant-numeric:tabular-nums}
.mini-h i{font-style:normal;font-size:.72rem;color:var(--dim);margin-left:.3rem}
.mini svg{display:block;width:100%;height:40px}
.mini rect{fill:url(#g)}
.chips{display:flex;flex-wrap:wrap;gap:.5rem}
.chip{display:inline-flex;align-items:center;gap:.38rem;font-size:.79rem;padding:.3rem .58rem;border-radius:999px;border:1px solid var(--line);background:var(--panel2)}
.chip i{font-style:normal;font-size:.8rem}
.chip.ok{color:var(--ok);border-color:color-mix(in oklab,var(--ok) 28%,transparent)}
.chip.bad{color:var(--bad);border-color:color-mix(in oklab,var(--bad) 24%,transparent);opacity:.82}
.pills{display:flex;flex-wrap:wrap;gap:.5rem}
.tool{font-size:.79rem;padding:.32rem .68rem;border-radius:999px;font-weight:550}
.tool.on{background:color-mix(in oklab,var(--accent) 17%,transparent);color:var(--accent);border:1px solid color-mix(in oklab,var(--accent) 34%,transparent)}
.tool.off{color:var(--dim);border:1px solid var(--line);text-decoration:line-through;text-decoration-color:color-mix(in oklab,var(--dim) 55%,transparent);opacity:.72}
.tool.off[data-hint]{cursor:help}
.tool.off[data-hint]:hover{opacity:1;color:var(--mut);border-color:color-mix(in oklab,var(--accent) 40%,transparent)}
.cat{margin-top:1.9rem;scroll-margin-top:4.5rem}
.cat:first-child{margin-top:.2rem}
.cat-h{display:flex;align-items:center;gap:.65rem;margin:0 0 .9rem;padding:0 .1rem}
.cat-no{font:600 .72rem/1 'JetBrains Mono',ui-monospace,SFMono-Regular,monospace;color:var(--accent);opacity:.7;letter-spacing:.04em}
.cat-h h2{font-family:var(--display);font-size:.84rem;font-weight:680;text-transform:uppercase;letter-spacing:.15em;color:var(--fg);margin:0;white-space:nowrap}
.cat-ct{font:600 .64rem/1 'JetBrains Mono',ui-monospace,SFMono-Regular,monospace;color:var(--mut);background:color-mix(in oklab,var(--mut) 15%,transparent);border-radius:999px;padding:.18rem .44rem;font-variant-numeric:tabular-nums}
.cat-rule{flex:1;height:1px;background:linear-gradient(90deg,var(--line2),transparent)}
.prose{font:12.5px/1.6 'JetBrains Mono',ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--mut);white-space:pre-wrap;margin:0}
footer{color:var(--dim);font-size:.75rem;text-align:center;margin-top:2.4rem}
footer code{color:var(--mut)}
.ev-wrap{max-height:380px;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--line2) transparent}
.ev-wrap::-webkit-scrollbar{width:8px}.ev-wrap::-webkit-scrollbar-thumb{background:var(--line2);border-radius:999px}
.events{width:100%;border-collapse:collapse;font-size:.8rem}
.events th{position:sticky;top:0;background:var(--panel);text-align:left;color:var(--mut);font-size:.67rem;text-transform:uppercase;letter-spacing:.06em;font-weight:600;padding:.55rem .9rem;border-bottom:1px solid var(--line)}
.events td{padding:.42rem .9rem;border-bottom:1px solid color-mix(in oklab,var(--line) 55%,transparent)}
.events tbody tr:hover td{background:color-mix(in oklab,var(--fg) 4%,transparent)}
.events td.t,.events td.mono{font:12px/1.4 'JetBrains Mono',ui-monospace,SFMono-Regular,monospace;color:var(--mut)}
.events td.loc{text-align:right;font:12px/1 'JetBrains Mono',ui-monospace,monospace;white-space:nowrap}
.ev{font-size:.66rem;font-weight:600;padding:.1rem .42rem;border-radius:999px;text-transform:uppercase;letter-spacing:.03em}
.ev.k-commit{background:color-mix(in oklab,var(--accent) 18%,transparent);color:var(--accent)}
.ev.k-skill{background:color-mix(in oklab,var(--accent2) 20%,transparent);color:var(--accent2)}
.ev.k-mcp{background:color-mix(in oklab,var(--ok) 16%,transparent);color:var(--ok)}
.ev.k-other{background:color-mix(in oklab,var(--mut) 16%,transparent);color:var(--mut)}
.add{color:var(--ok);font-weight:600}.del{color:var(--bad);font-weight:600}.dim{color:var(--dim)}
.more{color:var(--dim);font-size:.74rem;padding:.6rem 1.1rem 0}
.daybars{display:block;width:100%;height:56px}.daybars rect{fill:url(#g)}
.empty{color:var(--dim);font-size:.8rem;padding:1rem 0}
.vel-sub{display:flex;gap:1.5rem;margin-top:.85rem;color:var(--mut);font-size:.76rem}
.vel-sub b{color:var(--fg);font-size:1.02rem;font-variant-numeric:tabular-nums;margin-right:.25rem}
.loc-row{display:flex;gap:1.9rem}.loc-big{display:flex;flex-direction:column;gap:.15rem}
.loc-big span:first-child{font-family:var(--display);font-size:1.7rem;font-weight:660;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.loc-l{color:var(--mut);font-size:.7rem;text-transform:uppercase;letter-spacing:.06em}
.loc-net{margin-top:.75rem;color:var(--mut);font-size:.82rem;font-variant-numeric:tabular-nums}
.ratio{display:flex;flex-direction:column;gap:.18rem}
.ratio-v{font-family:var(--display);font-size:2.15rem;font-weight:660;color:var(--warn);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.ratio-l{color:var(--mut);font-size:.78rem}.ratio-sub{color:var(--dim);font-size:.74rem;margin-top:.3rem}
.ri-head{display:flex;gap:1.7rem;margin-bottom:.2rem;color:var(--mut);font-size:.8rem}
.ri-head b{color:var(--fg);font-variant-numeric:tabular-nums;margin-right:.25rem}
.statlist{list-style:none;margin:0;padding:0;display:grid;gap:.1rem}
.statlist li{display:flex;justify-content:space-between;align-items:center;padding:.5rem 0;border-bottom:1px solid color-mix(in oklab,var(--line) 55%,transparent)}
.statlist li:last-child{border-bottom:0}
.statlist span{color:var(--mut);font-size:.82rem}
.statlist b{font-variant-numeric:tabular-nums;font-size:1.02rem}
.guardrails{list-style:none;margin:0;padding:0;display:grid;gap:.8rem}
.guardrails li{display:grid;grid-template-columns:88px 1fr 32px;align-items:center;gap:.7rem}
.gr-l{font-size:.71rem;font-weight:600;letter-spacing:.04em;color:var(--mut)}
.gr-fill{display:block;height:100%;border-radius:999px}
.gr-fill.crit{background:var(--bad)}.gr-fill.imp{background:var(--warn)}.gr-fill.sty{background:var(--accent)}
.gr-v{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.cli-matrix{width:100%;border-collapse:collapse;font-size:.8rem}
.cli-matrix th{text-align:left;color:var(--mut);font-weight:600;font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;padding:.3rem .5rem;border-bottom:1px solid var(--line)}
.cli-matrix td{padding:.42rem .5rem;border-bottom:1px solid color-mix(in oklab,var(--line) 55%,transparent)}
.cli-matrix tbody tr:last-child td{border-bottom:0}
.cli-name{font-weight:600;white-space:nowrap}
.cli-sep td{color:var(--dim);font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;padding-top:.8rem;border-bottom:0}
.cli-cell{display:inline-flex;align-items:center;gap:.32rem;white-space:nowrap;font-variant-numeric:tabular-nums}
.cli-cell.ok{color:var(--ok)}.cli-cell.bad{color:var(--bad)}.cli-cell.warn{color:var(--warn)}.cli-cell.muted{color:var(--dim)}
.cli-legend{display:flex;flex-wrap:wrap;gap:.9rem;align-items:center;margin-bottom:.7rem;font-size:.72rem}
.cli-src{color:var(--mut);margin-left:auto}
.demo-banner{display:none;align-items:center;gap:.5rem;background:color-mix(in oklab,var(--warn) 13%,transparent);border:1px solid color-mix(in oklab,var(--warn) 32%,transparent);color:var(--warn);border-radius:var(--rs);padding:.6rem .95rem;margin-bottom:1.1rem;font-size:.8rem;font-weight:600}
#aih-demo{display:none}
body[data-demo="on"] #aih-live{display:none}
body[data-demo="on"] #aih-demo{display:block}
body[data-demo="on"] .demo-banner{display:flex}
body[data-demo="on"] .tb-nav{display:none}
`.trim();

/**
 * Render the report as a self-contained, zero-dependency dark dashboard: an
 * adoption ring + KPI strip, then a bento of data-driven panels (context budget +
 * contributor bars, branch status with ahead/behind pills, trend charts, adoption
 * checklist chips, tooling badges) derived from each digest's structured `data`.
 * Byte-stable (no timestamp) so re-applying the artifact stays a no-op.
 */
/** The hero (adoption ring + KPI strip) for a digest set — reused for live + demo. */
function buildHero(digests: DigestAction[]): string {
  const bloat = dataFor(digests, "Context footprint");
  const repo = dataFor(digests, "Repo status");
  const trends = dataFor(digests, "Trends");
  const config = dataFor(digests, "Configuration");
  const tooling = dataFor(digests, "Machine tooling");
  const wiring = dataFor(digests, "AI CLI wiring");
  const velocity = dataFor(digests, "Daily commits");
  const quality = dataFor(digests, "Test coverage");

  const present = config ? arr(config.present).length : 0;
  const total = num(config?.total) ?? 0;
  const adoptionPct = config && total > 0 ? (100 * present) / total : undefined;

  // commits prefer the velocity panel's exact count; fall back to the last trend sample.
  const commits7d =
    (velocity?.commits as { d7?: number } | undefined)?.d7 ??
    (arr(trends?.rows).at(-1) as Snap | undefined)?.commits7d;

  const tiles: string[] = [];
  if (commits7d !== undefined) tiles.push(kpi(fmt(commits7d), "commits (7d)"));
  if (quality) tiles.push(kpi(fmt(num(quality.sourceFiles) ?? 0), "source files"));
  if (quality) tiles.push(kpi(`${num(quality.ratio) ?? 0}%`, "test ratio"));
  if (repo) tiles.push(kpi(String(arr(repo.branches).length), "active branches"));
  if (bloat)
    tiles.push(
      kpi(`~${fmt(num(bloat.totalTokens) ?? 0)}`, "context tokens", bloat.overBudget === true),
    );
  if (wiring)
    tiles.push(
      kpi(
        `${num(wiring.structurallyConfigured) ?? 0}/${num(wiring.totalTargeted) ?? 0}`,
        "tools wired",
      ),
    );
  if (tooling)
    tiles.push(kpi(`${arr(tooling.present).length}/${num(tooling.total) ?? 0}`, "CLIs installed"));

  return `<section class="hero">${
    adoptionPct !== undefined
      ? `<div class="ring-card">${ring(adoptionPct)}<span class="ring-label">adoption</span></div>`
      : ""
  }<div class="kpis">${tiles.join("")}</div></section>`;
}

/** The product brand shown in the sticky top bar (the report's fixed header). */
const BRAND = "Enterprise AI Bootstrapping Harness Report";

export function reportHtml(
  title: string,
  digests: DigestAction[],
  opts: { refresh?: number; demo?: boolean } = {},
): string {
  const liveContent = `${buildHero(digests)}${renderSections(digests)}`;
  // Topbar jump-nav reflects the live report's present sections (demo shares the
  // same category titles). The demo tree is rendered with a `demo-` id prefix so
  // its section anchors never collide with the live ones.
  const nav = sectionNav(digests);
  // A fixed DEMO dataset is always embedded behind the "◑ demo" toggle (and shown by
  // default under `--demo`) so the full report can be visualized / showcased.
  const demoSet = demoDigests();
  const demoContent = `${buildHero(demoSet)}${renderSections(demoSet, "demo-")}`;

  const refreshMeta =
    opts.refresh && opts.refresh > 0
      ? `  <meta http-equiv="refresh" content="${Math.floor(opts.refresh)}">`
      : "";
  return lines(
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    ...(refreshMeta ? [refreshMeta] : []),
    `  <title>${esc(title)}</title>`,
    `  <style>${STYLE}</style>`,
    "</head>",
    `<body${opts.demo ? ' data-demo="on"' : ""}>`,
    '  <a class="skip" href="#main">Skip to report</a>',
    '  <header class="topbar">',
    `    <div class="tb-brand"><h1>${BRAND}</h1><div class="sub">self-contained · generated by <code>aih report</code></div></div>`,
    `    <nav class="tb-nav" aria-label="Report sections">${nav.map((s) => `<a href="#${s.id}">${esc(s.title)}</a>`).join("")}</nav>`,
    '    <div class="tb-right">',
    '      <div class="clocks"><span class="clk"><i>UTC</i><b id="clk-utc">··:··:··</b></span><span class="clk"><i>Local</i><b id="clk-loc">··:··:··</b></span></div>',
    '      <button class="tb-ico tb-demo" type="button" onclick="aihDemo()" aria-label="Toggle demo data" title="Demo data"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6M10 3v6l-4.4 7.6A1.5 1.5 0 0 0 6.9 19h10.2a1.5 1.5 0 0 0 1.3-2.4L14 9V3"/><path d="M7.2 14h9.6"/></svg></button>',
    '      <button class="tb-ico" type="button" onclick="aihTheme()" aria-label="Toggle light / dark theme" title="Toggle theme"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/></svg></button>',
    "    </div>",
    "  </header>",
    '  <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--accent)"/><stop offset="1" style="stop-color:var(--accent2)"/></linearGradient><filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs></svg>',
    '  <main id="main" tabindex="-1">',
    '    <div class="demo-banner">▲ DEMO DATA — illustrative figures for showcasing the report; not your repo. Click “◑ demo” to switch back.</div>',
    `    <div id="aih-live">${liveContent}</div>`,
    `    <div id="aih-demo">${demoContent}</div>`,
    "    <footer>No external assets — open anywhere, commit nowhere (<code>.aih/</code> is git-ignored).</footer>",
    "  </main>",
    '  <script>(function(){var r=document.documentElement,k="aih-theme";try{var s=localStorage.getItem(k);if(s)r.dataset.theme=s}catch(e){}window.aihTheme=function(){var n=r.dataset.theme==="light"?"":"light";n?r.dataset.theme=n:r.removeAttribute("data-theme");try{localStorage.setItem(k,n)}catch(e){}};window.aihDemo=function(){var b=document.body;b.dataset.demo=b.dataset.demo==="on"?"":"on";window.scrollTo(0,0)};function p(n){return(n<10?"0":"")+n}function clk(){var d=new Date(),u=p(d.getUTCHours())+":"+p(d.getUTCMinutes())+":"+p(d.getUTCSeconds()),l=p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds()),a=document.getElementById("clk-utc"),c=document.getElementById("clk-loc");if(a)a.textContent=u;if(c)c.textContent=l}clk();setInterval(clk,1000)})();</script>',
    "</body>",
    "</html>",
  );
}
