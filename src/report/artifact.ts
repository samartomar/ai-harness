import type { DigestAction } from "../internals/plan.js";
import { lines } from "../internals/render.js";

/** HTML-escape text for safe embedding in markup. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
const asNum = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const asArr = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);

/** First digest whose `data` satisfies `pred` (duck-typed panel lookup). */
function pick(digests: DigestAction[], pred: (d: Bag) => boolean): Bag | undefined {
  for (const d of digests) {
    const data = d.data as Bag | undefined;
    if (data && pred(data)) return data;
  }
  return undefined;
}

interface Kpi {
  label: string;
  value: string;
}

/** An SVG donut for a 0–100 score, colored green ≥80 / amber ≥50 / red below. */
function donut(pct: number): string {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const r = 52;
  const c = 2 * Math.PI * r;
  const cls = p >= 80 ? "ok" : p >= 50 ? "warn" : "bad";
  return [
    `<svg class="ring ${cls}" viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="adoption ${p} of 100">`,
    '  <circle class="ring-bg" cx="60" cy="60" r="52" fill="none" stroke-width="12"/>',
    `  <circle class="ring-fg" cx="60" cy="60" r="52" fill="none" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(c * p) / 100} ${c}" transform="rotate(-90 60 60)"/>`,
    `  <text x="60" y="58" class="ring-num">${p}</text>`,
    '  <text x="60" y="76" class="ring-cap">/ 100</text>',
    "</svg>",
  ].join("\n");
}

/** A small SVG column chart for a numeric series. */
function barChart(label: string, values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const w = 14;
  const gap = 4;
  const h = 48;
  const bars = values
    .map((v, i) => {
      const bh = Math.max(2, ((v - min) / span) * h);
      return `<rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" rx="2"/>`;
    })
    .join("");
  const last = values[values.length - 1] ?? 0;
  const delta = last - (values[0] ?? 0);
  const width = values.length * (w + gap);
  return [
    '<div class="trend">',
    `  <div class="trend-head"><span>${esc(label)}</span><b>${last} <i>(${delta >= 0 ? "+" : ""}${delta})</i></b></div>`,
    `  <svg class="bars" viewBox="0 0 ${width} ${h}" width="100%" height="${h}" preserveAspectRatio="none">${bars}</svg>`,
    "</div>",
  ].join("\n");
}

function kpiStrip(kpis: Kpi[]): string {
  if (kpis.length === 0) return "";
  const cards = kpis
    .map(
      (k) =>
        `  <div class="kpi"><div class="kpi-v">${esc(k.value)}</div><div class="kpi-l">${esc(k.label)}</div></div>`,
    )
    .join("\n");
  return `<section class="kpis">\n${cards}\n</section>`;
}

interface Snap {
  commits7d?: number;
  loc?: { net?: number };
  adoptionScore?: number;
  branches?: number;
  sourceFiles?: number;
}

/** Build the hero (ring + KPI strip) + trend charts from recognized digest data. */
function dashboardHead(digests: DigestAction[]): string {
  const config = pick(
    digests,
    (d) => Array.isArray(d.present) && Array.isArray(d.absent) && asNum(d.total) !== undefined,
  );
  const bloat = pick(digests, (d) => asNum(d.totalTokens) !== undefined && Array.isArray(d.files));
  const repo = pick(digests, (d) => Array.isArray(d.branches) && typeof d.current === "string");
  const tooling = pick(
    digests,
    (d) =>
      Array.isArray(d.present) && asArr(d.absent) === undefined && asNum(d.total) !== undefined,
  );
  const trends = pick(digests, (d) => asNum(d.samples) !== undefined && Array.isArray(d.rows));
  const rows = (asArr(trends?.rows) ?? []) as Snap[];
  const latest = rows[rows.length - 1];

  const present = (asArr(config?.present) ?? []).length;
  const total = asNum(config?.total) ?? 0;
  const adoptionPct = total > 0 ? (100 * present) / total : undefined;

  const kpis: Kpi[] = [];
  if (bloat) kpis.push({ label: "context tokens", value: `~${asNum(bloat.totalTokens)}` });
  if (repo)
    kpis.push({ label: "local branches", value: String((asArr(repo.branches) ?? []).length) });
  if (latest?.sourceFiles !== undefined)
    kpis.push({ label: "tracked files", value: String(latest.sourceFiles) });
  if (latest?.commits7d !== undefined)
    kpis.push({ label: "commits (7d)", value: String(latest.commits7d) });
  if (tooling)
    kpis.push({
      label: "AI CLIs here",
      value: `${(asArr(tooling.present) ?? []).length}/${asNum(tooling.total)}`,
    });
  if (config) kpis.push({ label: "config present", value: `${present}/${total}` });

  const ring =
    adoptionPct !== undefined
      ? `<div class="hero-ring">${donut(adoptionPct)}<span>adoption</span></div>`
      : "";

  const charts =
    rows.length >= 2
      ? [
          '<section class="trends">',
          "  <h2>Trends</h2>",
          '  <div class="trend-grid">',
          barChart(
            "commits (7d)",
            rows.map((r) => r.commits7d ?? 0),
          ),
          barChart(
            "LOC net",
            rows.map((r) => r.loc?.net ?? 0),
          ),
          barChart(
            "adoption",
            rows.map((r) => r.adoptionScore ?? 0),
          ),
          barChart(
            "branches",
            rows.map((r) => r.branches ?? 0),
          ),
          "  </div>",
          "</section>",
        ].join("\n")
      : "";

  return [`<section class="hero">${ring}${kpiStrip(kpis)}</section>`, charts]
    .filter(Boolean)
    .join("\n");
}

