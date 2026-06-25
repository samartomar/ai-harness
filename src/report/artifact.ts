import type { DigestAction } from "../internals/plan.js";
import { lines } from "../internals/render.js";

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
    '  <defs><filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>',
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
  const top = [...files].sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0)).slice(0, 8);
  const max = Math.max(1, ...top.map((f) => f.tokens ?? 0));
  const rows = top
    .map(
      (f) =>
        `<li><span class="bar-label" title="${esc(f.path)}">${esc(f.path)}</span><span class="bar-track"><span class="bar-fill" style="width:${(((f.tokens ?? 0) / max) * 100).toFixed(1)}%"></span></span><span class="bar-val">${fmt(f.tokens ?? 0)}</span></li>`,
    )
    .join("");
  const badge = over
    ? `<span class="badge over">OVER by ${fmt(tokens - budget)}</span>`
    : `<span class="badge muted">${Math.round(pct)}% of budget</span>`;
  const body = [
    `<div class="budget-track"><div class="budget-fill${over ? " over" : ""}" style="width:${pct.toFixed(1)}%"></div></div>`,
    `<div class="budget-cap"><span>${fmt(tokens)} tokens · ${files.length} files</span><span>budget ${fmt(budget)}</span></div>`,
    `<ul class="bars">${rows}</ul>`,
  ].join("");
  return panel("Context footprint", badge, body, 7);
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
      return `<rect x="${i * (w + gap)}" y="${(h - bh).toFixed(1)}" width="${w}" height="${bh.toFixed(1)}" rx="2"/>`;
    })
    .join("");
  const last = v[v.length - 1] ?? 0;
  const delta = last - (v[0] ?? 0);
  return `<div class="mini"><div class="mini-h"><span>${esc(label)}</span><b>${fmt(last)}<i>${delta >= 0 ? "+" : ""}${fmt(delta)}</i></b></div><svg viewBox="0 0 ${v.length * (w + gap)} ${h}" preserveAspectRatio="none">${bars}</svg></div>`;
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

/** Tooling: pill per AI CLI — filled when present, struck-through when absent. */
function toolingPanel(d: Bag): string {
  const present = arr(d.present) as string[];
  const absent = arr(d.absent) as string[];
  const total = num(d.total) ?? present.length + absent.length;
  const pills = [
    ...present.map((n) => `<span class="tool on">${esc(n)}</span>`),
    ...absent.map((n) => `<span class="tool off">${esc(n)}</span>`),
  ].join("");
  return panel(
    "Tooling",
    `<span class="badge muted">${present.length}/${total}</span>`,
    `<div class="pills">${pills}</div>`,
    7,
  );
}

/** A clean styled panel for notes/stubs/unrecognized digests (no data viz). */
function notePanel(d: DigestAction): string {
  return panel(d.describe, "", `<pre class="prose">${esc(d.text.replace(/\n+$/, ""))}</pre>`, 12);
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
  if (d.describe.startsWith("Configuration")) return checklistPanel(data);
  if (d.describe.startsWith("Tooling")) return toolingPanel(data);
  return notePanel(d);
}

