import { SUPPORTED_CLIS } from "../internals/clis.js";
import type { DigestAction } from "../internals/plan.js";
import { redactText } from "../support/redact.js";
import { commandForArtifact } from "./nextsteps.js";
import { V9_DEMO } from "./v9-demo.js";
import {
  escHtml,
  renderActions,
  renderActivity,
  renderAdoption,
  renderContext,
  renderDrift,
  renderHero,
  renderMcp,
  renderPeriod,
  renderQuality,
  renderReady,
  renderSkillGovernance,
  renderSkills,
  renderSupport,
  renderWins,
} from "./v9-render.js";
import { V9_TEMPLATE } from "./v9-template.js";
import type {
  AihDataV9,
  PanelState,
  V9Action,
  V9Activity,
  V9Adoption,
  V9Coherence,
  V9Context,
  V9Drift,
  V9Hero,
  V9Mcp,
  V9OutcomeDeltas,
  V9Quality,
  V9Ready,
  V9SkillGovernance,
  V9Skills,
  V9Support,
  V9View,
  V9Wins,
} from "./v9-types.js";

/**
 * The **local-report v9** renderer — an additive, opt-in (`--v9`) "developer console"
 * skin. Like {@link reportHtmlV4} it embeds a static shell ({@link V9_TEMPLATE},
 * the finalized reference design) and binds a typed view-model built from the same
 * digests `aih report` produces; the legacy renderer and `--v4` are untouched.
 *
 * Honesty model (the review council's #1 rule): every panel is LIVE (real digest),
 * PREVIEW (capability not wired → desaturated + badge, filled from the demo set), or
 * EMPTY (an honest stub) — never demo numbers as if real. Pure + deterministic: the
 * only inputs are digest `.data` bags (no clock/IO), so the report is byte-stable.
 */

/** Radar axis labels, in the order the design draws them (matches scorecard dims). */
const RADAR_LABELS = ["Layering", "Sharing", "Wiring", "Guardrails", "Discover"] as const;

/** Scorecard dimension `name` → radar axis, in display order. */
const DIM_ORDER = [
  "layering",
  "sharing",
  "harnessWiring",
  "guardrails",
  "discoverability",
] as const;

/** Friendly axis labels for the scorecard dimension names. */
const DIM_LABEL: Record<string, string> = {
  layering: "layering",
  sharing: "sharing",
  harnessWiring: "wiring",
  guardrails: "guardrails",
  discoverability: "discoverability",
};

/** The command that closes each maturity dimension's gap (action board). */
const DIM_COMMAND: Record<string, string> = {
  layering: "aih scaffold --apply",
  sharing: "aih bootstrap-ai --apply",
  harnessWiring: "aih bootstrap-ai --apply",
  guardrails: "aih bootstrap-ai --scope guardrails --apply",
  discoverability: "aih scaffold --apply",
};

export interface ReportHtmlV9Options {
  refresh?: number;
  demo?: boolean;
}

/** The `.data` bag of the first digest whose `describe` starts with `prefix`. */
function bag(digests: DigestAction[], prefix: string): Record<string, unknown> | undefined {
  const d = digests.find((x) => x.describe.startsWith(prefix));
  return d?.data && typeof d.data === "object" ? (d.data as Record<string, unknown>) : undefined;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0]?.toUpperCase() + s.slice(1) : s;
}