const STYLE = `
:root { color-scheme: dark light;
  --bg: #0e1116; --panel: #161b22; --line: #2a313c; --fg: #e6edf3; --mut: #8b949e;
  --accent: #4493f8; --ok: #3fb950; --warn: #d29922; --bad: #f85149; }
@media (prefers-color-scheme: light) {
  :root { --bg: #f6f8fa; --panel: #fff; --line: #d0d7de; --fg: #1f2328; --mut: #636c76; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; }
main { max-width: 1040px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1 { font-size: 1.5rem; margin: 0 0 1.25rem; }
h2 { font-size: 1.05rem; margin: 1.5rem 0 .6rem; }
.hero { display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap;
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 1.25rem 1.4rem; }
.hero-ring { display: flex; flex-direction: column; align-items: center; gap: .25rem; color: var(--mut); font-size: .8rem; }
.ring-bg { stroke: var(--line); }
.ring.ok .ring-fg { stroke: var(--ok); } .ring.warn .ring-fg { stroke: var(--warn); } .ring.bad .ring-fg { stroke: var(--bad); }
.ring-num { text-anchor: middle; font-size: 30px; font-weight: 700; fill: var(--fg); }
.ring-cap { text-anchor: middle; font-size: 11px; fill: var(--mut); }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: .75rem; flex: 1; min-width: 240px; }
.kpi { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: .7rem .8rem; }
.kpi-v { font-size: 1.4rem; font-weight: 700; }
.kpi-l { color: var(--mut); font-size: .78rem; margin-top: .15rem; }
.trends { margin-top: 1.5rem; }
.trend-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
.trend { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: .8rem 1rem; }
.trend-head { display: flex; justify-content: space-between; align-items: baseline; color: var(--mut); font-size: .82rem; margin-bottom: .4rem; }
.trend-head b { color: var(--fg); font-size: 1rem; } .trend-head i { color: var(--mut); font-style: normal; font-size: .8rem; }
.bars rect { fill: var(--accent); }
section.detail { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: .4rem 1.1rem 1rem; margin-top: 1rem; }
section.detail h2 { border-bottom: 1px solid var(--line); padding-bottom: .35rem; }
pre { font: 12.5px/1.5 ui-monospace, SFMono-Regular, monospace; white-space: pre-wrap;
  color: var(--fg); margin: .4rem 0 0; }
footer { color: var(--mut); font-size: .78rem; margin-top: 2rem; text-align: center; }
`.trim();

/**
 * Render the report's digests as a self-contained, zero-dependency HTML dashboard
 * (dark/light aware): an adoption ring + KPI strip + trend charts derived from the
 * digests' structured `data`, then a detail section per digest (verbatim body).
 * Byte-stable (no timestamp) so re-applying the artifact stays a no-op.
 */
export function reportHtml(title: string, digests: DigestAction[]): string {
  const sections = digests
    .map(
      (d) =>
        `  <section class="detail">\n    <h2>${esc(d.describe)}</h2>\n    <pre>${esc(d.text.replace(/\n+$/, ""))}</pre>\n  </section>`,
    )
    .join("\n");
  return lines(
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${esc(title)}</title>`,
    `  <style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "  <main>",
    `    <h1>${esc(title)}</h1>`,
    dashboardHead(digests),
    sections,
    "    <footer>Generated by <code>aih report</code> — self-contained, no external assets.</footer>",
    "  </main>",
    "</body>",
    "</html>",
  );
}
