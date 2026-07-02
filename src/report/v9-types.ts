/**
 * View-model for the **local-report v9** dashboard (the "developer console" skin,
 * opt-in via `--v9`). These types describe the PURE DATA the renderer binds to —
 * every shape mirrors the demo dataset in `docs/specs/local-report-v9/DEMO-DATA.md`
 * (and {@link src/report/v9-demo.ts}). The renderer ({@link src/report/v9.ts})
 * turns this data + per-panel gates into the embedded shell; no IO or clock lives
 * here, so the same inputs render byte-identically.
 *
 * Honesty model (per panel): a panel is exactly one of
 *  - **live**    — backed by a real digest on this run → real values;
 *  - **preview** — capability not wired yet → desaturated card + "PREVIEW" badge,
 *                  filled from the demo dataset so design intent shows but never
 *                  reads as real;
 *  - **empty**   — a live panel whose data is absent here (off-canon, no git) →
 *                  an honest stub, never zero-as-if-measured.
 */

/** Per-panel honesty state. */
export type PanelState = "live" | "preview" | "empty";

/** Every v9 section id, in the order the reference design draws them. */
export const V9_SECTION_IDS = [
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
] as const;

export type V9SectionId = (typeof V9_SECTION_IDS)[number];

export interface V9Radar {
  labels: string[];
  values: number[];
}

/** Hero — wiring score + radar + deltas + the "actions this week" usage stat. */
export interface V9Hero {
  wiringScore: number;
  grade: string;
  /** e.g. "Solid · wiring" — the tier label under the score. */
  scoreLabel: string;
  radar: V9Radar;
  worstAxis: { name: string; value: number };
  /** Short badge strings, e.g. "▲ +4 vs last run", "5 open actions". */
  deltas: string[];
  /** Usage = recorded AI activity (NOT cost). Absent → the stat is omitted. */
  usageThisWeek?: { actions: number; wowPct: number };
}

/**
 * Developer-readiness verdict — the single "can I start?" gate. Sourced from the same
 * `computeReadiness` the `aih ready` command uses (via the "Developer readiness" digest),
 * so the panel never recomputes readiness differently. Cross-links to the action board
 * for the full remediation list rather than duplicating it.
 */
export interface V9Ready {
  banner: "READY" | "READY, WITH GAPS" | "NOT READY";
  score: number;
  grade: string;
  /** Failing gates (blockers) — id, title, and the exact fix command. */
  blockers: Array<{ id: string; title: string; cmd: string }>;
}

/** One ranked action on the ★ board. */
export interface V9Action {
  sev: "high" | "med" | "low";
  title: string;
  body: string;
  /** The exact `aih` command that closes it (copyable). */
  cmd: string;
}

/** One remediation row on the ✓ "what aih unblocked" board. */
export interface V9WinItem {
  name: string;
  scope: string;
  status: "fixed" | "broken" | "na";
  detail: string;
  when: string;
}

export interface V9Wins {
  items: V9WinItem[];
  cleared: number;
  runs: number;
  since: string;
  /** "open blockers over time" sparkline series (oldest → newest). */
  openOverTime: number[];
}

/** 01 — per-turn cost is the headline; full corpus is secondary. */
export interface V9Context {
  perTurn: {
    worstCli: string;
    tokens: number;
    budget: number;
    usedPct: number;
    /** % change vs last run; 0/absent when no history. */
    deltaPct?: number;
  };
  corpus: { tokens: number; files: number };
  /** Top files by token weight: [repo-relative path, tokens]. */
  topFiles: Array<[string, number]>;
}

/** 02 — git activity + per-CLI usage share. */
export interface V9Activity {
  commits: { d7: number; d30: number; total: number; streak: number; longestStreak: number };
  loc30d: { added: number; removed: number; net: number };
  repo: {
    current: string;
    main: string;
    dirty: boolean;
    branches: Array<{
      name: string;
      tag?: string;
      ahead?: number;
      behind?: number;
      age: string;
      current?: boolean;
    }>;
  };
  /** Stacked usage bar: [cli, pct, cssColor, actions]. */
  usageByCli: Array<[string, number, string, number]>;
  /** 105 heat levels (0–4), most-recent last; absent → procedural fallback. */
  heatCells?: number[];
}

/** 03 — guardrails enforcement + ECC inventory. */
export interface V9Quality {
  testRatioPct: number;
  testFiles: number;
  sourceFiles: number;
  /** [label, value, state] — e.g. ["gitleaks hook", "MISSING", "bad"]. */
  guardrails: Array<[string, string, "ok" | "bad" | "warn"]>;
  /**
   * ECC inventory. `machine` = the rolling system-wide install (~/.claude, the source of
   * truth); `repo` = team-local overrides under the repo's .claude/.kiro (NOT ECC); `dup` =
   * repo items duplicating a machine-ECC one (a fork to retire); `packs` = ECC packs that
   * apply to this repo's stack (impact). PREVIEW until the scan lands.
   */
  ecc?: {
    /** ECC repo version + commit, from the install manifest (undefined on the dir-scan path). */
    version?: string;
    commit?: string;
    /** ECC install profile, when known. */
    profile?: string;
    /** Live machine ECC counts (from the on-disk `ecc/` namespace, else a flat dir scan). */
    machine: { agents: number; skills: number; rules: number };
    repo: { agents: number; skills: number; rules: number; hooks: number };
    dup: number;
    packs: string[];
    /** ECC skill names from the live machine install, used for dormant detection. */
    skillNames?: string[];
  };
}

