import type { AihDataV9 } from "./v9-types.js";

/**
 * The v9 demo dataset — the data behind `reference-v9.html`. `--demo` renders this
 * whole view (clearly the demo), and in LIVE mode the PREVIEW panels are filled from
 * it so design intent shows without ever reading as real. Values are realistic for
 * THIS repo (TypeScript/Node, on-canon) and deterministic (no random/clock).
 *
 * Mirrors `docs/specs/local-report-v9/DEMO-DATA.md`. Keep the two in sync.
 *
 * Gate note: capability cards not wired yet (`cap-ecc`, `cap-coherence`,
 * `cap-outcome`, `cap-usage`) and the whole skill ledger stay `preview` even here, so
 * the demo honestly shows which panels are design-only.
 */
export const V9_DEMO: AihDataV9 = {
  hero: {
    wiringScore: 82,
    grade: "Solid",
    scoreLabel: "Solid · wiring",
    radar: {
      labels: ["Layering", "Sharing", "Wiring", "Guardrails", "Discover"],
      values: [100, 100, 88, 40, 82],
    },
    worstAxis: { name: "Guardrails", value: 40 },
    deltas: ["▲ +4 vs last run", "per-turn −3%", "drift 1→1", "5 open actions"],
    usageThisWeek: { actions: 1204, wowPct: 18 },
  },

  // Coherent with the rest of the demo: the host blockers `wins` shows were all healed,
  // so an agent can start (READY, WITH GAPS) — the guardrails gap is a warn, not a gate.
  ready: {
    banner: "READY, WITH GAPS",
    score: 88,
    grade: "solid",
    blockers: [],
  },

  actions: [
    {
      sev: "high",
      title: "Wire guardrails",
      body: "Guardrails 40/100 — gitleaks config present but pre-commit hook NOT installed (present ≠ enforced).",
      cmd: "aih bootstrap-ai --scope guardrails --apply",
    },
    {
      sev: "med",
      title: "Add AGENTS.md",
      body: "Missing bootloader — codex/opencode/zed can't load canon.",
      cmd: "aih scaffold --cli codex --apply",
    },
    {
      sev: "med",
      title: "Realign drifted canon",
      body: "RULE_ROUTER.md +42 tok out of sync (2h).",
      cmd: "aih bootstrap-ai --apply",
    },
    {
      sev: "low",
      title: "Vet context7 MCP egress",
      body: "context7 is third-party egress — confirm approved.",
      cmd: "aih mcp --verify",
    },
    {
      sev: "low",
      title: "Wire usage + track hooks",
      body: "Activity/trends/time-to-green need the recorder + per-commit snapshots.",
      cmd: "aih usage --apply && aih track --apply",
    },
  ],

  wins: {
    items: [
      {
        name: "Certificate trust chain",
        scope: "certs",
        status: "fixed",
        detail: "corporate CA → trusted (registry)",
        when: "3d",
      },
      {
        name: "npm runtime",
        scope: "npm",
        status: "fixed",
        detail: "self-signed cert in chain → healed",
        when: "3d",
      },
      {
        name: "PATH resolution",
        scope: "path",
        status: "fixed",
        detail: "rg / fd / jq now resolve",
        when: "3d",
      },
      {
        name: "MCP pre-flight",
        scope: "mcp",
        status: "fixed",
        detail: "npx can launch MCP servers",
        when: "2h",
      },
    ],
    cleared: 4,
    runs: 12,
    since: "Jun 1",
    openOverTime: [5, 4, 4, 2, 1, 1, 0, 0],
  },

  context: {
    perTurn: { worstCli: "claude", tokens: 12200, budget: 32000, usedPct: 38, deltaPct: -3 },
    corpus: { tokens: 18400, files: 42 },
    topFiles: [
      ["ai-coding/RULE_ROUTER.md", 2140],
      ["CLAUDE.md", 1810],
      ["rules/agent-behavior-core.md", 1560],
      ["rules/shared-canonical-block.md", 1180],
      [".cursor/rules/00-canon.mdc", 980],
      [".kiro/steering/00-canon.md", 640],
    ],
  },

  activity: {
    commits: { d7: 23, d30: 87, total: 312, streak: 23, longestStreak: 31 },
    loc30d: { added: 4520, removed: 1890, net: 2630 },
    repo: {
      current: "feat/x",
      main: "main",
      dirty: true,
      branches: [
        { name: "main", tag: "main", age: "2h" },
        { name: "feat/x", ahead: 14, behind: 2, age: "5m", current: true },
      ],
    },
    usageByCli: [
      ["claude", 62, "var(--accent)", 747],
      ["codex", 16, "var(--accent-2)", 193],
      ["cursor", 12, "var(--mcp)", 144],
      ["kiro", 6, "var(--warn)", 72],
      ["gemini", 4, "var(--bad)", 48],
    ],
  },

  quality: {
    testRatioPct: 61,
    testFiles: 64,
    sourceFiles: 105,
    guardrails: [
      ["gitleaks config", "present", "ok"],
      ["gitleaks hook", "MISSING", "bad"],
      ["pre-commit hook", "installed", "ok"],
      ["command-policy", "active", "ok"],
    ],
    ecc: {
      version: "2.0.0",
      profile: "developer",
      machine: { agents: 67, skills: 146, rules: 124 },
      repo: { agents: 5, skills: 11, rules: 5, hooks: 3 },
      dup: 0,
      packs: ["typescript", "web"],
    },
  },

  drift: {
    drifted: [
      { file: "ai-coding/RULE_ROUTER.md", delta: "+42 tok", status: "drifted", when: "2h" },
    ],
    synced: ["CLAUDE.md", ".cursor/rules/00-canon.mdc", ".kiro/steering/00-canon.md"],
    coherence: {
      clis: ["claude", "codex", "cursor", "kiro"],
      dims: ["rules", "router", "mcp", "loads"],
      agreementPct: 94,
      cells: {
        claude: ["ok", "ok", "ok", "ok"],
        codex: ["ok", "ok", "global", "ok"],
        cursor: ["ok", "ok", "ok", "ok"],
        kiro: ["ok", "ok", "ok", "warn"],
      },
    },
  },

  mcp: {
    wiring: {
      clis: ["claude", "codex", "cursor", "kiro"],
      cols: ["bootloader", "mcp config", "loads"],
      cells: {
        claude: ["ok", "ok", "ok"],
        codex: ["ok", "warn", "ok"],
        cursor: ["ok", "ok", "ok"],
        kiro: ["ok", "ok", "warn"],
      },
    },
    wiredCount: 4,
    totalClis: 11,
    servers: [
      ["code-review-graph", "local"],
      ["context7", "third-party"],
      ["playwright", "local"],
      ["github", "vendor API"],
      ["sequential-thinking", "local"],
    ],
    mcpScopes: [
      ["claude", "repo · 5"],
      ["codex", "global · 16"],
      ["cursor", "repo · 3"],
      ["kiro", "repo · 2"],
    ],
  },

  adoption: {
    checks: [
      ["context-dir", 1],
      ["CLAUDE.md", 1],
      ["AGENTS.md", 0],
      ["cursor-rules", 1],
      ["mcp", 1],
      ["gitleaks", 1],
      ["pre-commit", 1],
      ["claude-settings", 1],
      ["devcontainer", 1],
    ],
    shellTools: { present: ["rg", "fd", "jq", "gh", "sg"], absent: ["comby", "tree"] },
    aiClis: { runnable: ["claude", "codex", "cursor"], configOnly: ["kiro"] },
  },

  support: {
    findings: { selfFix: 5, improvement: 2, escalation: 1 },
    ticket:
      "Subject: MCP pre-flight blocked on managed workstation\n\nSummary: aih's MCP servers cannot launch — `npx` fails behind the corporate TLS proxy (root CA not trusted by Node).\nImpact:  Claude / Cursor / Kiro cannot reach project MCP servers.\nAsk:     Add the corporate root CA to Node (NODE_EXTRA_CA_CERTS) or allowlist registry.npmjs.org.\nAcceptance: `aih heal --scope mcp` exits 0.",
  },

  period: {
    trends: {
      wiring: [72, 74, 73, 78, 80, 79, 81, 82],
      perTurnCtxPct: [41, 40, 39, 40, 38, 39, 38, 38],
      driftIncidents: [2, 1, 0, 1, 0, 0, 1, 1],
      openActions: [8, 7, 7, 6, 6, 5, 5, 5],
    },
    outcomeDeltas: {
      leadTimeDays: 1.8,
      reworkRatePct: 6,
      mttr: { driftHours: 3.2, externalCheckDays: 1.2 },
    },
  },

  skills: {
    heavyLifters: [
      ["tdd · ecc", 84],
      ["code-review · ecc", 61],
      ["plan · canon", 44],
      ["security-scan · ecc", 38],
      ["frontend-design · canon", 22],
      ["learn · user", 14],
    ],
    totalInvocations: 263,
    dormantAvailable: true,
    dormant: ["frontend-patterns", "nextjs-turbopack", "security-review", "e2e-testing"],
    tokensReclaimable: 2800,
  },

  // 10 — the trust join plus the v0.6 distribution/audit surfaces in their healthy
  // shapes (a pack with a parked member, a built + signature-carrying marketplace
  // artifact, a current evidence bundle, a valid org policy), so `--demo` showcases
  // every optional block the live panel can grow.
  skillGov: {
    installed: 3,
    approved: 2,
    unapproved: 0,
    stalePin: 0,
    quarantined: 1,
    rows: [
      {
        name: "changelog-writer",
        status: "approved",
        verdict: "GREEN",
        source: "acme/agent-skills",
        commit: "6a1f0c9d2b374e58a0c1b2d3e4f5061728394a5b",
      },
      {
        name: "release-notes",
        status: "approved",
        verdict: "YELLOW",
        source: "acme/agent-skills",
        commit: "6a1f0c9d2b374e58a0c1b2d3e4f5061728394a5b",
      },
      {
        name: "sql-scratchpad",
        status: "quarantined",
        verdict: "YELLOW",
        source: "acme/agent-skills",
        commit: "6a1f0c9d2b374e58a0c1b2d3e4f5061728394a5b",
      },
    ],
    packs: [
      { name: "docs-quality", skills: 2, approved: 2 },
      { name: "eng-tools", skills: 1, approved: 0, quarantined: 1 },
    ],
    marketplace: { skills: 2, findings: 0, signed: true },
    evidence: { artifacts: 14, current: true, stale: false },
    orgPolicy: { present: true, valid: true },
  },

  gates: {
    "sec-hero": "live",
    "sec-ready": "live",
    "sec-actions": "live",
    "sec-wins": "live",
    "sec-context": "live",
    "sec-activity": "live",
    "sec-quality": "live",
    "sec-drift": "live",
    "sec-mcp": "live",
    "sec-adoption": "live",
    "sec-support": "live",
    "sec-period": "live",
    "sec-skills": "preview",
    "sec-skillgov": "live",
    // capability sub-cards stay preview until their digest lands
    "cap-ecc": "preview",
    "cap-coherence": "preview",
    "cap-outcome": "preview",
    "cap-usage": "preview",
  },
};
