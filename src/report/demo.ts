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

const ADOPTION_PRESENT = [
  "CLAUDE.md",
  "RULE_ROUTER.md",
  "ai-coding dir",
  "agent-behavior-core",
  ".cursor rules",
  "AGENTS.md",
  "GEMINI.md",
  ".kiro steering",
  "mcp",
  "gitleaks",
  "pre-commit",
  "sca workflow",
  "devcontainer",
  "managed-settings",
  "claudeignore",
  "githooks",
  "secrets deny",
];
const ADOPTION_ABSENT = ["copilot-instructions", "windsurf rules", "guardrails taxonomy"];

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
    digest("Configuration — 17 of 20 artifacts present", "demo", {
      present: ADOPTION_PRESENT,
      absent: ADOPTION_ABSENT,
      total: ADOPTION_PRESENT.length + ADOPTION_ABSENT.length,
    }),
    digest("Tooling — 7 of 11 AI CLIs configured here", "demo", {
      present: ["claude", "codex", "cursor", "gemini", "antigravity", "windsurf", "kiro"],
      absent: ["copilot", "opencode", "zed", "kimi"],
      total: 11,
    }),
  ];
}