/** Coherence matrix — PREVIEW until the cross-CLI coherence diff lands. */
export interface V9Coherence {
  clis: string[];
  dims: string[];
  agreementPct: number;
  /** cli → per-dim cell verdicts ("ok"|"warn"|"bad"), dims-aligned. */
  cells: Record<string, string[]>;
}

/** 04 — drift (live) + coherence (preview). */
export interface V9Drift {
  drifted: Array<{ file: string; delta: string; status: string; when: string }>;
  synced: string[];
  coherence?: V9Coherence;
}

/** 05 — MCP wiring + egress. */
export interface V9Mcp {
  wiring: { clis: string[]; cols: string[]; cells: Record<string, string[]> };
  wiredCount: number;
  totalClis: number;
  /** [server name, egress class] — e.g. ["context7", "third-party"]. */
  servers: Array<[string, string]>;
  /** Per-CLI MCP source — [cli, label] e.g. ["claude","repo · 5"], ["codex","global · 16"].
   * Surfaces that a repo-committed `.mcp.json` and a machine-global `~/.codex` are NOT the same. */
  mcpScopes: Array<[string, string]>;
}

/** 06 — adoption checks + tooling. */
export interface V9Adoption {
  /** [check name, 0|1]. */
  checks: Array<[string, number]>;
  shellTools: { present: string[]; absent: string[] };
  aiClis: { runnable: string[]; configOnly: string[] };
}

/** 07 — enterprise support escalation. */
export interface V9Support {
  findings: { selfFix: number; improvement: number; escalation: number };
  /** The redacted, copyable IT ticket (subject + body). */
  ticket: string;
}

/** Outcome deltas — PREVIEW until the outcome/MTTR capability lands. */
export interface V9OutcomeDeltas {
  leadTimeDays: number;
  reworkRatePct: number;
  mttr: { driftHours: number; externalCheckDays: number };
}

/** 08 — trends (live once `aih track` hooked) + outcome deltas (preview). */
export interface V9Period {
  trends: {
    wiring: number[];
    perTurnCtxPct: number[];
    driftIncidents: number[];
    openActions: number[];
  };
  outcomeDeltas?: V9OutcomeDeltas;
}

/** 09 — skill ledger. Heavy lifters + dormant (both PREVIEW until metering + scan). */
export interface V9Skills {
  /** [skill label, calls]. */
  heavyLifters: Array<[string, number]>;
  totalInvocations: number;
  dormant: string[];
  tokensReclaimable?: number;
}

/**
 * 10 — skill governance. The read-only join over installed external skills and their
 * committed approvals (from `skillInventory`): counts + a notable-rows list, so the
 * dashboard shows what is on disk vs approved (unapproved + stale-pin highlighted).
 * LIVE whenever there is anything to govern; EMPTY only with no skills and no lock.
 */
export interface V9SkillGovernance {
  installed: number;
  approved: number;
  unapproved: number;
  stalePin: number;
  /** Skills parked under `.aih/quarantine/` — disabled, approval kept. */
  quarantined: number;
  rows: Array<{
    name: string;
    status: "approved" | "unapproved" | "stale-pin" | "quarantined";
    verdict?: string;
    source?: string;
    commit?: string;
  }>;
}

/**
 * The full v9 data view-model. Each slice is optional: present when its panel is
 * bound (live) or filled for preview; absent when the panel is empty/omitted.
 * `gates` records the honesty state of every section id.
 */
export interface AihDataV9 {
  hero?: V9Hero;
  ready?: V9Ready;
  actions?: V9Action[];
  wins?: V9Wins;
  context?: V9Context;
  activity?: V9Activity;
  quality?: V9Quality;
  drift?: V9Drift;
  mcp?: V9Mcp;
  adoption?: V9Adoption;
  support?: V9Support;
  period?: V9Period;
  skills?: V9Skills;
  skillGov?: V9SkillGovernance;
  gates: Record<string, PanelState>;
}

/** A rendered section: server-built inner HTML for its container + header text. */
export interface V9RenderedSection {
  state: PanelState;
  /** The container selector to swap inside the section (".grid", ".anom-strip", ".hero-narrative"). */
  container: string;
  /** New `.sec-title` text (omitted for the hero). */
  title?: string;
  /** New `.sec-insight` inner HTML (omitted for the hero). */
  insight?: string;
  /** New `.sec-count` chip text. */
  count?: string;
  /** The container's new inner HTML. */
  html: string;
}

/**
 * The assembled, ready-to-inject view: the radar values for the page's chart and a
 * server-rendered slice per section id. Injected verbatim as `window.AIH_DATA`.
 */
export interface V9View {
  radar: V9Radar | null;
  sections: Record<string, V9RenderedSection>;
}
