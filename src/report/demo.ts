import { type DigestAction, digest } from "../internals/plan.js";

/**
 * A fixed, realistic DEMO dataset for the dashboard — for visualizing the full
 * report and for enterprises to SHOWCASE adoption without real data. Reuses the
 * exact digest `describe` prefixes the live panels use, so the same renderers +
 * section bands apply. Deliberately watermarked "DEMO" in the UI. Numbers mirror
 * the design mockups. Fully byte-stable (constants only). Contains NO cost/$ figures
 * — local-scope cost is never real, so it is never shown (org cost lives in --org).
 */

const DAILY = [2, 3, 1, 4, 2, 3, 1, 5, 2, 3, 1, 2, 4, 1].map((count, i) => ({
  date: `2026-06-${String(12 + i).padStart(2, "0")}`,
  count,
}));

const TREND_ROWS = [
  { commits7d: 12, loc: { net: 900 }, adoptionScore: 62, branches: 3 },
  { commits7d: 15, loc: { net: 1400 }, adoptionScore: 68, branches: 4 },
  { commits7d: 11, loc: { net: 700 }, adoptionScore: 71, branches: 4 },
  { commits7d: 19, loc: { net: 2100 }, adoptionScore: 76, branches: 5 },
  { commits7d: 22, loc: { net: 1800 }, adoptionScore: 80, branches: 5 },
  { commits7d: 18, loc: { net: 2600 }, adoptionScore: 83, branches: 5 },
  { commits7d: 23, loc: { net: 2630 }, adoptionScore: 85, branches: 5 },
];

// Repo-GLOBAL config artifacts only — per-CLI bootloaders / MCP live in the
// "AI CLI wiring" matrix, so the checklist no longer double-lists them.
const ADOPTION_PRESENT = [
  "RULE_ROUTER.md",
  "ai-coding dir",
  "agent-behavior-core",
  "gitleaks",
  "pre-commit",
  "sca workflow",
  "devcontainer",
  "managed-settings",
  "claudeignore",
  "githooks",
  "secrets deny",
];
const ADOPTION_ABSENT = ["guardrails taxonomy"];

const EVENTS = [
  {
    ts: "2026-06-25 09:21",
    tool: "git",
    kind: "commit",
    detail: "main",
    added: 4520,
    removed: 1890,
  },
  { ts: "2026-06-25 09:18", tool: "claude", kind: "skill", detail: "tdd (ecc)" },
  { ts: "2026-06-25 09:05", tool: "cursor", kind: "mcp", detail: "search · context7" },
  {
    ts: "2026-06-25 08:52",
    tool: "git",
    kind: "commit",
    detail: "feat/dashboard",
    added: 312,
    removed: 40,
  },
  { ts: "2026-06-25 08:31", tool: "claude", kind: "skill", detail: "code-review (canon)" },
  { ts: "2026-06-24 17:44", tool: "codex", kind: "session", detail: "—" },
];

// Heaviest agent-context files (descending) — sums to 38,200 tokens across 12 files.
const CONTEXT_FILES = [
  { path: "ai-coding/RULE_ROUTER.md", tokens: 8200 },
  { path: "CLAUDE.md", tokens: 6100 },
  { path: "ai-coding/agent-behavior-core.md", tokens: 5400 },
  { path: "ai-coding/adapters/claude.md", tokens: 4300 },
  { path: "AGENTS.md", tokens: 3500 },
  { path: "ai-coding/repo-architecture.md", tokens: 2600 },
  { path: ".cursor/rules/00-router.mdc", tokens: 2100 },
  { path: "ai-coding/adapters/cursor.md", tokens: 1700 },
  { path: "GEMINI.md", tokens: 1400 },
  { path: ".kiro/steering/product.md", tokens: 1100 },
  { path: "ai-coding/adapters/gemini.md", tokens: 900 },
  { path: ".kiro/steering/tech.md", tokens: 900 },
];