/** Deterministic thousands grouping (no locale) for insight copy. */
function thou(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ── hero ─────────────────────────────────────────────────────────────────────

interface ScDim {
  name?: unknown;
  score?: unknown;
}

function buildHero(
  digests: DigestAction[],
  actionCount: number,
  driftCount?: number,
): V9Hero | undefined {
  const sc = bag(digests, "Harness maturity");
  if (!sc || typeof sc.overall !== "number") return undefined;
  const dims = Array.isArray(sc.dimensions) ? (sc.dimensions as ScDim[]) : [];
  const scoreByName = new Map(
    dims.map((d) => [String(d.name ?? ""), typeof d.score === "number" ? d.score : 0]),
  );
  const values = DIM_ORDER.map((n) => scoreByName.get(n) ?? 0);
  // Worst axis = the lowest-scoring dimension, by radar label.
  let worstIdx = 0;
  values.forEach((v, i) => {
    if (v < (values[worstIdx] ?? 100)) worstIdx = i;
  });
  const grade = typeof sc.grade === "string" ? sc.grade : "";
  const deltas: string[] = [];
  if (driftCount !== undefined) deltas.push(driftCount > 0 ? `${driftCount} drifted` : "no drift");
  deltas.push(`${actionCount} open action${actionCount === 1 ? "" : "s"}`);
  return {
    wiringScore: sc.overall,
    grade: capitalize(grade),
    scoreLabel: `${capitalize(grade)} · wiring`,
    radar: { labels: [...RADAR_LABELS], values },
    worstAxis: { name: capitalize(RADAR_LABELS[worstIdx] ?? ""), value: values[worstIdx] ?? 0 },
    deltas,
    // usageThisWeek omitted in LIVE until the usage recorder + a w/w baseline exist.
  };
}

// ── ◆ developer readiness ──────────────────────────────────────────────────────

interface BlockerRaw {
  id?: unknown;
  title?: unknown;
  cmd?: unknown;
}

/**
 * The developer-readiness verdict, bound from the "Developer readiness" digest that
 * {@link readinessDigest} emits (banner + score + grade + the blocker subset). Always
 * present on the report's `--v9` local path (readiness ALWAYS renders — even a
 * harness-less repo earns a verdict), so its panel is LIVE, never faked. Undefined only
 * when the digest is absent (e.g. the org/workspace path, which does not run it).
 */
function buildReady(digests: DigestAction[]): V9Ready | undefined {
  const r = bag(digests, "Developer readiness");
  if (!r || typeof r.banner !== "string") return undefined;
  const banner =
    r.banner === "READY" || r.banner === "NOT READY" || r.banner === "READY, WITH GAPS"
      ? r.banner
      : "READY, WITH GAPS";
  const blockers = (Array.isArray(r.blockers) ? (r.blockers as BlockerRaw[]) : []).map((b) => ({
    id: String(b.id ?? ""),
    title: String(b.title ?? ""),
    cmd: String(b.cmd ?? ""),
  }));
  return {
    banner,
    score: numOr(r.score, 0),
    grade: typeof r.grade === "string" ? r.grade : "",
    blockers,
  };
}

// ── ★ actions ────────────────────────────────────────────────────────────────

function deriveActions(digests: DigestAction[]): V9Action[] {
  const out: V9Action[] = [];
  // Readiness blockers lead the board: a hard stop means an agent cannot make a
  // correct first change until it clears, so it outranks any maturity/config ding.
  // Bound from the SAME "Developer readiness" digest the readiness panel renders, so
  // the panel's "full remediation list is in What to fix first" is actually true —
  // and machine blockers (Node/npm/TLS/PATH/core tools) that no other bag surfaces
  // finally appear on the board.
  const ready = bag(digests, "Developer readiness");
  const blockers = ready && Array.isArray(ready.blockers) ? (ready.blockers as BlockerRaw[]) : [];
  for (const b of blockers) {
    const title = String(b.title ?? "");
    if (!title) continue;
    out.push({
      sev: "high",
      title: `Fix: ${title}`,
      body: "Hard readiness blocker — an agent cannot make a correct first change until this clears.",
      cmd: String(b.cmd ?? ""),
    });
  }
  const sc = bag(digests, "Harness maturity");
  if (sc) {
    const dims = Array.isArray(sc.dimensions) ? (sc.dimensions as ScDim[]) : [];
    for (const d of dims) {
      const name = String(d.name ?? "");
      const score = typeof d.score === "number" ? d.score : 100;
      if (score >= 70) continue;
      const label = DIM_LABEL[name] ?? name;
      out.push({
        sev: score < 50 ? "high" : "med",
        title: `${score < 50 ? "Wire" : "Strengthen"} ${label}`,
        body: `${capitalize(label)} wiring at ${score}/100 — present but not fully in sync/enforced.`,
        cmd: DIM_COMMAND[name] ?? "aih bootstrap-ai --apply",
      });
    }
  }
  const cfg = bag(digests, "Configuration");
  for (const name of cfg ? strs(cfg.absent) : []) {
    out.push({
      sev: "med",
      title: `Add ${name}`,
      body: `Managed artifact ${name} is missing in this repo.`,
      cmd: commandForArtifact(name),
    });
  }
  const drift = bag(digests, "Canon drift");
  const drifted =
    drift && Array.isArray(drift.drifted)
      ? (drift.drifted as Array<{ file?: unknown; delta?: unknown }>)
      : [];
  if (drifted.length > 0) {
    const f = drifted[0];
    out.push({
      sev: "med",
      title: "Realign drifted canon",
      body: `${String(f?.file ?? "a managed file")} is ${String(f?.delta ?? "")} out of sync — realign before it reaches the other CLIs.`,
      cmd: "aih bootstrap-ai --apply",
    });
  }
  const servers = bag(digests, "MCP servers");
  const rows =
    servers && Array.isArray(servers.servers) ? (servers.servers as Array<[string, string]>) : [];
  for (const [name, egress] of rows) {
    if (typeof egress === "string" && egress.includes("third")) {
      out.push({
        sev: "low",
        title: `Vet ${name} MCP egress`,
        body: `${name} is a third-party MCP server (queries leave the box) — confirm it is approved for this repo.`,
        cmd: "aih mcp --verify",
      });
    }
  }
  const usage = bag(digests, "Usage");
  const usageEvents = usage ? numOr(usage.events ?? usage.total, 0) : 0;
  const usageInstalled = usage?.installed === true;
  if (usageEvents === 0 && !usageInstalled) {
    out.push({
      sev: "low",
      title: "Wire usage + track hooks",
      body: "Activity, trends and time-to-green need the usage recorder + per-commit snapshots wired.",
      cmd: "aih usage --apply && aih track --apply",
    });
  }
  const rank = { high: 0, med: 1, low: 2 };
  return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
}

// ── 01 context ────────────────────────────────────────────────────────────────

interface BloatFile {
  path?: unknown;
  tokens?: unknown;
}

function buildContext(digests: DigestAction[]): V9Context | undefined {
  const bloat = bag(digests, "Context footprint");
  const perTurn = bag(digests, "Per-turn context");
  if (!bloat && !perTurn) return undefined;
  const files = bloat && Array.isArray(bloat.files) ? (bloat.files as BloatFile[]) : [];
  const sorted = [...files]
    .map((f) => [String(f.path ?? ""), numOr(f.tokens, 0)] as [string, number])
    .sort((a, b) => b[1] - a[1]);
  const worst =
    perTurn && typeof perTurn.worst === "object"
      ? (perTurn.worst as { clis?: unknown })
      : undefined;
  const worstCli =
    worst && Array.isArray(worst.clis) ? String((worst.clis as unknown[])[0] ?? "—") : "—";
  const tokens = perTurn ? numOr(perTurn.worstTokens, 0) : 0;
  const budget = perTurn ? numOr(perTurn.budgetTokens, 0) : 0;
  const usedPct = budget > 0 ? Math.round((tokens / budget) * 100) : 0;
  return {
    perTurn: { worstCli, tokens, budget, usedPct },
    corpus: { tokens: bloat ? numOr(bloat.totalTokens, 0) : 0, files: files.length },
    topFiles: sorted.slice(0, 6),
  };
}

// ── 02 activity ───────────────────────────────────────────────────────────────

interface DayCount {
  count?: unknown;
}

/** Per-day heat levels (0–4) for the 105-cell grid, most-recent last. */
function heatCellsFrom(series: DayCount[]): number[] {
  const counts = series.map((d) => numOr(d.count, 0));
  const max = Math.max(1, ...counts);
  const level = (c: number): number => {
    if (c <= 0) return 0;
    const r = c / max;
    return r >= 0.75 ? 4 : r >= 0.5 ? 3 : r >= 0.25 ? 2 : 1;
  };
  const levels = counts.map(level);
  if (levels.length >= 105) return levels.slice(-105);
  return [...Array(105 - levels.length).fill(0), ...levels];
}

function streaks(series: DayCount[]): { current: number; longest: number } {
  const counts = series.map((d) => numOr(d.count, 0));
  let current = 0;
  for (let i = counts.length - 1; i >= 0 && (counts[i] ?? 0) > 0; i--) current++;
  let longest = 0;
  let run = 0;
  for (const c of counts) {
    run = c > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return { current, longest };
}

interface BranchRow {
  name?: unknown;
  age?: unknown;
  ahead?: unknown;
  behind?: unknown;
}

function buildActivity(digests: DigestAction[]): V9Activity | undefined {
  const daily = bag(digests, "Daily commits");
  if (!daily) return undefined;
  const commits = (daily.commits as { d7?: unknown; d30?: unknown; total?: unknown }) ?? {};
  const series = Array.isArray(daily.daily90)
    ? (daily.daily90 as DayCount[])
    : Array.isArray(daily.daily)
      ? (daily.daily as DayCount[])
      : [];
  const { current, longest } = streaks(series);
  const locBag = bag(digests, "Lines of code");
  const loc = (locBag?.loc as { added?: unknown; removed?: unknown; net?: unknown }) ?? {};
  const repoBag = bag(digests, "Repo status");
  const current_ = typeof repoBag?.current === "string" ? repoBag.current : "—";
  const main = typeof repoBag?.main === "string" ? repoBag.main : "main";
  const rawBranches =
    repoBag && Array.isArray(repoBag.branches) ? (repoBag.branches as BranchRow[]) : [];
  const branches = rawBranches.slice(0, 6).map((b) => {
    const name = String(b.name ?? "");
    const isMain = name === main;
    return {
      name,
      ...(isMain ? { tag: "main" } : { ahead: numOr(b.ahead, 0), behind: numOr(b.behind, 0) }),
      age: String(b.age ?? ""),
      ...(name === current_ ? { current: true } : {}),
    };
  });
  return {
    commits: {
      d7: numOr(commits.d7, 0),
      d30: numOr(commits.d30, 0),
      total: numOr(commits.total, 0),
      streak: current,
      longestStreak: longest,
    },
    loc30d: { added: numOr(loc.added, 0), removed: numOr(loc.removed, 0), net: numOr(loc.net, 0) },
    repo: { current: current_, main, dirty: repoBag?.dirty === true, branches },
    // usageByCli left to the demo fill (PREVIEW) until per-tool hooks land.
    usageByCli: [],
    heatCells: heatCellsFrom(series),
  };
}

// ── 03 quality ────────────────────────────────────────────────────────────────

function buildQuality(digests: DigestAction[]): V9Quality | undefined {
  const q = bag(digests, "Test coverage");
  const sc = bag(digests, "Harness maturity");
  if (!q && !sc) return undefined;
  const testFiles = q ? numOr(q.testFiles, 0) : 0;
  const sourceFiles = q ? numOr(q.sourceFiles, 0) : 0;
  const ratioPct = sourceFiles > 0 ? Math.round((testFiles / sourceFiles) * 100) : 0;
  // Guardrail enforcement, from the scorecard's guardrails-dimension checks.
  const dims =
    sc && Array.isArray(sc.dimensions)
      ? (sc.dimensions as Array<{ name?: unknown; checks?: unknown }>)
      : [];
  const guard = dims.find((d) => d.name === "guardrails");
  const checks =
    guard && Array.isArray(guard.checks)
      ? (guard.checks as Array<{ id?: unknown; passed?: unknown }>)
      : [];
  const passed = (id: string): boolean => checks.find((c) => c.id === id)?.passed === true;
  const row = (
    label: string,
    ok: boolean,
    on: string,
    off: string,
  ): [string, string, "ok" | "bad"] => [label, ok ? on : off, ok ? "ok" : "bad"];
  const guardrails: Array<[string, string, "ok" | "bad" | "warn"]> = [
    row("gitleaks config", passed("gitleaks-config"), "present", "MISSING"),
    row("pre-commit config", passed("pre-commit-config"), "present", "MISSING"),
    row("pre-commit hook", passed("pre-commit-installed"), "installed", "MISSING"),
  ];
  return { testRatioPct: ratioPct, testFiles, sourceFiles, guardrails };
}

// ── 04 drift ──────────────────────────────────────────────────────────────────

interface DriftFile {
  file?: unknown;
  delta?: unknown;
  status?: unknown;
  when?: unknown;
}

function buildDrift(digests: DigestAction[]): V9Drift | undefined {
  const d = bag(digests, "Canon drift");
  if (!d) return undefined;
  const drifted = (Array.isArray(d.drifted) ? (d.drifted as DriftFile[]) : []).map((f) => ({
    file: String(f.file ?? ""),
    delta: String(f.delta ?? ""),
    status: String(f.status ?? "drifted"),
    when: String(f.when ?? ""),
  }));
  return { drifted, synced: strs(d.synced) };
}

// ── 05 mcp ────────────────────────────────────────────────────────────────────

interface CovRow {
  cli?: unknown;
  targeted?: unknown;
  bootloader?: { state?: unknown };
  mcp?: { state?: unknown; scope?: unknown; count?: unknown };
  load?: { verdict?: unknown };
}

/** Per-CLI MCP source label — distinguishes a repo `.mcp.json` from a machine-global config. */
function mcpScopeLabel(mcp: CovRow["mcp"]): string {
  const state = mcp?.state;
  if (state === "wired" || state === "missing") {
    const scope = mcp?.scope === "global" ? "global" : "repo";
    return `${scope} · ${numOr(mcp?.count, 0)}`;
  }
  if (state === "manual") return "manual";
  return "n/a";
}

/** Map a coverage cell state/verdict to a matrix verdict. */
function cellVerdict(state: unknown): string {
  if (state === "wired" || state === "loads") return "ok";
  if (state === "missing" || state === "wontLoad") return "bad";
  return "warn";
}

function buildMcp(digests: DigestAction[]): V9Mcp | undefined {
  const cov = bag(digests, "AI CLI wiring");
  if (!cov) return undefined;
  const rows = (Array.isArray(cov.rows) ? (cov.rows as CovRow[]) : []).filter(
    (r) => r.targeted === true,
  );
  const clis = rows.map((r) => String(r.cli ?? ""));
  const cells: Record<string, string[]> = {};
  let wiredCount = 0;
  for (const r of rows) {
    const cli = String(r.cli ?? "");
    const boot = cellVerdict(r.bootloader?.state);
    const mcp = cellVerdict(r.mcp?.state);
    const load = cellVerdict(r.load?.verdict);
    cells[cli] = [boot, mcp, load];
    if (boot === "ok" && mcp === "ok" && load === "ok") wiredCount++;
  }
  const servers = bag(digests, "MCP servers");
  const srvRows =
    servers && Array.isArray(servers.servers) ? (servers.servers as Array<[string, string]>) : [];
  const mcpScopes: Array<[string, string]> = rows.map((r) => [
    String(r.cli ?? ""),
    mcpScopeLabel(r.mcp),
  ]);
  return {
    wiring: { clis, cols: ["bootloader", "mcp config", "loads"], cells },
    wiredCount,
    totalClis: SUPPORTED_CLIS.length,
    servers: srvRows,
    mcpScopes,
  };
}

// ── 06 adoption ───────────────────────────────────────────────────────────────

function buildAdoption(digests: DigestAction[]): V9Adoption | undefined {
  const cfg = bag(digests, "Configuration");
  if (!cfg) return undefined;
  const checks: Array<[string, number]> = [
    ...strs(cfg.present).map((n) => [n, 1] as [string, number]),
    ...strs(cfg.absent).map((n) => [n, 0] as [string, number]),
  ];
  const tools = bag(digests, "Tools installed");
  const machine = bag(digests, "Machine tooling");
  return {
    checks,
    shellTools: {
      present: tools ? strs(tools.present) : [],
      absent: tools ? strs(tools.absent) : [],
    },
    aiClis: {
      runnable: machine ? strs(machine.present) : [],
      configOnly: machine ? strs(machine.configOnly) : [],
    },
  };
}

// ── 07 support ────────────────────────────────────────────────────────────────

function buildSupport(digests: DigestAction[]): V9Support | undefined {
  const s = bag(digests, "Support pipeline");
  if (!s) return undefined;
  const f =
    (s.findings as { selfFix?: unknown; improvement?: unknown; escalation?: unknown }) ?? {};
  return {
    findings: {
      selfFix: numOr(f.selfFix, 0),
      improvement: numOr(f.improvement, 0),
      escalation: numOr(f.escalation, 0),
    },
    ticket: typeof s.ticket === "string" ? s.ticket : "",
  };
}

// ── capability slices (Phase B) ───────────────────────────────────────────────

/** §1 ECC inventory (from the v9-only "ECC harness" digest), else undefined. */
function buildEcc(digests: DigestAction[]): V9Quality["ecc"] | undefined {
  const e = bag(digests, "ECC harness");
  if (!e) return undefined;
  const m = (e.machine ?? {}) as Record<string, unknown>;
  const r = (e.repo ?? {}) as Record<string, unknown>;
  return {
    machine: { agents: numOr(m.agents, 0), skills: numOr(m.skills, 0), rules: numOr(m.rules, 0) },
    repo: {
      agents: numOr(r.agents, 0),
      skills: numOr(r.skills, 0),
      rules: numOr(r.rules, 0),
      hooks: numOr(r.hooks, 0),
    },
    dup: numOr(e.dup, 0),
    packs: strs(e.packs),
    skillNames: strs(e.skillNames),
    ...(typeof e.version === "string" ? { version: e.version } : {}),
    ...(typeof e.commit === "string" ? { commit: e.commit } : {}),
    ...(typeof e.profile === "string" ? { profile: e.profile } : {}),
  };
}

interface CountRow {
  name?: unknown;
  count?: unknown;
}

function countedRows(v: unknown): Array<{ name: string; count: number }> {
  return Array.isArray(v)
    ? (v as CountRow[])
        .map((row) => ({ name: String(row.name ?? ""), count: numOr(row.count, 0) }))
        .filter((row) => row.name.length > 0 && row.count > 0)
    : [];
}

const USAGE_COLORS = [
  "var(--accent)",
  "var(--accent-2)",
  "var(--mcp)",
  "var(--warn)",
  "var(--bad)",
  "var(--fg-2)",
] as const;

interface UsageData {
  total: number;
  usageByCli: V9Activity["usageByCli"];
  skillTop: Array<{ name: string; count: number }>;
  skillSource: Map<string, string>;
  eccFired: Set<string>;
}

function buildUsage(digests: DigestAction[]): UsageData | undefined {
  const u = bag(digests, "Usage");
  const total = u ? numOr(u.total ?? u.events, 0) : 0;
  if (!u || total <= 0) return undefined;
  const tools = countedRows(u.tools);
  const toolTotal = tools.reduce((n, t) => n + t.count, 0);
  const usageByCli = tools.map((t, i): V9Activity["usageByCli"][number] => [
    t.name,
    toolTotal > 0 ? Math.round((t.count / toolTotal) * 100) : 0,
    USAGE_COLORS[i % USAGE_COLORS.length] ?? "var(--accent)",
    t.count,
  ]);
  const skills = (u.skills && typeof u.skills === "object" ? u.skills : {}) as Record<
    string,
    unknown
  >;
  const bySource =
    skills.bySource && typeof skills.bySource === "object"
      ? (skills.bySource as Record<string, unknown>)
      : {};
  const skillSource = new Map<string, string>();
  for (const source of ["ecc", "canon", "user"]) {
    for (const row of countedRows(bySource[source])) skillSource.set(row.name, source);
  }
  return {
    total,
    usageByCli,
    skillTop: countedRows(skills.top),
    skillSource,
    eccFired: new Set(countedRows(bySource.ecc).map((row) => row.name)),
  };
}

function buildSkills(
  usage: UsageData | undefined,
  ecc: V9Quality["ecc"] | undefined,
): V9Skills | undefined {
  if (!usage || usage.total <= 0) return undefined;
  const eccNames = [...(ecc?.skillNames ?? [])].sort();
  if (eccNames.length === 0) return undefined;
  const heavyLifters = usage.skillTop.map((row): [string, number] => {
    const source = usage.skillSource.get(row.name) ?? "user";
    return [`${row.name} · ${source}`, row.count];
  });
  const dormant = eccNames.filter((name) => !usage.eccFired.has(name));
  return {
    heavyLifters,
    totalInvocations: usage.skillTop.reduce((n, row) => n + row.count, 0),
    dormant,
  };
}

/** §2 cross-CLI coherence (from the v9-only "Coherence" digest), else undefined. */
function buildCoherence(digests: DigestAction[]): V9Coherence | undefined {
  const c = bag(digests, "Coherence");
  if (!c) return undefined;
  const cells = c.cells && typeof c.cells === "object" ? (c.cells as Record<string, string[]>) : {};
  return { clis: strs(c.clis), dims: strs(c.dims), agreementPct: numOr(c.agreementPct, 0), cells };
}

/** §3 outcome deltas / MTTR (from the v9-only "Outcome deltas" digest), else undefined. */
function buildOutcome(digests: DigestAction[]): V9OutcomeDeltas | undefined {
  const o = bag(digests, "Outcome deltas");
  if (!o) return undefined;
  const m = (o.mttr as { driftHours?: unknown; externalCheckDays?: unknown }) ?? {};
  return {
    leadTimeDays: numOr(o.leadTimeDays, 0),
    reworkRatePct: numOr(o.reworkRatePct, 0),
    mttr: { driftHours: numOr(m.driftHours, 0), externalCheckDays: numOr(m.externalCheckDays, 0) },
  };
}

interface WinItemRaw {
  name?: unknown;
  scope?: unknown;
  status?: unknown;
  detail?: unknown;
  when?: unknown;
}

/** §4 wins / remediation ledger (from the v9-only "Remediation" digest), else undefined. */
function buildWins(digests: DigestAction[]): V9Wins | undefined {
  const w = bag(digests, "Remediation");
  if (!w) return undefined;
  const items = (Array.isArray(w.items) ? (w.items as WinItemRaw[]) : []).map((i) => ({
    name: String(i.name ?? ""),
    scope: String(i.scope ?? ""),
    status: (i.status === "fixed" || i.status === "broken" ? i.status : "na") as
      | "fixed"
      | "broken"
      | "na",
    detail: String(i.detail ?? ""),
    when: String(i.when ?? ""),
  }));
  const openOverTime = Array.isArray(w.openOverTime)
    ? (w.openOverTime as unknown[]).filter((n): n is number => typeof n === "number")
    : [];
  return {
    items,
    cleared: numOr(w.cleared, 0),
    runs: numOr(w.runs, 0),
    since: String(w.since ?? ""),
    openOverTime,
  };
}

interface GovRowRaw {
  name?: unknown;
  status?: unknown;
  verdict?: unknown;
  source?: unknown;
  commit?: unknown;
}

interface GovPackRaw {
  name?: unknown;
  skills?: unknown;
  approved?: unknown;
  quarantined?: unknown;
}

/** Skill governance (from the v9-only "Skill governance" digest), else undefined. */
function buildSkillGovernance(digests: DigestAction[]): V9SkillGovernance | undefined {
  const g = bag(digests, "Skill governance");
  if (!g) return undefined;
  const rows = (Array.isArray(g.rows) ? (g.rows as GovRowRaw[]) : []).map((r) => ({
    name: String(r.name ?? ""),
    status: (r.status === "unapproved" || r.status === "stale-pin" || r.status === "quarantined"
      ? r.status
      : "approved") as "approved" | "unapproved" | "stale-pin" | "quarantined",
    ...(typeof r.verdict === "string" ? { verdict: r.verdict } : {}),
    ...(typeof r.source === "string" ? { source: r.source } : {}),
    ...(typeof r.commit === "string" ? { commit: r.commit } : {}),
  }));
  // Pack rollup — present only when the digest carried tags (pack-free stays absent).
  // `quarantined` rides through only when the digest emitted it (non-zero), so a
  // quarantine-free pack's view-model — and its render — stays byte-identical.
  const packs = (Array.isArray(g.packs) ? (g.packs as GovPackRaw[]) : []).map((p) => ({
    name: String(p.name ?? ""),
    skills: numOr(p.skills, 0),
    approved: numOr(p.approved, 0),
    ...(typeof p.quarantined === "number" && p.quarantined > 0
      ? { quarantined: p.quarantined }
      : {}),
  }));
  // v0.6 marketplace artifact state — rides through only when the digest carried
  // it (absent artifact → absent key → the panel renders byte-identically).
  const mp = g.marketplace as { skills?: unknown; findings?: unknown; signed?: unknown } | undefined;
  const marketplace =
    mp !== undefined && mp !== null && typeof mp === "object"
      ? { skills: numOr(mp.skills, 0), findings: numOr(mp.findings, 0), signed: mp.signed === true }
      : undefined;
  // v0.6 evidence-bundle state — same absent-stays-absent contract.
  const ev = g.evidence as { artifacts?: unknown; current?: unknown; stale?: unknown } | undefined;
  const evidence =
    ev !== undefined && ev !== null && typeof ev === "object"
      ? { artifacts: numOr(ev.artifacts, 0), current: ev.current === true, stale: ev.stale === true }
      : undefined;
  // Org-policy presence + parse state — same absent-stays-absent contract.
  const op = g.orgPolicy as { valid?: unknown; error?: unknown } | undefined;
  const orgPolicy =
    op !== undefined && op !== null && typeof op === "object"
      ? {
          present: true as const,
          valid: op.valid === true,
          ...(typeof op.error === "string" ? { error: op.error } : {}),
        }
      : undefined;
  return {
    installed: numOr(g.installed, 0),
    approved: numOr(g.approved, 0),
    unapproved: numOr(g.unapproved, 0),
    stalePin: numOr(g.stalePin, 0),
    quarantined: numOr(g.quarantined, 0),
    rows,
    ...(packs.length > 0 ? { packs } : {}),
    ...(marketplace !== undefined ? { marketplace } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
    ...(orgPolicy !== undefined ? { orgPolicy } : {}),
  };
}

// ── build ─────────────────────────────────────────────────────────────────────

/** Set every section + capability gate, defaulting to "empty". */
function emptyGates(): Record<string, PanelState> {
  const g: Record<string, PanelState> = {};
  for (const id of [
    "sec-hero",
    "sec-ready",
    "sec-actions",
    "sec-wins",
    "sec-context",
    "sec-activity",
    "sec-quality",
    "sec-drift",
    "sec-mcp",
    "sec-adoption",
    "sec-support",
    "sec-period",
    "sec-skills",
    "sec-skillgov",
    "cap-ecc",
    "cap-coherence",
    "cap-outcome",
    "cap-trends",
    "cap-usage",
  ]) {
    g[id] = "empty";
  }
  return g;
}

/**
 * Build the v9 view-model from the report's digests. Pure + deterministic — the only
 * inputs are digest `.data` bags. Each panel is gated LIVE / PREVIEW / EMPTY honestly:
 * a panel is LIVE only when its backing digest exists on this run.
 */
export function buildAihDataV9(digests: DigestAction[]): AihDataV9 {
  const gates = emptyGates();
  const actions = deriveActions(digests);
  let drift = buildDrift(digests);
  const hero = buildHero(digests, actions.length, drift?.drifted.length);
  const ready = buildReady(digests);
  const context = buildContext(digests);
  const usage = buildUsage(digests);
  const baseActivity = buildActivity(digests);
  const activity =
    baseActivity && usage ? { ...baseActivity, usageByCli: usage.usageByCli } : baseActivity;
  let quality = buildQuality(digests);
  const mcp = buildMcp(digests);
  const adoption = buildAdoption(digests);
  const support = buildSupport(digests);

  // §1/§2 capability slices — merge into their host panels when their digest exists.
  const ecc = buildEcc(digests);
  if (ecc) {
    quality = quality
      ? { ...quality, ecc }
      : { testRatioPct: 0, testFiles: 0, sourceFiles: 0, guardrails: [], ecc };
  }
  const skills = buildSkills(usage, ecc);
  const coherence = buildCoherence(digests);
  if (coherence) {
    drift = drift ? { ...drift, coherence } : { drifted: [], synced: [], coherence };
  }
  // §3/§4 — outcome deltas ride in the period panel; wins is its own section.
  const outcome = buildOutcome(digests);
  const wins = buildWins(digests);
  // Skill governance — its own section, live whenever the digest exists (there is
  // something to govern), else an honest empty stub.
  const skillGov = buildSkillGovernance(digests);
  // §2a — period trends from the recorded history (Trends digest rows). Live only once
  // ≥2 snapshots carry the v9 metrics (recorded by `aih track` since the capability landed).
  const trendRows = (() => {
    const t = bag(digests, "Trends");
    return t && Array.isArray(t.rows) ? (t.rows as Array<Record<string, unknown>>) : [];
  })();
  const haveTrends =
    trendRows.length >= 2 && trendRows.some((r) => typeof r.perTurnPct === "number");
  const emptyTrends = { wiring: [], perTurnCtxPct: [], driftIncidents: [], openActions: [] };
  const period: AihDataV9["period"] | undefined =
    outcome || haveTrends
      ? {
          trends: haveTrends
            ? {
                wiring: trendRows.map((r) => numOr(r.wiringScore, 0)),
                perTurnCtxPct: trendRows.map((r) => numOr(r.perTurnPct, 0)),
                driftIncidents: trendRows.map((r) => numOr(r.driftCount, 0)),
                openActions: trendRows.map((r) => numOr(r.openActions, 0)),
              }
            : emptyTrends,
          ...(outcome ? { outcomeDeltas: outcome } : {}),
        }
      : undefined;

  if (hero) gates["sec-hero"] = "live";
  if (ready) gates["sec-ready"] = "live"; // readiness ALWAYS renders on the local report path
  gates["sec-actions"] = "live"; // always present (honest empty state when clean)
  gates["sec-wins"] = wins ? "live" : "empty"; // §4: live from the heal/run ledger
  if (context) gates["sec-context"] = "live";
  if (activity) gates["sec-activity"] = "live";
  if (quality) gates["sec-quality"] = "live";
  if (drift) gates["sec-drift"] = "live";
  if (mcp) gates["sec-mcp"] = "live";
  if (adoption) gates["sec-adoption"] = "live";
  if (support) gates["sec-support"] = "live";
  gates["sec-period"] = "live"; // trends sub-stub + outcome preview until wired
  gates["sec-skills"] = skills ? "live" : "preview";
  gates["sec-skillgov"] = skillGov ? "live" : "empty"; // live from the inventory join
  // Capability sub-cards go live once their v9-only digest lands.
  gates["cap-ecc"] = ecc ? "live" : "preview";
  gates["cap-coherence"] = coherence ? "live" : "preview";
  gates["cap-outcome"] = outcome ? "live" : "preview"; // §3
  gates["cap-trends"] = haveTrends ? "live" : "preview"; // §2a: ≥2 history samples w/ metrics
  gates["cap-usage"] = usage ? "live" : "preview";

  return {
    ...(hero ? { hero } : {}),
    ...(ready ? { ready } : {}),
    actions,
    ...(wins ? { wins } : {}),
    ...(context ? { context } : {}),
    ...(activity ? { activity } : {}),
    ...(quality ? { quality } : {}),
    ...(drift ? { drift } : {}),
    ...(mcp ? { mcp } : {}),
    ...(adoption ? { adoption } : {}),
    ...(support ? { support } : {}),
    ...(period ? { period } : {}),
    ...(skills ? { skills } : {}),
    ...(skillGov ? { skillGov } : {}),
    gates,
  };
}

// ── assemble (data + gates → rendered, injectable view) ────────────────────────

function isLive(gates: Record<string, PanelState>, key: string): boolean {
  return gates[key] === "live";
}

/** A clean stub card for an empty live panel (honest "not available / wire X"). */
function stubGrid(title: string, msg: string): string {
  return `<div class="card span-12"><div class="card-head"><h3>${escHtml(title)}</h3><span class="badge muted">not available</span></div><div class="card-body"><div class="method">${msg}</div></div></div>`;
}

/** Honest hero when off-canon (no scorecard): no wiring score to show. */
function heroStub(): string {
  return '<span class="hero-eyebrow">Harness wiring · developer console</span><h2 class="hero-headline"><span class="muted">No harness here yet.</span></h2><p class="hero-sub">This repo has no canonical harness (<code>RULE_ROUTER.md</code> not found), so there is no wiring score to show. Run <code>aih scaffold --apply</code> to lay it down — the score, radar and drift then appear.</p>';
}

/** An empty-panel section entry (honest stub, header set so no demo text bleeds through). */
function emptySection(
  title: string,
  insight: string,
  count: string,
  stubTitle: string,
  msg: string,
): V9View["sections"][string] {
  return {
    state: "empty",
    container: ".grid",
    title,
    insight,
    count,
    html: stubGrid(stubTitle, msg),
  };
}

/**
 * Turn the data view-model + gates into the ready-to-inject {@link V9View}: a
 * server-rendered slice per section, choosing real vs demo data per (sub-)card and
 * marking still-unwired capabilities PREVIEW.
 */
export function assembleViewV9(data: AihDataV9, demo: AihDataV9): V9View {
  const g = data.gates;
  const sections: Record<string, V9View["sections"][string]> = {};

  // Hero — narrative swapped into .hero-narrative; radar via the page's RADAR const.
  if (data.hero) {
    sections["sec-hero"] = {
      state: "live",
      container: ".hero-narrative",
      html: renderHero(data.hero),
    };
  } else {
    sections["sec-hero"] = { state: "empty", container: ".hero-narrative", html: heroStub() };
  }

  // ◆ Developer readiness — the single "can I start?" gate (cross-links to ★ actions).
  if (data.ready) {
    const r = data.ready;
    const clean = r.blockers.length === 0;
    sections["sec-ready"] = {
      state: "live",
      container: ".grid",
      title: clean
        ? `${r.banner} — an agent can start here`
        : `${r.banner} — ${r.blockers.length} blocker${r.blockers.length === 1 ? "" : "s"} before an agent can work`,
      insight:
        'The single "can I start?" gate: the maturity score above rates harness <i>wiring</i>; this rates whether an agent can make a correct first change on THIS machine right now. A blocker is a hard stop — the full remediation list is in <b>What to fix first</b> below.',
      count: `${r.score}/100 · ${escHtml(r.grade)}`,
      html: renderReady(r),
    };
  } else {
    sections["sec-ready"] = emptySection(
      "Developer readiness — not measured here",
      "Readiness is computed on the local report path only.",
      "readiness",
      "Developer readiness",
      "Readiness is only measured on a local <code>aih report</code> run.",
    );
  }

  // ★ Actions
  {
    const actions = data.actions ?? [];
    const high = actions.filter((a) => a.sev === "high").length;
    const med = actions.filter((a) => a.sev === "med").length;
    const low = actions.filter((a) => a.sev === "low").length;
    sections["sec-actions"] = {
      state: "live",
      container: ".anom-strip",
      title:
        actions.length === 0
          ? "Nothing to fix — the harness is clean"
          : `What to fix first — ${actions.length} ranked action${actions.length === 1 ? "" : "s"}`,
      insight:
        "The spine of this report: every finding below, triaged by leverage, each with the exact command. When this list is empty, nothing else here needs your attention.",
      count: `${high} high · ${med} med · ${low} low`,
      html: renderActions(actions),
    };
  }

  // ✓ Wins
  {
    const wins = isLive(g, "sec-wins") ? data.wins : undefined;
    sections["sec-wins"] = {
      state: isLive(g, "sec-wins") ? "live" : "empty",
      container: ".grid",
      title: wins
        ? `aih cleared ${wins.cleared} blocker${wins.cleared === 1 ? "" : "s"} to get you running`
        : "What aih unblocked",
      insight:
        "Why aih exists: the runtime your AI tools assume — corporate TLS trust, npm, PATH, MCP launch — diagnosed and repaired, kept green over the period.",
      count: wins ? `since ${wins.since}` : "run aih heal",
      html: renderWins(wins),
    };
  }

  // 01 Context
  if (data.context) {
    const c = data.context;
    sections["sec-context"] = {
      state: "live",
      container: ".grid",
      title: `Per-turn context — ${100 - c.perTurn.usedPct}% headroom`,
      insight: `The cost that matters is what a CLI loads <b>per turn</b>: <b class="ok">${thou(c.perTurn.tokens)} of ${thou(c.perTurn.budget)} tokens</b> (${escHtml(c.perTurn.worstCli)}, the heaviest). The full corpus is larger (${thou(c.corpus.tokens)} tok / ${c.corpus.files} files) but never loaded at once.`,
      count: "context",
      html: renderContext(c),
    };
  } else {
    sections["sec-context"] = {
      state: "empty",
      container: ".grid",
      title: "Context footprint — not available",
      insight: "No context files found to measure.",
      count: "context",
      html: stubGrid("Context", "No agent-context files were found in this repo to measure."),
    };
  }

  // 02 Activity
  {
    const usagePreview = !isLive(g, "cap-usage");
    if (data.activity) {
      const a = data.activity;
      // PREVIEW usage-by-CLI: fill from demo so design intent shows, badged.
      const merged: V9Activity = {
        ...a,
        usageByCli: usagePreview ? (demo.activity?.usageByCli ?? []) : a.usageByCli,
      };
      sections["sec-activity"] = {
        state: "live",
        container: ".grid",
        title: `Activity — ${a.commits.d7} commits this week`,
        insight: `Real git activity: <b class="ok">${a.commits.d7} commits</b> in 7d, ${a.commits.d30} in 30d, net <b class="ok">${a.loc30d.net >= 0 ? "+" : ""}${thou(a.loc30d.net)} LOC</b>, on a <b>${a.commits.streak}-day</b> streak. Per-CLI usage share is below — actions, not cost.`,
        count: "actuals",
        html: renderActivity(merged, usagePreview),
      };
    } else {
      sections["sec-activity"] = {
        state: "empty",
        container: ".grid",
        title: "Activity — no git history",
        insight: "Not a git repository here, so there is no commit activity to show.",
        count: "actuals",
        html: stubGrid(
          "Activity",
          "This is not a git repository, so commit activity is unavailable.",
        ),
      };
    }
  }

  // 03 Quality + ECC
  if (data.quality) {
    const eccPreview = !isLive(g, "cap-ecc");
    const q: V9Quality = {
      ...data.quality,
      ecc: eccPreview ? demo.quality?.ecc : data.quality.ecc,
    };
    const notEnforced = q.guardrails.some(([, , s]) => s === "bad");
    sections["sec-quality"] = {
      state: "live",
      container: ".grid",
      title: notEnforced
        ? "Guardrails present — but a hook is not enforced"
        : "Guardrails present and enforced",
      insight: `ECC brings the guardrails, agents, skills and hooks; config is not enforcement. Test/source <b>file ratio ${q.testRatioPct}%</b> (file count, <i>not</i> line coverage).`,
      count: "guardrails + ECC",
      html: renderQuality(q, eccPreview),
    };
  } else {
    sections["sec-quality"] = emptySection(
      "Guardrails + ECC — not available",
      "No test-coverage or maturity data on this run.",
      "guardrails + ECC",
      "Guardrails + ECC",
      "No test/source ratio or maturity scorecard is available in this repo.",
    );
  }

  // 04 Drift + coherence
  if (data.drift) {
    const coherencePreview = !isLive(g, "cap-coherence");
    const d: V9Drift = {
      ...data.drift,
      coherence: coherencePreview ? demo.drift?.coherence : data.drift.coherence,
    };
    const n = d.drifted.length;
    sections["sec-drift"] = {
      state: "live",
      container: ".grid",
      title:
        n > 0
          ? `${n} managed file${n === 1 ? "" : "s"} drifted — realign canon`
          : "Canon is in sync — no drift",
      insight:
        "Drift is a real tamper / config-rot signal: a tracked managed block changed out of band. The longer it drifts, the more the CLIs diverge.",
      count: "integrity",
      html: renderDrift(d, coherencePreview),
    };
  } else {
    sections["sec-drift"] = emptySection(
      "Drift — not tracked here",
      "No managed bootloaders to track for drift (off-canon).",
      "integrity",
      "Drift + coherence",
      "No canonical managed blocks were found to check for drift. Run <code>aih scaffold --apply</code> first.",
    );
  }

  // 05 MCP
  if (data.mcp) {
    const m = data.mcp;
    const third = m.servers.filter(([, e]) => e.includes("third")).length;
    sections["sec-mcp"] = {
      state: "live",
      container: ".grid",
      title: `MCP wired for ${m.wiredCount} CLI${m.wiredCount === 1 ? "" : "s"}${third > 0 ? ` — ${third} server phones out` : ""}`,
      insight:
        "aih writes the MCP config per CLI and pre-flight confirms it launches. Egress is shown per server (local / vendor / third-party); runtime call volume is <b>not metered</b>, so it is not shown.",
      count: "MCP plumbing",
      html: renderMcp(m),
    };
  } else {
    sections["sec-mcp"] = emptySection(
      "MCP plumbing — not available",
      "No CLI wiring data on this run.",
      "MCP plumbing",
      "MCP plumbing",
      "No AI-CLI wiring was detected to report MCP plumbing for.",
    );
  }

  // 06 Adoption
  if (data.adoption) {
    const a = data.adoption;
    const present = a.checks.filter(([, on]) => on === 1).length;
    sections["sec-adoption"] = {
      state: "live",
      container: ".grid",
      title: `Setup — ${present} of ${a.checks.length} adoption checks pass`,
      insight: `Point-in-time gate (stays green once met): ${present}/${a.checks.length} artifacts, ${a.aiClis.runnable.length} AI CLIs runnable, ${a.shellTools.present.length}/${a.shellTools.present.length + a.shellTools.absent.length} shell tools.`,
      count: "setup",
      html: renderAdoption(a),
    };
  } else {
    sections["sec-adoption"] = emptySection(
      "Setup — not available",
      "No configuration inventory on this run.",
      "setup",
      "Setup + tooling",
      "No adoption inventory is available for this repo.",
    );
  }

  // 07 Support
  if (data.support) {
    const s: V9Support = data.support;
    sections["sec-support"] = {
      state: "live",
      container: ".grid",
      title:
        s.findings.escalation > 0
          ? `${s.findings.escalation} blocker needs IT — ticket ready`
          : "No external blockers — nothing to escalate",
      insight:
        "External failures (proxy / TLS / npm / MCP) become a tool-neutral, <b>redacted</b> escalation. Self-fixable issues stay with you; only true external blockers escalate.",
      count: "enterprise",
      html: renderSupport(s),
    };
  } else {
    sections["sec-support"] = emptySection(
      "Enterprise support — nothing to route",
      "No findings to route to self-fix / improvement / escalation.",
      "enterprise",
      "Enterprise support",
      "No support findings on this run — nothing to self-fix or escalate.",
    );
  }

  // 08 Period — trends live only with history; outcome preview until wired.
  {
    const outcomePreview = !isLive(g, "cap-outcome");
    const trendsLive = isLive(g, "cap-trends"); // §2a: live once history carries the metrics
    const period = data.period ?? demo.period;
    const p = {
      trends: period?.trends ?? {
        wiring: [],
        perTurnCtxPct: [],
        driftIncidents: [],
        openActions: [],
      },
      outcomeDeltas: outcomePreview ? demo.period?.outcomeDeltas : period?.outcomeDeltas,
    };
    sections["sec-period"] = {
      state: "live",
      container: ".grid",
      title: "How it's trending — and what to measure next",
      insight:
        "The point of running this weekly. Left: real signals over time (needs <code>aih track</code> hooked). Right: outcome deltas (lead time, rework, time-to-green) — git-derived.",
      count: "over the period",
      html: renderPeriod(p, outcomePreview, trendsLive),
    };
  }

  // 09 Skills — live from usage + ECC inventory, else preview.
  {
    const preview = !isLive(g, "sec-skills");
    const skills = preview ? demo.skills : data.skills;
    if (skills) {
      sections["sec-skills"] = {
        state: preview ? "preview" : "live",
        container: ".grid",
        title: preview ? "Heavy lifters vs dormant packs" : "Heavy lifters vs dormant ECC skills",
        insight: preview
          ? "Where skill investment pays off, and what to trim. Counts need usage hooks; dormant detection needs the ECC-inventory scan — shown as design intent until wired."
          : "Where skill investment pays off, and what to trim. Counts are local activity only; dormant means installed ECC skills that did not fire in the usage log.",
        count: "skill investment",
        html: renderSkills(skills, preview),
      };
    }
  }

  // 10 Skill governance — live from the inventory join, else an honest stub.
  if (data.skillGov && isLive(g, "sec-skillgov")) {
    const sg = data.skillGov;
    const unattested = sg.unapproved + sg.stalePin;
    sections["sec-skillgov"] = {
      state: "live",
      container: ".grid",
      title:
        unattested > 0
          ? `${unattested} installed skill${unattested === 1 ? "" : "s"} unattested — vet + approve`
          : "Every installed skill is approved",
      insight:
        "External skills acquired via <code>aih workspace add</code>, joined to the committed <code>aih-skills.lock.json</code>. Unapproved = on disk without an approval; stale-pin = approved at a commit the source has since moved past.",
      count: "skill trust",
      html: renderSkillGovernance(sg),
    };
  } else {
    sections["sec-skillgov"] = emptySection(
      "Skill governance — nothing to govern",
      "No external skills installed and no committed approvals on this run.",
      "skill trust",
      "Skill governance",
      "No external skills are installed and <code>aih-skills.lock.json</code> is absent — nothing to govern. Acquire one with <code>aih workspace add &lt;source&gt;</code>.",
    );
  }

  return { radar: data.hero?.radar ?? null, sections };
}

// ── page assembly ──────────────────────────────────────────────────────────────

/** Replace exactly one known occurrence; throw if the template drifted. */
function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const i = haystack.indexOf(needle);
  if (i === -1) throw new Error(`v9 template anchor not found: ${needle.slice(0, 60)}`);
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

/** Serialize for inline `<script>` — neutralize `<` so data can't break out. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const RADAR_ANCHOR =
  'var RADAR={"labels":["Layering","Sharing","Wiring","Guardrails","Discover"],"values":[100,100,88,40,82]};';
// Blank fallback: when no real radar (off-canon live), draw nothing — never the demo.
const RADAR_FALLBACK = '{"labels":[],"values":[]}';

/**
 * The hydration logic as a `function(doc, view)` source string, run both in the page
 * (wrapped in a `<script>`) and directly in the DOM test — one source, no drift. It
 * sets each section's header text and swaps its container's inner HTML to the
 * server-rendered slice; the radar is driven separately by the injected RADAR const.
 */
export const HYDRATE_FN = `function(doc,view){
if(!view||!view.sections)return;
Object.keys(view.sections).forEach(function(id){
var s=view.sections[id];var el=doc.getElementById(id);if(!el||!s)return;
if(s.title!=null){var t=el.querySelector(".sec-title");if(t)t.textContent=s.title;}
if(s.insight!=null){var ins=el.querySelector(".sec-insight");if(ins)ins.innerHTML=s.insight;}
if(s.count!=null){var c=el.querySelector(".sec-count");if(c)c.textContent=s.count;}
var cont=el.querySelector(s.container);if(cont)cont.innerHTML=s.html;
});
}`;

const HYDRATE_SCRIPT = `<script>(${HYDRATE_FN})(document, window.AIH_DATA||{});</script>`;

/** Bounds of the `<section>` carrying `id`, as [start, end) excluding the trailing `</section>`. */
function sectionBounds(html: string, id: string): { start: number; end: number } | undefined {
  const idIdx = html.indexOf(`id="${id}"`);
  if (idIdx === -1) return undefined;
  const start = html.lastIndexOf("<section", idIdx);
  const end = html.indexOf("</section>", idIdx);
  if (start === -1 || end === -1) return undefined;
  return { start, end };
}

/** Replace a non-nested header element's inner content within a section block. */
function replaceField(block: string, re: RegExp, value: string): string {
  return block.replace(re, (_m, open: string, close: string) => open + value + close);
}

/** Replace the inner HTML of the `<div>` carrying class `cls`, balancing nested divs. */
function replaceDivInner(block: string, cls: string, inner: string): string {
  const open = new RegExp(`<div class="[^"]*\\b${cls}\\b[^"]*">`).exec(block);
  if (!open) return block;
  const innerStart = open.index + open[0].length;
  let depth = 1;
  let i = innerStart;
  while (i < block.length && depth > 0) {
    const o = block.indexOf("<div", i);
    const c = block.indexOf("</div>", i);
    if (c === -1) return block;
    if (o !== -1 && o < c) {
      depth++;
      i = o + 4;
    } else {
      depth--;
      i = c + 6;
    }
  }
  return block.slice(0, innerStart) + inner + block.slice(i - 6);
}

/**
 * Server-render the assembled view into the embedded shell's section bodies — mirroring
 * {@link HYDRATE_FN} but at build time, so the static HTML carries REAL (or honest-stub)
 * content and never the baked demo, even with JavaScript disabled. The client-side
 * hydrate then becomes an idempotent re-apply.
 */
function applyViewToHtml(html: string, view: V9View): string {
  for (const id of Object.keys(view.sections)) {
    const s = view.sections[id];
    const b = sectionBounds(html, id);
    if (!s || !b) continue;
    let block = html.slice(b.start, b.end);
    if (s.title != null)
      block = replaceField(
        block,
        /(<h2 class="sec-title"[^>]*>)[\s\S]*?(<\/h2>)/,
        escHtml(s.title),
      );
    if (s.insight != null)
      block = replaceField(block, /(<p class="sec-insight"[^>]*>)[\s\S]*?(<\/p>)/, s.insight);
    if (s.count != null)
      block = replaceField(
        block,
        /(<span class="sec-count"[^>]*>)[\s\S]*?(<\/span>)/,
        escHtml(s.count),
      );
    block = replaceDivInner(block, s.container.replace(/^\./, ""), s.html);
    html = html.slice(0, b.start) + block + html.slice(b.end);
  }
  return html;
}

/**
 * Render the v9 dashboard. Embeds the reference shell verbatim and binds the view to
 * real digests (or the demo dataset under `--demo`); the radar values + the
 * per-section view are injected as `window.AIH_DATA`, then hydrated.
 */
export function reportHtmlV9(
  title: string,
  digests: DigestAction[],
  opts: ReportHtmlV9Options = {},
): string {
  const data = opts.demo ? V9_DEMO : buildAihDataV9(digests);
  const view = assembleViewV9(data, V9_DEMO);
  let html = V9_TEMPLATE;
  const refreshMeta =
    opts.refresh && opts.refresh > 0
      ? `<meta http-equiv="refresh" content="${Math.floor(opts.refresh)}">\n`
      : "";
  html = replaceOnce(
    html,
    "<title>aih report — developer console (v9)</title>",
    `${refreshMeta}<title>${escHtml(title)}</title>`,
  );
  if (opts.demo) html = replaceOnce(html, "<body>", '<body data-demo="on">');
  html = replaceOnce(
    html,
    RADAR_ANCHOR,
    `window.AIH_DATA=${jsonForScript(view)};\nvar RADAR=(window.AIH_DATA&&AIH_DATA.radar)?AIH_DATA.radar:${RADAR_FALLBACK};`,
  );
  // Server-render every section into the static body so the report is honest WITHOUT JS
  // (no baked-demo bleed); the injected hydrate below is then an idempotent re-apply.
  html = applyViewToHtml(html, view);
  html = replaceOnce(html, "</body>", `${HYDRATE_SCRIPT}\n</body>`);
  // Whole-report redaction (review-council ask): scrub secrets + the home path so the
  // dashboard is safe to share. Deterministic per machine (drives cross-machine
  // stability by removing the varying home prefix).
  return redactText(html, process.env);
}