const STYLE = `
:root{ color-scheme:dark;
  --bg:#0a0d13; --panel:#11151d; --panel2:#161b25; --line:#222a38; --line2:#2c3548;
  --fg:#e8edf4; --mut:#8893a7; --dim:#5b6678;
  --accent:#5b9dff; --accent2:#8a7bff; --ok:#3fdc8a; --warn:#ffc24b; --bad:#ff6b6b;
  --r:14px; --rs:9px; --sh:0 1px 0 rgba(255,255,255,.03) inset,0 10px 30px -16px rgba(0,0,0,.7); }
@media (prefers-color-scheme:light){ :root{ color-scheme:light;
  --bg:#eef1f6; --panel:#fff; --panel2:#f6f8fc; --line:#e4e8f0; --line2:#d6dce8;
  --fg:#161b26; --mut:#5a6577; --dim:#8a94a6; --sh:0 1px 2px rgba(20,30,50,.05),0 10px 30px -20px rgba(20,30,50,.25); } }
*{box-sizing:border-box} html,body{margin:0}
body{ background:radial-gradient(1100px 520px at 78% -8%,color-mix(in oklab,var(--accent) 13%,transparent),transparent 58%),var(--bg);
  color:var(--fg); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; -webkit-font-smoothing:antialiased; }
main{max-width:1120px;margin:0 auto;padding:2.4rem 1.5rem 5rem}
header{margin-bottom:1.4rem}
h1{font-size:1.42rem;font-weight:680;letter-spacing:-.015em;margin:0}
.sub{color:var(--mut);font-size:.82rem;margin-top:.3rem}
.hero{display:grid;grid-template-columns:auto 1fr;gap:1rem;margin-bottom:1rem}
@media(max-width:680px){.hero{grid-template-columns:1fr}}
.ring-card{display:grid;place-items:center;gap:.35rem;background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:var(--r);padding:1.1rem 1.5rem;box-shadow:var(--sh)}
.ring-label{color:var(--mut);font-size:.7rem;text-transform:uppercase;letter-spacing:.09em}
.ring-bg{stroke:color-mix(in oklab,var(--fg) 9%,transparent)}
.ring.ok .ring-fg{stroke:var(--ok)} .ring.warn .ring-fg{stroke:var(--warn)} .ring.bad .ring-fg{stroke:var(--bad)}
.ring-num{text-anchor:middle;font-size:30px;font-weight:720;fill:var(--fg);font-variant-numeric:tabular-nums}
.ring-cap{text-anchor:middle;font-size:11px;fill:var(--mut)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.7rem}
.kpi{display:flex;flex-direction:column;justify-content:center;gap:.2rem;background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:var(--r);padding:.95rem 1.05rem;box-shadow:var(--sh);transition:border-color .15s,transform .15s}
.kpi:hover{border-color:var(--line2);transform:translateY(-1px)}
.kpi-v{font-size:1.55rem;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi-v.over{color:var(--bad)}
.kpi-l{color:var(--mut);font-size:.7rem;text-transform:uppercase;letter-spacing:.06em}
.bento{display:grid;grid-template-columns:repeat(12,1fr);gap:1rem}
.panel{grid-column:span 12;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
.span-5{grid-column:span 5}.span-7{grid-column:span 7}.span-12{grid-column:span 12}
@media(max-width:820px){.span-5,.span-7{grid-column:span 12}}
.ph{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.8rem 1.1rem;border-bottom:1px solid var(--line)}
.ph h2{font-size:.82rem;font-weight:640;text-transform:uppercase;letter-spacing:.07em;margin:0}
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
.bars li{display:grid;grid-template-columns:1fr 96px 56px;align-items:center;gap:.7rem}
.bar-label{font:12px/1.4 ui-monospace,SFMono-Regular,monospace;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{height:7px;border-radius:999px;background:color-mix(in oklab,var(--fg) 8%,transparent);overflow:hidden}
.bar-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.bar-val{font:12px/1 ui-monospace,monospace;color:var(--dim);text-align:right;font-variant-numeric:tabular-nums}
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
.prose{font:12.5px/1.6 ui-monospace,SFMono-Regular,monospace;color:var(--mut);white-space:pre-wrap;margin:0}
footer{color:var(--dim);font-size:.75rem;text-align:center;margin-top:2.4rem}
footer code{color:var(--mut)}
`.trim();

/**
 * Render the report as a self-contained, zero-dependency dark dashboard: an
 * adoption ring + KPI strip, then a bento of data-driven panels (context budget +
 * contributor bars, branch status with ahead/behind pills, trend charts, adoption
 * checklist chips, tooling badges) derived from each digest's structured `data`.
 * Byte-stable (no timestamp) so re-applying the artifact stays a no-op.
 */
export function reportHtml(title: string, digests: DigestAction[]): string {
  const bloat = dataFor(digests, "Context footprint");
  const repo = dataFor(digests, "Repo status");
  const trends = dataFor(digests, "Trends");
  const config = dataFor(digests, "Configuration");
  const tooling = dataFor(digests, "Tooling");

  const present = config ? arr(config.present).length : 0;
  const total = num(config?.total) ?? 0;
  const adoptionPct = config && total > 0 ? (100 * present) / total : undefined;

  const tiles: string[] = [];
  if (bloat)
    tiles.push(
      kpi(`~${fmt(num(bloat.totalTokens) ?? 0)}`, "context tokens", bloat.overBudget === true),
    );
  if (bloat) tiles.push(kpi(String(arr(bloat.files).length), "context files"));
  if (repo) tiles.push(kpi(String(arr(repo.branches).length), "local branches"));
  if (trends) {
    const last = arr(trends.rows).at(-1) as Snap | undefined;
    if (last?.commits7d !== undefined) tiles.push(kpi(String(last.commits7d), "commits (7d)"));
  }
  if (tooling)
    tiles.push(kpi(`${arr(tooling.present).length}/${num(tooling.total) ?? 0}`, "AI CLIs here"));

  const hero = `<section class="hero">${
    adoptionPct !== undefined
      ? `<div class="ring-card">${ring(adoptionPct)}<span class="ring-label">adoption</span></div>`
      : ""
  }<div class="kpis">${tiles.join("")}</div></section>`;

  const bento = `<div class="bento">${digests.map(panelFor).join("")}</div>`;

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
    '  <svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--accent)"/><stop offset="1" style="stop-color:var(--accent2)"/></linearGradient></defs></svg>',
    "  <main>",
    `    <header><h1>${esc(title)}</h1><div class="sub">self-contained · generated by <code>aih report</code></div></header>`,
    `    ${hero}`,
    `    ${bento}`,
    "    <footer>No external assets — open anywhere, commit nowhere (<code>.aih/</code> is git-ignored).</footer>",
    "  </main>",
    "</body>",
    "</html>",
  );
}