/** The full demo digest set, in the order the live `localPanels` emits them. */
export function demoDigests(): DigestAction[] {
  return [
    digest("Daily commits — 23 in 7d · 87 in 30d · 1420 total", "demo", {
      commits: { d7: 23, d30: 87, total: 1420 },
      daily: DAILY,
    }),
    digest("Lines of code (30d) — +4520 / −1890", "demo", {
      loc: { added: 4520, removed: 1890, net: 2630 },
      windowDays: 30,
    }),
    digest("AI events — 1284 recorded", "demo", {
      rows: EVENTS,
      shown: EVENTS.length,
      total: 1284,
    }),
    digest("Test coverage — 22.5% test/source file ratio", "demo", {
      ratio: 22.5,
      testFiles: 35,
      sourceFiles: 156,
    }),
    digest("Code graph health — 342 nodes · 891 edges", "demo", {
      nodes: 342,
      edges: 891,
      files: 48,
      density: 2.6,
    }),
    digest("Guardrail rules — 4 critical · 3 important · 3 style", "demo", {
      critical: 4,
      important: 3,
      style: 3,
      total: 10,
    }),
    digest("Repository information — 156 files", "demo", {
      files: 156,
      size: "3.4 MiB",
      types: [
        { name: "ts", count: 121 },
        { name: "md", count: 14 },
        { name: "json", count: 9 },
        { name: "yml", count: 7 },
        { name: "mjs", count: 5 },
      ],
    }),
    digest("Build & analysis — 4.2s", "demo", { buildMs: 4200, files: 48 }),
    digest("Context footprint — ~38,200 tokens across 12 files", "demo", {
      totalTokens: 38200,
      budgetTokens: 40000,
      overBudget: false,
      files: CONTEXT_FILES,
    }),
    digest("Tools installed — 7 of 8 on PATH", "demo", {
      present: ["rg", "sg", "fd", "tree", "jq", "gh", "code-review-graph"],
      absent: ["comby"],
      total: 8,
    }),
    digest("Repo status — on main, 5 local branch(es), 2 ahead of main", "demo", {
      current: "feat/dashboard",
      main: "main",
      dirty: true,
      branches: [
        { name: "main", age: "2 hours ago", ahead: 0, behind: 0 },
        { name: "feat/dashboard", age: "5 minutes ago", ahead: 8, behind: 1 },
        { name: "fix/telemetry", age: "1 day ago", ahead: 3, behind: 4 },
      ],
    }),
    digest("Trends — 7 samples · adoption 85/100", "demo", {
      samples: TREND_ROWS.length,
      rows: TREND_ROWS,
    }),
    digest("AI CLI wiring — 3 of 3 configured, 2 loadable", "demo", {
      targeted: ["claude", "kiro", "codex"],
      targetSource: "marker",
      score: 100,
      structurallyConfigured: 3,
      provenLoadable: 2,
      totalTargeted: 3,
      rows: [
        {
          cli: "claude",
          label: "Claude Code",
          targeted: true,
          bootloader: {
            state: "wired",
            path: "CLAUDE.md",
            detail: "auto-loads CLAUDE.md; shared block in sync",
          },
          mcp: { state: "wired", path: ".mcp.json", detail: "2 server(s) under `mcpServers`" },
          settings: {
            state: "wired",
            path: ".claude/settings.json",
            detail: ".claude/settings.json present",
          },
          load: {
            verdict: "loads",
            checks: [
              { name: "router-chain", ok: true, detail: "router + behavior core reachable" },
            ],
          },
        },
        {
          // A wontLoad example: every cell green, but the steering file is missing
          // `inclusion: always` — present, in sync, and never auto-loaded.
          cli: "kiro",
          label: "Kiro",
          targeted: true,
          bootloader: {
            state: "wired",
            path: ".kiro/steering/00-canon.md",
            detail: "auto-loads .kiro/steering/00-canon.md; shared block in sync",
          },
          mcp: {
            state: "wired",
            path: ".kiro/settings/mcp.json",
            detail: "1 server(s) under `mcpServers`",
          },
          settings: { state: "na", detail: "Kiro has no aih-managed settings file" },
          load: {
            verdict: "wontLoad",
            checks: [
              {
                name: "activation",
                ok: false,
                detail:
                  "inclusion: always missing in .kiro/steering/00-canon.md — present but not auto-loaded",
              },
            ],
            fix: "aih bootstrap-ai --apply --cli kiro",
          },
        },
        {
          cli: "codex",
          label: "Codex CLI",
          targeted: true,
          bootloader: {
            state: "wired",
            path: "AGENTS.md",
            detail: "auto-loads AGENTS.md; shared block in sync",
          },
          mcp: {
            state: "manual",
            path: "~/.codex/config.toml",
            detail:
              "manual — global ~/.codex/config.toml (toml; aih emits guidance, does not own this shape)",
            fix: "aih mcp --cli codex",
          },
          settings: { state: "na", detail: "Codex CLI has no aih-managed settings file" },
          load: {
            verdict: "loads",
            checks: [
              { name: "router-chain", ok: true, detail: "router + behavior core reachable" },
            ],
          },
        },
        {
          cli: "cursor",
          label: "Cursor",
          targeted: false,
          bootloader: {
            state: "missing",
            path: ".cursor/rules/00-canon.mdc",
            detail: "not found",
            fix: "aih bootstrap-ai --apply --cli cursor",
          },
          mcp: {
            state: "missing",
            path: ".cursor/mcp.json",
            detail: ".cursor/mcp.json not found",
            fix: "aih mcp --apply --cli cursor",
          },
          settings: { state: "na", detail: "Cursor has no aih-managed settings file" },
          load: {
            verdict: "unverified",
            checks: [
              {
                name: "activation",
                ok: undefined,
                detail: "no bootloader on disk — nothing to load",
              },
            ],
          },
        },
      ],
    }),
    digest("Configuration — 11 of 12 artifacts present", "demo", {
      present: ADOPTION_PRESENT,
      absent: ADOPTION_ABSENT,
      total: ADOPTION_PRESENT.length + ADOPTION_ABSENT.length,
    }),
    digest("Machine tooling — 6 runnable · 1 config-only of 11 AI CLIs", "demo", {
      present: ["claude", "codex", "cursor", "gemini", "antigravity", "kiro"],
      configOnly: ["windsurf"],
      absent: ["copilot", "opencode", "zed", "kimi"],
      total: 11,
    }),
  ];
}
