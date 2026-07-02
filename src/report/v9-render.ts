/**
 * Pure server-side renderers for the v9 dashboard panels. Each function takes a typed
 * data slice (from {@link AihDataV9}) and returns the inner HTML for that section's
 * container (`.grid`, `.anom-strip`, or `.hero-narrative`), reproducing the reference
 * design's markup/classes verbatim. No IO, no clock — same input, same bytes.
 *
 * The renderers are the single rendering path for BOTH live and demo: the caller
 * ({@link assembleViewV9}) chooses real vs demo data per (sub-)card and passes a
 * `preview` flag where a capability is not wired yet, which desaturates the card and
 * shows the `.preview` "PREVIEW · not wired yet" corner ribbon so it never reads as real.
 */

import type {
  V9Action,
  V9Activity,
  V9Adoption,
  V9Context,
  V9Drift,
  V9Hero,
  V9Mcp,
  V9Period,
  V9Quality,
  V9Ready,
  V9SkillGovernance,
  V9Skills,
  V9Support,
  V9Wins,
} from "./v9-types.js";

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Deterministic thousands grouping (no locale). */
function thousands(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Pick a delta-badge color from its text (matches the reference's hand-tuned set). */
function deltaBadgeClass(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("open action")) return "warn";
  if (t.includes("drift")) return "muted";
  return "ok";
}

/** Donut stroke-dasharray length for a percentage (full ring ≈ 2π·52). */
function donutDash(pct: number): number {
  return Math.round((Math.max(0, Math.min(100, pct)) / 100) * 326.726);
}

/** A compact area+line sparkline over a series, scaled to the 200×40 viewBox. */
export function sparkline(series: number[], stroke: string): string {
  if (series.length < 2) return "";
  const max = Math.max(1, ...series);
  const n = series.length;
  const pts = series.map((v, i) => {
    const x = (i / (n - 1)) * 200;
    const y = 4 + (1 - v / max) * 32;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg viewBox="0 0 200 40" preserveAspectRatio="none" style="width:100%;height:40px"><path d="M0,40 L${pts.join(" L")} L200,40 Z" fill="url(#sparkArea)"/><polyline points="${pts.join(" ")}" fill="none" stroke="${stroke}" stroke-width="2"/></svg>`;
}

const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_ALERT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 9v4M12 17h.01"/></svg>';
const ICON_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6 6 18M6 6l12 12"/></svg>';
// Half-filled circle (◐) — a wired-but-machine-local MCP (global scope): not a
// fixable divergence, just not repo-portable, so it gets a neutral glyph, not amber.
const ICON_GLOBE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/></svg>';

/** A matrix cell verdict → its CSS class + glyph. */
function cellMark(v: string): string {
  if (v === "global") {
    return `<div class="mc global" title="wired · machine-local (not repo-portable)">${ICON_GLOBE}</div>`;
  }
  const cls = v === "ok" ? "ok" : v === "warn" ? "warn" : "bad";
  const icon = v === "ok" ? ICON_CHECK : v === "warn" ? ICON_ALERT : ICON_X;
  return `<div class="mc ${cls}">${icon}</div>`;
}

/** A coherence/wiring matrix: row labels × column labels, cells aligned to columns. */
function matrix(rows: string[], cols: string[], cells: Record<string, string[]>): string {
  const head = `<div class="mh row-head"></div>${cols.map((c) => `<div class="mh">${escHtml(c)}</div>`).join("")}`;
  const body = rows
    .map((r) => {
      const rowCells = (cells[r] ?? []).map(cellMark).join("");
      return `<div class="mc row-head"><span class="nm">${escHtml(r)}</span></div>${rowCells}`;
    })
    .join("");
  return `<div class="matrix" style="grid-template-columns:minmax(64px,90px) repeat(${cols.length},minmax(26px,1fr))">${head}${body}</div>`;
}

/**
 * The badge for a card head: the live badge, or nothing when previewing. A `.preview`
 * card already carries the "PREVIEW · not wired yet" corner ribbon (CSS `::after`), so
 * emitting a second inline badge here just collides with it in the top-right.
 */
function headBadge(preview: boolean, live: string): string {
  return preview ? "" : live;
}

/** Card class with the optional preview marker. */
function cardClass(span: string, preview: boolean): string {
  return `card ${span}${preview ? " preview" : ""}`;
}

// ── Hero ────────────────────────────────────────────────────────────────────

/** The hero narrative (swapped into `.hero-narrative`); the radar is driven separately. */
export function renderHero(h: V9Hero): string {
  const worstLow = h.worstAxis.value < 70;
  const headline = worstLow
    ? `<span class="accent">Wired and healthy,</span><br><span class="muted">one gap — ${escHtml(h.worstAxis.name.toLowerCase())}.</span>`
    : '<span class="accent">Wired and healthy,</span><br><span class="muted">fully in sync.</span>';
  const sub = worstLow
    ? `Everything loads and CLIs are in sync; the score is held back by <b class="warn">${escHtml(h.worstAxis.name.toLowerCase())} (${h.worstAxis.value}/100)</b> — see the ranked actions below.`
    : "Everything loads and CLIs are in sync — no single axis is dragging the score.";
  const deltas = h.deltas
    .map((d) => `<span class="badge ${deltaBadgeClass(d)}">${escHtml(d)}</span>`)
    .join("");
  const usage = h.usageThisWeek
    ? `<div style="display:flex;align-items:baseline;gap:.55rem;margin-top:.5rem;flex-wrap:wrap"><span style="font-family:var(--display);font-size:1.7rem;font-weight:680;color:var(--fg);font-variant-numeric:tabular-nums;letter-spacing:-.02em">${thousands(h.usageThisWeek.actions)}</span><span style="font-size:.82rem;color:var(--muted)">actions this week</span><span class="badge ok">▲ +${h.usageThisWeek.wowPct}% wow</span></div><div style="font-size:.7rem;color:var(--dim);margin-top:.1rem">usage = recorded AI activity (commits + tool / skill / MCP calls) — not cost or tokens</div>`
    : "";
  const worstSvg =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--warn)"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
  return `<span class="hero-eyebrow">Harness wiring · developer console</span><h2 class="hero-headline">${headline}</h2><p class="hero-sub">${sub}</p><div class="hero-score-row"><span class="hero-score-big">${h.wiringScore}<span class="of">/100</span></span><span class="hero-score-tier">${escHtml(h.scoreLabel)}</span></div><div class="deltarow">${deltas}</div>${usage}<div class="worst">${worstSvg}<span>Weakest axis: <b>${escHtml(h.worstAxis.name)} ${h.worstAxis.value}</b> — closing it moves the score most.</span></div><p class="hero-sub" style="font-size:.74rem;color:var(--dim);margin-top:.3rem">Score = harness <b>wiring present + in sync</b>, not rule quality.</p>`;
}

// ── ◆ Developer readiness ──────────────────────────────────────────────────────

const ICON_READY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_NOT_READY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>';
const ICON_GAPS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';

/** Banner state → its status-card visual class + glyph (reuses the drift-status look). */
function readyStyle(banner: V9Ready["banner"]): { cls: "ok" | "warn" | "bad"; icon: string } {
  if (banner === "READY") return { cls: "ok", icon: ICON_READY };
  if (banner === "NOT READY") return { cls: "bad", icon: ICON_NOT_READY };
  return { cls: "warn", icon: ICON_GAPS };
}

/**
 * The developer-readiness verdict (`.grid`): a banner + score/grade card, and the
 * blocker subset. It cross-links to the action board rather than duplicating the full
 * list — the single "can I start?" gate the maturity hero + action board don't state
 * as one verdict.
 */
export function renderReady(r: V9Ready): string {
  const { cls, icon } = readyStyle(r.banner);
  const softVar = `var(--${cls}-soft)`;
  const strongVar = `var(--${cls})`;
  const sub =
    r.banner === "READY"
      ? "an agent can make a correct first change here"
      : r.banner === "NOT READY"
        ? "a blocker below stops an agent from working"
        : "an agent can work, but with gaps in the gears";
  // Banner + score/grade — the "can I start?" answer, in the loved drift-status shell.
  const badge = `<span class="badge ${cls}">${r.score}/100 · ${escHtml(r.grade)}</span>`;
  const statusBox = `<div class="drift-status" style="background:${softVar};border-color:color-mix(in oklab,${strongVar} 22%,transparent)"><div class="dicon" style="background:${strongVar}">${icon}</div><div class="dtext"><b style="color:${strongVar}">${escHtml(r.banner)}</b><span>${sub}</span></div></div>`;
  const scoreRow = `<div class="donut-meta" style="margin-top:.6rem"><div class="row"><span class="k">Readiness score</span><span class="v">${r.score}/100 (${escHtml(r.grade)})</span></div><div class="row"><span class="k">Blockers</span><span class="v" style="color:${r.blockers.length > 0 ? "var(--bad)" : "var(--ok)"}">${r.blockers.length === 0 ? "none" : `${r.blockers.length} — must fix`}</span></div></div>`;
  const verdict = `<div class="card span-5"><div class="card-head"><h3>Can I start?</h3>${badge}</div><div class="card-body">${statusBox}${scoreRow}<div class="method" style="margin-top:.6rem">Same gate as <code>aih ready</code> — machine · repo-contract · harness-wiring, over aih's read-only probes.</div></div></div>`;
  // Blocker subset — the drift-file row look; cross-link to the action board for the rest.
  let blockersBody: string;
  if (r.blockers.length === 0) {
    blockersBody = `<div class="drift-status"><div class="dicon">${ICON_READY}</div><div class="dtext"><b>No blockers</b><span>nothing stops an agent from working here</span></div></div>`;
  } else {
    const rows = r.blockers
      .map(
        (b) =>
          `<div class="drift-file"><span class="fd" style="background:var(--bad)"></span><span class="fn">${escHtml(b.title)}</span><span class="fs"><code style="${CODE_STYLE}">${escHtml(b.cmd)}</code></span><span class="ft bad">blocker</span></div>`,
      )
      .join("");
    blockersBody = `<div class="drift-files">${rows}</div><div class="method" style="margin-top:.6rem">${r.blockers.length} blocker${r.blockers.length === 1 ? "" : "s"} above; see <b>What to fix first</b> for the full ranked list.</div>`;
  }
  const blockerBadge =
    r.blockers.length > 0
      ? `<span class="badge bad">${r.blockers.length} blocker${r.blockers.length === 1 ? "" : "s"}</span>`
      : '<span class="badge ok">clear</span>';
  const blockers = `<div class="card span-7"><div class="card-head"><h3>Blockers · must fix before an agent can work</h3>${blockerBadge}</div><div class="card-body">${blockersBody}</div></div>`;
  return verdict + blockers;
}

// ── ★ Actions ────────────────────────────────────────────────────────────────

const SEV_CARD: Record<V9Action["sev"], { cls: string; icon: string }> = {
  high: {
    cls: "bad",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  },
  med: {
    cls: "warn",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
  },
  low: {
    cls: "ok",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>',
  },
};

const CODE_STYLE =
  "font-family:var(--mono);font-size:.7rem;background:var(--surface-3);border:1px solid var(--border-2);padding:.2rem .5rem;border-radius:5px;color:var(--fg-2);white-space:nowrap;overflow:auto;flex:1";

/** The ★ action board (swapped into `.anom-strip`); an honest empty state when clean. */
export function renderActions(actions: V9Action[]): string {
  if (actions.length === 0) {
    return '<div class="anom-card ok"><div class="anom-head"><div class="anom-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg></div><h4>Nothing to fix</h4><span class="sev">clear</span></div><p class="anom-body">No ranked actions — the harness is wired, in sync, and within budget. Nothing here needs your attention.</p></div>';
  }
  return actions
    .map((a) => {
      const sev = SEV_CARD[a.sev];
      return `<div class="anom-card ${sev.cls}"><div class="anom-head"><div class="anom-icon">${sev.icon}</div><h4>${escHtml(a.title)}</h4><span class="sev">${a.sev}</span></div><p class="anom-body">${escHtml(a.body)}</p><div class="anom-evidence"><code style="${CODE_STYLE}">${escHtml(a.cmd)}</code></div></div>`;
    })
    .join("");
}

// ── ✓ Wins ───────────────────────────────────────────────────────────────────

/** The ✓ remediation ledger (`.grid`); a stub when heal has never run. */
export function renderWins(w: V9Wins | undefined): string {
  if (!w || w.items.length === 0) {
    return '<div class="card span-12"><div class="card-head"><h3>Remediation ledger · what aih fixed</h3><span class="badge muted">no heal runs</span></div><div class="card-body"><div class="method">No heal history on this box yet. Run <code>aih heal --scope all</code> — it diagnoses and repairs the host runtime (TLS / npm / PATH / MCP), and this panel fills in.</div></div></div>';
  }
  const fixed = w.items.filter((i) => i.status === "fixed").length;
  const rows = w.items
    .map((i) => {
      const ft =
        i.status === "fixed"
          ? `<span class="ft ok">fixed · ${escHtml(i.when)}</span>`
          : i.status === "broken"
            ? `<span class="ft">broken · ${escHtml(i.when)}</span>`
            : '<span class="ft">n/a</span>';
      return `<div class="drift-file"><span class="fd"></span><span class="fn">${escHtml(i.name)}</span><span class="fs">${escHtml(i.detail)}</span>${ft}</div>`;
    })
    .join("");
  const spark = sparkline(w.openOverTime, "var(--ok)");
  const ledger = `<div class="card span-8"><div class="card-head"><h3>Remediation ledger · what aih fixed</h3><span class="badge ok">runtime green</span></div><div class="card-body"><div class="drift-status"><div class="dicon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg></div><div class="dtext"><b>Runtime is green — ${fixed} blocker${fixed === 1 ? "" : "s"} cleared</b><span>the environment certs / npm / PATH / MCP assume now works</span></div></div><div class="drift-files">${rows}</div><div class="method" style="margin-top:.5rem">Re-run anytime — <code>aih heal --scope all</code> diagnoses and repairs.</div></div></div>`;
  const period = `<div class="card span-4"><div class="card-head"><h3>Over the period</h3><span class="badge muted">run ledger</span></div><div class="card-body"><div style="display:flex;gap:1.2rem;flex-wrap:wrap;margin-bottom:.6rem"><div class="heatmap-stat"><b>${w.cleared}</b><span>blockers cleared</span></div><div class="heatmap-stat"><b>${w.runs}</b><span>aih runs</span></div></div><div style="font-size:.66rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;margin-bottom:.2rem">Open blockers over time</div>${spark}<div style="margin-top:.4rem;font-size:.72rem;color:var(--dim)">since first run · ${escHtml(w.since)}</div></div></div>`;
  return ledger + period;
}

// ── 01 Context ────────────────────────────────────────────────────────────────

export function renderContext(c: V9Context): string {
  const free = Math.max(0, 100 - c.perTurn.usedPct);
  const headroom = Math.max(0, c.perTurn.budget - c.perTurn.tokens);
  const dash = donutDash(c.perTurn.usedPct);
  const deltaRow =
    c.perTurn.deltaPct !== undefined
      ? `<div class="row"><span class="k">vs last run</span><span class="v" style="color:var(--${c.perTurn.deltaPct <= 0 ? "ok" : "warn"})">${c.perTurn.deltaPct > 0 ? "+" : ""}${c.perTurn.deltaPct}%</span></div>`
      : "";
  const donut = `<div class="card span-5"><div class="card-head"><h3>Per-turn budget</h3><span class="badge ok">${free}% free</span></div><div class="card-body"><div class="donut-row"><div class="donut"><svg viewBox="0 0 120 120"><circle class="ring-bg" cx="60" cy="60" r="52" fill="none" stroke-width="14"/><circle cx="60" cy="60" r="52" fill="none" stroke="url(#donutGrad)" stroke-width="14" stroke-linecap="round" stroke-dasharray="${dash} 999"/></svg><div class="center"><b>${c.perTurn.usedPct}%</b><span>used</span></div></div><div class="donut-meta"><div class="row"><span class="k">Worst CLI</span><span class="v">${escHtml(c.perTurn.worstCli)} · ${thousands(c.perTurn.tokens)}</span></div><div class="row"><span class="k">Budget</span><span class="v">${thousands(c.perTurn.budget)}</span></div>${deltaRow}<div class="headroom">${thousands(headroom)} tokens of headroom</div></div></div></div></div>`;
  const max = Math.max(1, ...c.topFiles.map(([, t]) => t));
  const bars = c.topFiles
    .map(
      ([f, t]) =>
        `<li><span class="bar-label">${escHtml(f)}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.round((t / max) * 100)}%"></span></span><span class="bar-val">${thousands(t)}<i></i></span></li>`,
    )
    .join("");
  const files = `<div class="card span-7"><div class="card-head"><h3>Top files in the corpus</h3><span class="badge muted">${c.topFiles.length} of ${c.corpus.files}</span></div><div class="card-body"><ul class="bars">${bars}</ul></div></div>`;
  return donut + files;
}

// ── 02 Activity ───────────────────────────────────────────────────────────────

/** 105 heat cells: from real levels (0–4) or the reference's procedural fallback. */
function heatGrid(cells?: number[]): string {
  const lvl = (n: number): string => (n <= 0 ? "" : `l${Math.min(4, n)}`);
  if (cells && cells.length > 0) {
    return cells.map((c) => `<span class="cell ${lvl(c)}"></span>`).join("");
  }
  // Procedural fallback mirroring the reference buildHeat (deterministic).
  let h = "";
  for (let i = 0; i < 105; i++) {
    let v = (Math.sin(i * 0.6) * 0.5 + 0.5) * 0.7 + Math.min(1, i / 60) * 0.4;
    if (i % 7 === 5 || i % 7 === 6) v *= 0.35;
    if (i > 90) v *= 1.4;
    v = Math.max(0, Math.min(1, v));
    let c = "";
    if (v > 0.15) c = "l1";
    if (v > 0.35) c = "l2";
    if (v > 0.55) c = "l3";
    if (v > 0.75) c = "l4";
    h += `<span class="cell ${c}"></span>`;
  }
  return h;
}

export function renderActivity(a: V9Activity, usagePreview: boolean): string {
  const heat = `<div class="card span-8"><div class="card-head"><h3>Commit activity · 90 days</h3><span class="badge muted">git history</span></div><div class="card-body"><div class="heatmap-wrap"><div class="heatmap"><div class="heatmap-grid" id="heatmap">${heatGrid(a.heatCells)}</div><div class="heatmap-legend"><span>less</span><div class="cells"><span class="cell"></span><span class="cell l1"></span><span class="cell l2"></span><span class="cell l3"></span><span class="cell l4"></span></div><span>more</span></div></div><div class="heatmap-side"><div class="heatmap-stat"><b>${a.commits.d7}</b><span>7 days</span></div><div class="heatmap-stat"><b>${a.commits.d30}</b><span>30 days</span></div><div class="heatmap-stat"><b>${a.commits.streak}</b><span>day streak</span></div><div class="heatmap-streak">longest · ${a.commits.longestStreak} days</div></div></div></div></div>`;
  // Scale both LOC bars against the larger of the two so neither overflows its track.
  // (A big delete used to push "removed" to several hundred percent — added was pinned 100%.)
  const locMax = Math.max(a.loc30d.added, a.loc30d.removed, 1);
  const addedPct = Math.round((a.loc30d.added / locMax) * 100);
  const removedPct = Math.round((a.loc30d.removed / locMax) * 100);
  const branchLis = a.repo.branches
    .map((b) => {
      const tag = b.tag ? `<span class="tag">${escHtml(b.tag)}</span>` : "";
      const diffs =
        b.ahead !== undefined || b.behind !== undefined
          ? `<span class="diff up">+${b.ahead ?? 0}</span><span class="diff down">−${b.behind ?? 0}</span>`
          : "";
      return `<li${b.current ? ' class="cur"' : ""}><span class="dot"></span><span class="bname">${escHtml(b.name)}${tag}</span>${diffs}<span class="age">${escHtml(b.age)}</span></li>`;
    })
    .join("");
  const hint = a.repo.dirty ? '<div class="hint">uncommitted changes</div>' : "";
  const loc = `<div class="card span-4"><div class="card-head"><h3>LOC · 30d + repo</h3><span class="badge ok">net ${a.loc30d.net >= 0 ? "+" : ""}${thousands(a.loc30d.net)}</span></div><div class="card-body"><div class="mat"><div class="mat-row"><div class="mat-bar-wrap"><span class="mat-label">added</span><span class="mat-track"><span class="mat-fill" style="width:${addedPct}%"></span></span></div><span class="mat-val">+${thousands(a.loc30d.added)}</span></div><div class="mat-row"><div class="mat-bar-wrap"><span class="mat-label">removed</span><span class="mat-track"><span class="mat-fill bad" style="width:${removedPct}%"></span></span></div><span class="mat-val">−${thousands(a.loc30d.removed)}</span></div></div><div style="margin-top:.7rem;font-size:.66rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600">Repo status</div><ul class="branches" style="margin-top:.3rem">${branchLis}</ul>${hint}</div></div>`;
  const totalActions = a.usageByCli.reduce((n, [, , , c]) => n + c, 0);
  const segs = a.usageByCli
    .map(
      ([cli, pct, color]) =>
        // Only label a segment wide enough to hold the text; tiny slices stay blank
        // (every CLI is named in the legend below), so labels never spill their slice.
        `<div class="cost-seg" style="background:${color};width:${pct}%">${pct >= 10 ? `${escHtml(cli)} ${pct}%` : ""}</div>`,
    )
    .join("");
  const legend = a.usageByCli
    .map(
      ([cli, , color, c]) =>
        `<span class="cost-leg"><span class="dot" style="background:${color}"></span>${escHtml(cli)} <b>${thousands(c)}</b></span>`,
    )
    .join("");
  const usageBadge = headBadge(
    usagePreview,
    `<span class="badge ok">${thousands(totalActions)} actions</span>`,
  );
  const usageNote = usagePreview
    ? "Per-CLI attribution needs the usage recorder + per-tool hooks. Shown as design intent until wired — not real activity."
    : "Share of recorded AI activity by CLI (commits + tool/skill/MCP calls). Needs per-tool hooks for non-commit attribution.";
  const usage = `<div class="${cardClass("span-12", usagePreview)}"><div class="card-head"><h3>Usage by CLI · this week</h3>${usageBadge}</div><div class="card-body"><div class="cost-stack"><div class="cost-stack-bar">${segs}</div><div class="cost-legend">${legend}</div></div><div style="margin-top:.5rem;font-size:.72rem;color:var(--dim)">${usageNote}</div></div></div>`;
  return heat + loc + usage;
}

// ── 03 Guardrails + ECC ───────────────────────────────────────────────────────

export function renderQuality(q: V9Quality, eccPreview: boolean): string {
  const dash = donutDash(q.testRatioPct);
  const test = `<div class="card span-4"><div class="card-head"><h3>Test coverage</h3><span class="badge warn">${q.testRatioPct}%</span></div><div class="card-body"><div class="donut-row" style="gap:.8rem"><div class="donut"><svg viewBox="0 0 120 120"><circle class="ring-bg" cx="60" cy="60" r="52" fill="none" stroke-width="14"/><circle cx="60" cy="60" r="52" fill="none" stroke="url(#donutGrad)" stroke-width="14" stroke-linecap="round" stroke-dasharray="${dash} 999"/></svg><div class="center"><b>${q.testRatioPct}%</b><span>file ratio</span></div></div><div class="donut-meta"><div class="row"><span class="k">test</span><span class="v">${q.testFiles}</span></div><div class="row"><span class="k">source</span><span class="v">${q.sourceFiles}</span></div><div class="headroom bad">not line coverage</div></div></div></div></div>`;
  const notEnforced = q.guardrails.filter(([, , s]) => s === "bad").length;
  const gBadge =
    notEnforced > 0
      ? `<span class="badge bad">${notEnforced} not enforced</span>`
      : '<span class="badge ok">enforced</span>';
  const gRows = q.guardrails
    .map(([label, val, s]) => {
      const fill = s === "ok" ? "mat-fill" : s === "warn" ? "mat-fill warn" : "mat-fill bad";
      const width = s === "ok" ? 100 : s === "warn" ? 40 : 18;
      return `<div class="mat-row"><div class="mat-bar-wrap"><span class="mat-label">${escHtml(label)}</span><span class="mat-track"><span class="${fill}" style="width:${width}%"></span></span></div><span class="mat-val">${escHtml(val)}</span></div>`;
    })
    .join("");
  const guard = `<div class="card span-4"><div class="card-head"><h3>Guardrail enforcement</h3>${gBadge}</div><div class="card-body"><div class="mat">${gRows}</div></div></div>`;
  const ecc = q.ecc;
  const m = ecc?.machine ?? { agents: 0, skills: 0, rules: 0 };
  const rp = ecc?.repo ?? { agents: 0, skills: 0, rules: 0, hooks: 0 };
  const eccBadge = headBadge(
    eccPreview,
    `<span class="badge mcp">${ecc?.version ? `ECC v${escHtml(ecc.version)}` : "this machine"}</span>`,
  );
  const packs = (ecc?.packs ?? [])
    .map((p) => `<span class="tool on">${escHtml(p)}</span>`)
    .join("");
  const dupRow =
    ecc && ecc.dup > 0
      ? `<div class="row"><span class="k">repo duplicates ECC</span><span class="v" style="color:var(--warn)">${ecc.dup} — retire</span></div>`
      : '<div class="row"><span class="k">repo duplicates ECC</span><span class="v" style="color:var(--ok)">none</span></div>';
  const subLabel =
    "font-size:.6rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600";
  const machineLabel = ecc?.version
    ? `Machine ECC · v${escHtml(ecc.version)}`
    : "Machine ECC · ~/.claude";
  const eccNote = eccPreview
    ? "ECC is a system-wide rolling install (~/.claude); this needs the machine-ECC scan. <b>Not scanned yet.</b>"
    : "ECC = your live machine install (~/.claude `ecc/` namespace), version from its manifest. Repo agents/skills are team-local overrides — not ECC.";
  const eccCard = `<div class="${cardClass("span-4", eccPreview)}"><div class="card-head"><h3>ECC · machine + repo impact</h3>${eccBadge}</div><div class="card-body"><div style="${subLabel};margin-bottom:.3rem">${machineLabel}</div><div style="display:flex;gap:.9rem;flex-wrap:wrap;margin-bottom:.6rem"><div class="heatmap-stat"><b>${m.agents}</b><span>agents</span></div><div class="heatmap-stat"><b>${m.skills}</b><span>skills</span></div><div class="heatmap-stat"><b>${m.rules}</b><span>rules</span></div></div><div style="${subLabel};margin-bottom:.3rem">Repo-local overrides (team)</div><div class="donut-meta"><div class="row"><span class="k">agents · skills · rules · hooks</span><span class="v">${rp.agents} · ${rp.skills} · ${rp.rules} · ${rp.hooks}</span></div>${dupRow}</div><div style="${subLabel};margin:.6rem 0 .3rem">ECC packs for this stack</div><div class="pills">${packs}</div><div class="method" style="margin-top:.5rem">${eccNote}</div></div></div>`;
  return test + guard + eccCard;
}

// ── 04 Drift + coherence ──────────────────────────────────────────────────────

export function renderDrift(d: V9Drift, coherencePreview: boolean): string {
  const driftedCount = d.drifted.length;
  const tracked = driftedCount + d.synced.length;
  const driftedRows = d.drifted
    .map(
      (f) =>
        `<div class="drift-file"><span class="fd" style="background:var(--warn)"></span><span class="fn">${escHtml(f.file)}</span><span class="fs">${escHtml(f.delta)}</span><span class="ft">${escHtml(f.status)}</span></div>`,
    )
    .join("");
  const syncedRows = d.synced
    .map(
      (f) =>
        `<div class="drift-file"><span class="fd"></span><span class="fn">${escHtml(f)}</span><span class="fs">·</span><span class="ft ok">synced</span></div>`,
    )
    .join("");
  const statusBox =
    driftedCount > 0
      ? `<div class="drift-status" style="background:var(--warn-soft);border-color:color-mix(in oklab,var(--warn) 22%,transparent)"><div class="dicon" style="background:var(--warn)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.5 1 6 2.5"/><path d="M21 4v8h-8"/></svg></div><div class="dtext"><b style="color:var(--warn)">${driftedCount} of ${tracked} tracked files drifted</b><span>managed block changed out of band</span></div></div>`
      : `<div class="drift-status"><div class="dicon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg></div><div class="dtext"><b>All ${tracked} tracked files in sync</b><span>every managed block matches canon</span></div></div>`;
  const driftBadge =
    driftedCount > 0
      ? `<span class="badge warn">${driftedCount} file${driftedCount === 1 ? "" : "s"}</span>`
      : '<span class="badge ok">in sync</span>';
  const driftCard = `<div class="card span-5"><div class="card-head"><h3>Drift detection</h3>${driftBadge}</div><div class="card-body">${statusBox}<div class="drift-files">${driftedRows}${syncedRows}</div></div></div>`;
  const co = d.coherence;
  let coCard: string;
  if (co) {
    const mtx = matrix(co.clis, co.dims, co.cells);
    const coBadge = headBadge(
      coherencePreview,
      `<span class="badge mcp">${co.agreementPct}% agree</span>`,
    );
    const coNote = coherencePreview
      ? "Do all CLIs load the same canon? <b>Not computed yet</b> — needs a cross-CLI diff. The drift check (left) is the real half today."
      : `${co.agreementPct}% of cells agree across CLIs. A warn cell is one CLI diverging from canon.`;
    coCard = `<div class="${cardClass("span-7", coherencePreview)}"><div class="card-head"><h3>Cross-CLI coherence</h3>${coBadge}</div><div class="card-body">${mtx}<div class="method" style="margin-top:.6rem">${coNote}</div></div></div>`;
  } else {
    coCard = `<div class="card span-7"><div class="card-head"><h3>Cross-CLI coherence</h3><span class="badge muted">n/a</span></div><div class="card-body"><div class="method">Fewer than two CLIs are targeted here, so there's no cross-CLI agreement to measure.</div></div></div>`;
  }
  return driftCard + coCard;
}

// ── 05 MCP plumbing ───────────────────────────────────────────────────────────

const EGRESS_CLASS: Record<string, string> = {
  local: "local",
  "local-only": "local",
  "third-party": "third",
  "third-party-hosted": "third",
  vendor: "vendor",
  "vendor API": "vendor",
  "vendor-incumbent": "vendor",
};

export function renderMcp(m: V9Mcp): string {
  const mtx = matrix(m.wiring.clis, m.wiring.cols, m.wiring.cells);
  const wiring = `<div class="card span-7"><div class="card-head"><h3>Per-CLI wiring · pre-flight green</h3><span class="badge mcp">${m.wiredCount}/${m.totalClis} wired</span></div><div class="card-body">${mtx}</div></div>`;
  const thirdParty = m.servers.filter(([, e]) => EGRESS_CLASS[e] === "third").length;
  const unknownCount = m.servers.filter(([, e]) => !EGRESS_CLASS[e]).length;
  const srvBadge =
    thirdParty > 0
      ? `<span class="badge warn">${thirdParty} third-party</span>`
      : unknownCount > 0
        ? `<span class="badge muted">${unknownCount} unknown</span>`
        : '<span class="badge ok">all local/vendor</span>';
  const rows = m.servers
    .map(([name, egress]) => {
      const cls = EGRESS_CLASS[egress] ?? "unknown";
      return `<div class="srv-row"><span class="n">${escHtml(name)}</span><span class="egress ${cls}"><span class="d"></span>${escHtml(egress)}</span></div>`;
    })
    .join("");
  const scopePills = m.mcpScopes
    .map(([cli, label]) => {
      const isGlobal = label.startsWith("global");
      return `<span class="tool ${isGlobal ? "off" : "on"}" title="MCP config scope">${escHtml(cli)} ${escHtml(label)}</span>`;
    })
    .join("");
  const scopeBlock = scopePills
    ? `<div style="font-size:.6rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;margin:.7rem 0 .35rem">MCP source per CLI</div><div class="pills">${scopePills}</div><div class="method" style="margin-top:.5rem">Repo <code>.mcp.json</code> is committed + team-shared; <code>global</code> (e.g. codex <code>~/.codex</code>) is machine-only — wired, but not the same portable wiring.</div>`
    : "";
  const servers = `<div class="card span-5"><div class="card-head"><h3>Servers + egress</h3>${srvBadge}</div><div class="card-body">${rows}${scopeBlock}</div></div>`;
  return wiring + servers;
}

// ── 06 Adoption ───────────────────────────────────────────────────────────────

export function renderAdoption(a: V9Adoption): string {
  const present = a.checks.filter(([, on]) => on === 1).length;
  const chips = a.checks
    .map(
      ([name, on]) =>
        `<span class="chip ${on === 1 ? "ok" : "bad"}"><i>${on === 1 ? "✓" : "✗"}</i>${escHtml(name)}</span>`,
    )
    .join("");
  const checks = `<div class="card span-6"><div class="card-head"><h3>Adoption checks</h3><span class="badge ${present === a.checks.length ? "ok" : "warn"}">${present}/${a.checks.length}</span></div><div class="card-body"><div class="chips">${chips}</div></div></div>`;
  const shellPills = [
    ...a.shellTools.present.map((t) => `<span class="tool on">${escHtml(t)}</span>`),
    ...a.shellTools.absent.map(
      (t) => `<span class="tool off" title="${escHtml(t)}">${escHtml(t)}</span>`,
    ),
  ].join("");
  const cliPills = [
    ...a.aiClis.runnable.map((c) => `<span class="tool on">${escHtml(c)}</span>`),
    ...a.aiClis.configOnly.map(
      (c) =>
        `<span class="tool off" style="border-style:dashed" title="config only">${escHtml(c)} ◐</span>`,
    ),
  ].join("");
  const toolsTotal = a.shellTools.present.length + a.shellTools.absent.length;
  const tooling = `<div class="card span-6"><div class="card-head"><h3>Shell + AI tooling</h3><span class="badge muted">${a.shellTools.present.length}/${toolsTotal} tools · ${a.aiClis.runnable.length} CLIs</span></div><div class="card-body"><div style="font-size:.66rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;margin-bottom:.35rem">Shell tools</div><div class="pills">${shellPills}</div><div style="font-size:.66rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;margin:.7rem 0 .35rem">AI CLIs runnable</div><div class="pills">${cliPills}</div></div></div>`;
  return checks + tooling;
}

// ── 07 Enterprise support ─────────────────────────────────────────────────────

export function renderSupport(s: V9Support): string {
  const f = s.findings;
  const max = Math.max(1, f.selfFix, f.improvement, f.escalation);
  const matRow = (label: string, n: number, cls: string) =>
    `<div class="mat-row"><div class="mat-bar-wrap"><span class="mat-label">${label}</span><span class="mat-track"><span class="mat-fill${cls ? ` ${cls}` : ""}" style="width:${Math.round((n / max) * 100)}%"></span></span></div><span class="mat-val">${n}</span></div>`;
  const findings = `<div class="card span-4"><div class="card-head"><h3>Findings</h3><span class="badge muted">routed by who acts</span></div><div class="card-body"><div class="mat">${matRow("self-fix (you)", f.selfFix, "")}${matRow("improvement", f.improvement, "warn")}${matRow("escalation (IT)", f.escalation, "bad")}</div></div></div>`;
  const ticketStyle =
    "margin:0;font-family:var(--mono);font-size:.72rem;line-height:1.55;color:var(--fg-2);background:var(--surface-2);border:1px solid var(--border);border-left:3px solid var(--bad);border-radius:var(--rs);padding:.8rem .95rem;white-space:pre-wrap;overflow:auto";
  const ticketBadge =
    f.escalation > 0
      ? `<span class="badge bad">${f.escalation} external blocker${f.escalation === 1 ? "" : "s"}</span>`
      : '<span class="badge ok">none to escalate</span>';
  const body =
    s.ticket.trim().length > 0
      ? `<pre style="${ticketStyle}">${escHtml(s.ticket)}</pre>`
      : '<div class="method">No external blockers — nothing to escalate to IT right now.</div>';
  const ticket = `<div class="card span-8"><div class="card-head"><h3>Escalation ticket · copy to IT</h3>${ticketBadge}</div><div class="card-body">${body}</div></div>`;
  return findings + ticket;
}

// ── 08 Over the period ────────────────────────────────────────────────────────

export function renderPeriod(p: V9Period, outcomePreview: boolean, trendsLive: boolean): string {
  const mini = (title: string, badge: string, series: number[], stroke: string) =>
    `<div class="span-6" style="grid-column:span 6"><div class="card-head" style="padding:.2rem 0;border:0"><h3>${escHtml(title)}</h3>${badge}</div>${sparkline(series, stroke)}</div>`;
  const t = p.trends;
  const first = (s: number[]) => s[0] ?? 0;
  const last = (s: number[]) => s[s.length - 1] ?? 0;
  const trendBadge = trendsLive ? "ok" : "muted";
  const trendsBody = trendsLive
    ? `<div class="grid" style="gap:.8rem">${mini("Wiring score", `<span class="badge ok">${first(t.wiring)}→${last(t.wiring)}</span>`, t.wiring, "var(--accent)")}${mini("Per-turn ctx %", `<span class="badge ok">${first(t.perTurnCtxPct)}→${last(t.perTurnCtxPct)}%</span>`, t.perTurnCtxPct, "var(--mcp)")}${mini("Drift incidents", '<span class="badge muted">stable</span>', t.driftIncidents, "var(--warn)")}${mini("Open actions", `<span class="badge ok">${first(t.openActions)}→${last(t.openActions)}</span>`, t.openActions, "var(--accent-2)")}</div>`
    : '<div class="method">Trends need at least two samples from <code>aih track</code>. Wire it (<code>aih track --apply</code>) and snapshots accrue per commit.</div>';
  const trends = `<div class="card span-7"><div class="card-head"><h3>Trends · last 8 samples</h3><span class="badge ${trendBadge}">${trendsLive ? "history" : "needs aih track"}</span></div><div class="card-body">${trendsBody}</div></div>`;
  const o = p.outcomeDeltas;
  const oBadge = headBadge(outcomePreview, '<span class="badge ok">git-derived</span>');
  const oNote = outcomePreview
    ? 'These are the honest "did productivity improve" measures (DORA-style), derivable from the git seam. <b>Not wired yet.</b>'
    : "Lead time, rework and time-to-green — derived from git history and the run ledger.";
  const oRows = o
    ? `<div class="mat-row"><div class="mat-bar-wrap"><span class="mat-label">Lead time (commit→merge)</span><span class="mat-track"><span class="mat-fill" style="width:${Math.min(100, Math.round(o.leadTimeDays * 33))}%"></span></span></div><span class="mat-val">${o.leadTimeDays} d</span></div><div class="mat-row"><div class="mat-bar-wrap"><span class="mat-label">Rework / revert rate</span><span class="mat-track"><span class="mat-fill ok" style="width:${Math.min(100, o.reworkRatePct * 5)}%"></span></span></div><span class="mat-val">${o.reworkRatePct}%</span></div><div class="mat-row"><div class="mat-bar-wrap"><span class="mat-label">Drift time-to-green (MTTR)</span><span class="mat-track"><span class="mat-fill" style="width:${Math.min(100, Math.round(o.mttr.driftHours * 12))}%"></span></span></div><span class="mat-val">${o.mttr.driftHours} h</span></div><div class="mat-row"><div class="mat-bar-wrap"><span class="mat-label">External-check MTTR</span><span class="mat-track"><span class="mat-fill warn" style="width:${Math.min(100, Math.round(o.mttr.externalCheckDays * 50))}%"></span></span></div><span class="mat-val">${o.mttr.externalCheckDays} d</span></div>`
    : "";
  const outcome = `<div class="${cardClass("span-5", outcomePreview)}"><div class="card-head"><h3>Outcome deltas</h3>${oBadge}</div><div class="card-body"><div class="mat">${oRows}</div><div class="method" style="margin-top:.6rem">${oNote}</div></div></div>`;
  return trends + outcome;
}

// ── 09 Skill ledger ───────────────────────────────────────────────────────────

export function renderSkills(s: V9Skills, preview: boolean): string {
  const max = Math.max(1, ...s.heavyLifters.map(([, c]) => c));
  const bars = s.heavyLifters
    .map(
      ([name, c]) =>
        `<li><span class="bar-label">${escHtml(name)}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.round((c / max) * 100)}%"></span></span><span class="bar-val">${c}<i> calls</i></span></li>`,
    )
    .join("");
  const heavyBadge = headBadge(
    preview,
    `<span class="badge mcp">${s.totalInvocations} calls</span>`,
  );
  const heavy = `<div class="${cardClass("span-7", preview)}"><div class="card-head"><h3>Heavy lifters · 30d</h3>${heavyBadge}</div><div class="card-body"><ul class="bars">${bars}</ul></div></div>`;
  const pills = s.dormant
    .map((d) => `<span class="tool off" title="never invoked">${escHtml(d)}</span>`)
    .join("");
  const dormBadge = headBadge(
    preview,
    `<span class="badge warn">${s.dormant.length} unused</span>`,
  );
  const reclaim = s.tokensReclaimable
    ? `Trimming the unused language packs cuts <b>~${thousands(s.tokensReclaimable)} tok</b> of always-loaded canon.`
    : "Dormant packs are trim candidates — they load into canon but never fire here.";
  const dormant = `<div class="${cardClass("span-5", preview)}"><div class="card-head"><h3>Dormant — trim candidates</h3>${dormBadge}</div><div class="card-body"><div class="pills">${pills}</div><div class="method" style="margin-top:.8rem">${reclaim}</div></div></div>`;
  return heavy + dormant;
}

// ── 10 Skill governance ───────────────────────────────────────────────────────

/** A governance row's status → its drift-row visual class + label. */
function govStatus(status: V9SkillGovernance["rows"][number]["status"]): {
  cls: "ok" | "warn" | "bad";
  label: string;
} {
  if (status === "approved") return { cls: "ok", label: "approved" };
  if (status === "stale-pin") return { cls: "warn", label: "stale pin" };
  if (status === "quarantined") return { cls: "warn", label: "quarantined" };
  return { cls: "bad", label: "unapproved" };
}

/**
 * The skill governance panel (`.grid`): a status box summarizing approved vs
 * unattested skills, and a per-skill row list (unapproved + stale-pin flagged). Every
 * interpolated field is `escHtml`-escaped — skill names/sources come from on-disk
 * trees and a committed lockfile. Pure, deterministic (no clock/IO).
 */
export function renderSkillGovernance(model: V9SkillGovernance): string {
  // Quarantined skills count as NOT clean: "all approved" must never render while a
  // disabled skill sits parked (it is installed, and it is not in a vetted-active state).
  const unattested = model.unapproved + model.stalePin + model.quarantined;
  const clean = unattested === 0;
  const statusBox = clean
    ? `<div class="drift-status"><div class="dicon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg></div><div class="dtext"><b>All ${model.approved} installed skill${model.approved === 1 ? "" : "s"} approved</b><span>every external skill on disk is vetted and in sync</span></div></div>`
    : `<div class="drift-status" style="background:var(--warn-soft);border-color:color-mix(in oklab,var(--warn) 22%,transparent)"><div class="dicon" style="background:var(--warn)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg></div><div class="dtext"><b style="color:var(--warn)">${unattested} of ${model.installed} installed skill${model.installed === 1 ? "" : "s"} not fully approved</b><span>an external skill is unapproved, stale, or quarantined</span></div></div>`;
  // escHtml stops executable injection; this additionally strips C0/C1 and bidi
  // formatting controls so a hostile lock/pack label cannot VISUALLY spoof a row
  // (RTL-override reversing "approved", zero-width padding, etc.).
  const plainLabel = (value: string): string =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  const rows = model.rows
    .map((r) => {
      const { cls, label } = govStatus(r.status);
      const dot = cls === "ok" ? "" : ` style="background:var(--${cls})"`;
      const src = r.source
        ? `${plainLabel(r.source)}${r.commit ? `@${plainLabel(r.commit).slice(0, 12)}` : ""}`
        : "not in lock";
      const ft =
        cls === "ok"
          ? '<span class="ft ok">approved</span>'
          : `<span class="ft ${cls}">${escHtml(label)}</span>`;
      return `<div class="drift-file"><span class="fd"${dot}></span><span class="fn">${escHtml(plainLabel(r.name))}</span><span class="fs">${escHtml(src)}</span>${ft}</div>`;
    })
    .join("");
  const badge = clean
    ? '<span class="badge ok">all approved</span>'
    : `<span class="badge warn">${unattested} unattested</span>`;
  // The quarantined count line renders only when non-zero, so a quarantine-free
  // report stays byte-identical to the pre-quarantine output.
  const quarantinedRow =
    model.quarantined > 0
      ? `<div class="row"><span class="k">quarantined</span><span class="v" style="color:var(--warn)">${model.quarantined}</span></div>`
      : "";
  // Per-pack rollup rows — rendered only when a lock entry carries a `pack` tag,
  // so a pack-free repo's panel stays byte-identical (the quarantined-row pattern).
  // A pack's parked members are named explicitly (` · N quarantined`, only when
  // non-zero): quarantined rows keep their pack tag (the PR #111 fix), and a rollup
  // that silently folded them into "not approved" would hide WHY the pack is short.
  const packRows = (model.packs ?? [])
    .map(
      (p) =>
        `<div class="row"><span class="k">pack ${escHtml(plainLabel(p.name))}</span><span class="v"${p.approved < p.skills ? ' style="color:var(--warn)"' : ""}>${p.approved} of ${p.skills} approved${p.quarantined !== undefined && p.quarantined > 0 ? ` · ${p.quarantined} quarantined` : ""}</span></div>`,
    )
    .join("");
  // v0.6 marketplace artifact row — same absent→empty-string idiom as the
  // quarantined row. "signature file present" is a PRESENCE claim only:
  // verification spawns cosign/gh and belongs to `aih marketplace validate`, so
  // this panel must never upgrade the label to "signed/verified".
  const mp = model.marketplace;
  const marketplaceRow = mp
    ? `<div class="row"><span class="k">marketplace artifact</span><span class="v"${mp.findings > 0 ? ' style="color:var(--warn)"' : ""}>${mp.skills} skill${mp.skills === 1 ? "" : "s"} · ${mp.findings} finding${mp.findings === 1 ? "" : "s"} · ${mp.signed ? "signature file present" : "unsigned"}</span></div>`
    : "";
  const status = `<div class="card span-5"><div class="card-head"><h3>Approval status</h3>${badge}</div><div class="card-body">${statusBox}<div class="donut-meta" style="margin-top:.6rem"><div class="row"><span class="k">installed · approved</span><span class="v">${model.installed} · ${model.approved}</span></div><div class="row"><span class="k">unapproved · stale-pin</span><span class="v" style="color:${unattested > 0 ? "var(--warn)" : "var(--ok)"}">${model.unapproved} · ${model.stalePin}</span></div>${quarantinedRow}${packRows}${marketplaceRow}</div><div class="method" style="margin-top:.6rem">External skills acquired via <code>aih workspace add</code>, joined to the committed <code>aih-skills.lock.json</code> approvals.</div></div></div>`;
  const list = `<div class="card span-7"><div class="card-head"><h3>Installed skills</h3><span class="badge muted">${model.installed} on disk</span></div><div class="card-body"><div class="drift-files">${rows}</div></div></div>`;
  return status + list;
}
