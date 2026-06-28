import { describe, expect, it } from "vitest";
import { type DigestAction, digest } from "../../src/internals/plan.js";
import { assembleViewV9, buildAihDataV9, reportHtmlV9 } from "../../src/report/v9.js";
import { V9_DEMO } from "../../src/report/v9-demo.js";

/** A scorecard digest; `guardrails` controls the worst axis (default 40 = the demo gap). */
function scorecard(guardrails = 40): DigestAction {
  return digest("Harness maturity — 82/100 (solid)", "body", {
    overall: 82,
    grade: "solid",
    dimensions: [
      { name: "layering", score: 100, checks: [] },
      { name: "sharing", score: 100, checks: [] },
      { name: "harnessWiring", score: 88, checks: [] },
      {
        name: "guardrails",
        score: guardrails,
        checks: [
          { id: "gitleaks-config", passed: true },
          { id: "pre-commit-config", passed: true },
          { id: "pre-commit-installed", passed: false },
        ],
      },
      { name: "discoverability", score: 82, checks: [] },
    ],
  });
}

function bloat(): DigestAction {
  return digest("Context footprint — ~18400 tokens", "body", {
    files: [
      { path: "ai-coding/RULE_ROUTER.md", tokens: 2140 },
      { path: "CLAUDE.md", tokens: 1810 },
      { path: "small.md", tokens: 120 },
    ],
    totalTokens: 18400,
    budgetTokens: 32000,
    overBudget: false,
  });
}

function perTurn(): DigestAction {
  return digest("Per-turn context — ~12200 tokens", "body", {
    groups: [],
    worst: { clis: ["claude"] },
    worstTokens: 12200,
    budgetTokens: 32000,
    overBudget: false,
  });
}

function daily(): DigestAction {
  return digest("Daily commits — 23 in 7d", "body", {
    commits: { d7: 23, d30: 87, total: 312 },
    daily90: [
      { date: "2026-06-26", count: 2 },
      { date: "2026-06-27", count: 3 },
      { date: "2026-06-28", count: 1 },
    ],
  });
}

function loc(): DigestAction {
  return digest("Lines of code (30d) — +4520 / −1890", "body", {
    loc: { added: 4520, removed: 1890, net: 2630 },
    windowDays: 30,
  });
}

function repo(): DigestAction {
  return digest("Repo status — on feat/x", "body", {
    isRepo: true,
    current: "feat/x",
    main: "main",
    dirty: true,
    branches: [
      { name: "main", age: "2h", ahead: 0, behind: 0 },
      { name: "feat/x", age: "5m", ahead: 14, behind: 2 },
    ],
  });
}

function quality(): DigestAction {
  return digest("Test coverage — 61%", "body", { ratio: 6.1, testFiles: 64, sourceFiles: 105 });
}

function wiring(): DigestAction {
  return digest("AI CLI wiring — 1 of 2 configured", "body", {
    rows: [
      {
        cli: "claude",
        targeted: true,
        bootloader: { state: "wired" },
        mcp: { state: "wired" },
        load: { verdict: "loads" },
      },
      {
        cli: "codex",
        targeted: true,
        bootloader: { state: "wired" },
        mcp: { state: "missing" },
        load: { verdict: "loads" },
      },
    ],
    targeted: ["claude", "codex"],
  });
}

function config(): DigestAction {
  return digest("Configuration — 2 of 3 config files present", "body", {
    present: ["context-dir", "CLAUDE.md"],
    absent: ["AGENTS.md"],
    files: {},
    total: 3,
  });
}

function tools(): DigestAction {
  return digest("Tools installed — 3/3 core", "body", {
    present: ["rg", "fd", "jq"],
    absent: ["comby"],
    core: ["rg", "fd", "jq"],
    optional: ["comby"],
    coreMissing: [],
    total: 4,
  });
}

function machine(): DigestAction {
  return digest("Machine tooling — 2 runnable", "body", {
    present: ["claude", "codex"],
    configOnly: ["kiro"],
    absent: [],
    total: 3,
  });
}

function drift(): DigestAction {
  return digest("Canon drift — 1 of 2 drifted", "body", {
    drifted: [{ file: "ai-coding/RULE_ROUTER.md", delta: "+42 tok", status: "drifted", when: "" }],
    synced: ["CLAUDE.md"],
    tracked: 2,
  });
}

function servers(): DigestAction {
  return digest("MCP servers — 2 configured, 1 third-party", "body", {
    servers: [
      ["code-review-graph", "local"],
      ["context7", "third-party"],
    ],
    thirdParty: 1,
  });
}

function support(): DigestAction {
  return digest("Support pipeline", "body", {
    findings: { selfFix: 5, improvement: 2, escalation: 1 },
    ticket: "Subject: MCP blocked\n\nAsk: add the corporate root CA.",
  });
}

function usage(): DigestAction {
  return digest("Usage — 0 events", "body", { events: 0 });
}

function ecc(): DigestAction {
  return digest("ECC harness — 11 agents, 42 skills, 9 rules, 4 hooks", "body", {
    agents: 11,
    skills: 42,
    rules: 9,
    hooks: 4,
    packs: ["typescript", "web"],
  });
}

function coherence(): DigestAction {
  return digest("Coherence — 88% across 2 CLIs", "body", {
    clis: ["claude", "codex"],
    dims: ["rules", "router", "mcp", "loads"],
    cells: { claude: ["ok", "ok", "ok", "ok"], codex: ["ok", "ok", "warn", "ok"] },
    agreementPct: 88,
  });
}

function outcome(): DigestAction {
  return digest("Outcome deltas — MTTR 3.2h drift / 1.2d external", "body", {
    leadTimeDays: 1.8,
    reworkRatePct: 6,
    mttr: { driftHours: 3.2, externalCheckDays: 1.2 },
  });
}

function wins(): DigestAction {
  return digest("Remediation — 4 cleared across 12 runs", "body", {
    items: [
      {
        name: "Certificate trust chain",
        scope: "certs",
        status: "fixed",
        detail: "CA",
        when: "3d",
      },
    ],
    cleared: 4,
    runs: 12,
    since: "Jun 1",
    openOverTime: [5, 4, 2, 0],
  });
}

const ALL = [
  scorecard(),
  bloat(),
  perTurn(),
  daily(),
  loc(),
  repo(),
  quality(),
  wiring(),
  config(),
  tools(),
  machine(),
  drift(),
  servers(),
  support(),
  usage(),
];

describe("buildAihDataV9 — hero", () => {
  it("maps the scorecard to the radar (display order) + worst axis + score", () => {
    const d = buildAihDataV9(ALL);
    expect(d.hero?.wiringScore).toBe(82);
    expect(d.hero?.radar).toEqual({
      labels: ["Layering", "Sharing", "Wiring", "Guardrails", "Discover"],
      values: [100, 100, 88, 40, 82],
    });
    expect(d.hero?.worstAxis).toEqual({ name: "Guardrails", value: 40 });
    expect(d.hero?.scoreLabel).toBe("Solid · wiring");
    expect(d.gates["sec-hero"]).toBe("live");
  });

  it("omits the hero (and gates it empty) off-canon — never faked", () => {
    const d = buildAihDataV9([config()]);
    expect(d.hero).toBeUndefined();
    expect(d.gates["sec-hero"]).toBe("empty");
  });
});

describe("buildAihDataV9 — action board", () => {
  it("derives ranked actions from real signals, each with a command", () => {
    const a = buildAihDataV9(ALL).actions ?? [];
    const titles = a.map((x) => x.title);
    expect(titles).toContain("Wire guardrails"); // guardrails 40 < 50 → high
    expect(titles).toContain("Add AGENTS.md"); // config absent → med
    expect(titles).toContain("Realign drifted canon"); // drift → med
    expect(titles).toContain("Vet context7 MCP egress"); // third-party server → low
    expect(titles).toContain("Wire usage + track hooks"); // usage 0 → low
    expect(a[0]?.sev).toBe("high"); // sorted, high first
    expect(a.find((x) => x.title === "Wire guardrails")?.cmd).toContain("aih bootstrap-ai");
  });

  it("is always gated live, with a true empty state when nothing needs fixing", () => {
    expect(buildAihDataV9([]).gates["sec-actions"]).toBe("live");
    // Fully wired + telemetry flowing → no ranked actions.
    const clean = [
      digest("Harness maturity — 100/100 (mature)", "body", {
        overall: 100,
        grade: "mature",
        dimensions: [
          { name: "layering", score: 100, checks: [] },
          { name: "sharing", score: 100, checks: [] },
          { name: "harnessWiring", score: 100, checks: [] },
          { name: "guardrails", score: 100, checks: [] },
          { name: "discoverability", score: 100, checks: [] },
        ],
      }),
      digest("Usage — active", "body", { events: 120, total: 120 }),
    ];
    expect(buildAihDataV9(clean).actions).toEqual([]);
  });
});

describe("buildAihDataV9 — panels + gating", () => {
  it("binds context (per-turn headline + top files sorted)", () => {
    const c = buildAihDataV9(ALL).context;
    expect(c?.perTurn).toMatchObject({
      worstCli: "claude",
      tokens: 12200,
      budget: 32000,
      usedPct: 38,
    });
    expect(c?.topFiles[0]).toEqual(["ai-coding/RULE_ROUTER.md", 2140]);
    expect(c?.corpus).toEqual({ tokens: 18400, files: 3 });
  });

  it("binds activity (commits + computed streak); omits with no git", () => {
    const a = buildAihDataV9(ALL).activity;
    expect(a?.commits).toMatchObject({ d7: 23, d30: 87, total: 312, streak: 3 });
    expect(a?.heatCells?.length).toBe(105);
    expect(buildAihDataV9([scorecard()]).gates["sec-activity"]).toBe("empty");
  });

  it("computes the test file ratio + guardrail enforcement from real checks", () => {
    const q = buildAihDataV9(ALL).quality;
    expect(q?.testRatioPct).toBe(61); // round(64/105*100)
    expect(q?.guardrails).toContainEqual(["pre-commit hook", "MISSING", "bad"]);
  });

  it("binds the MCP wiring matrix + wired count + servers", () => {
    const m = buildAihDataV9(ALL).mcp;
    expect(m?.wiring.cells.claude).toEqual(["ok", "ok", "ok"]);
    expect(m?.wiring.cells.codex).toEqual(["ok", "bad", "ok"]); // mcp missing → bad
    expect(m?.wiredCount).toBe(1);
    expect(m?.servers).toContainEqual(["context7", "third-party"]);
  });

  it("binds adoption, drift and support", () => {
    const d = buildAihDataV9(ALL);
    expect(d.adoption?.checks).toContainEqual(["AGENTS.md", 0]);
    expect(d.drift?.drifted).toHaveLength(1);
    expect(d.support?.findings.escalation).toBe(1);
  });

  it("gates capabilities not wired yet as preview, wins empty", () => {
    const g = buildAihDataV9(ALL).gates;
    expect(g["sec-wins"]).toBe("empty");
    expect(g["sec-skills"]).toBe("preview");
    expect(g["cap-ecc"]).toBe("preview");
    expect(g["cap-coherence"]).toBe("preview");
    expect(g["cap-outcome"]).toBe("preview");
  });
});

describe("buildAihDataV9 — Phase B capability flips", () => {
  it("flips the ECC card to live and attaches the scan to quality", () => {
    const d = buildAihDataV9([...ALL, ecc()]);
    expect(d.gates["cap-ecc"]).toBe("live");
    expect(d.quality?.ecc).toMatchObject({ agents: 11, skills: 42, packs: ["typescript", "web"] });
    // when live, the ECC card is rendered from real data WITHOUT the preview marker
    const view = assembleViewV9(d, V9_DEMO);
    expect(view.sections["sec-quality"]?.html).toContain(">11<"); // real agent count
    expect(view.sections["sec-quality"]?.html).not.toContain("span-4 preview");
  });

  it("flips the coherence matrix to live and attaches it to drift", () => {
    const d = buildAihDataV9([...ALL, coherence()]);
    expect(d.gates["cap-coherence"]).toBe("live");
    expect(d.drift?.coherence?.agreementPct).toBe(88);
    const view = assembleViewV9(d, V9_DEMO);
    expect(view.sections["sec-drift"]?.html).not.toContain("span-7 preview");
    expect(view.sections["sec-drift"]?.html).toContain("88% agree");
  });

  it("flips outcome deltas to live in the period panel", () => {
    const d = buildAihDataV9([...ALL, outcome()]);
    expect(d.gates["cap-outcome"]).toBe("live");
    expect(d.period?.outcomeDeltas?.leadTimeDays).toBe(1.8);
    const view = assembleViewV9(d, V9_DEMO);
    expect(view.sections["sec-period"]?.html).not.toContain("span-5 preview");
    expect(view.sections["sec-period"]?.html).toContain("1.8 d");
  });

  it("flips the wins ledger to live from the remediation digest", () => {
    const d = buildAihDataV9([...ALL, wins()]);
    expect(d.gates["sec-wins"]).toBe("live");
    expect(d.wins?.cleared).toBe(4);
    const view = assembleViewV9(d, V9_DEMO);
    expect(view.sections["sec-wins"]?.state).toBe("live");
    expect(view.sections["sec-wins"]?.html).toContain("Certificate trust chain");
    expect(view.sections["sec-wins"]?.html).not.toContain("run <code>aih heal</code>");
  });
});

describe("assembleViewV9 — honest rendering", () => {
  it("renders all twelve sections (so demo never bleeds through unswapped)", () => {
    const view = assembleViewV9(buildAihDataV9(ALL), V9_DEMO);
    for (const id of [
      "sec-hero",
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
    ]) {
      expect(view.sections[id]).toBeDefined();
    }
  });

  it("LIVE panels carry real values; PREVIEW cards carry the .preview marker", () => {
    const view = assembleViewV9(buildAihDataV9(ALL), V9_DEMO);
    expect(view.sections["sec-actions"]?.html).toContain("Wire guardrails");
    expect(view.sections["sec-quality"]?.html).toContain("61%");
    // capability sub-cards + skills are previewed (filled from demo, badged)
    expect(view.sections["sec-quality"]?.html).toContain("span-4 preview"); // ecc
    expect(view.sections["sec-drift"]?.html).toContain("span-7 preview"); // coherence
    expect(view.sections["sec-period"]?.html).toContain("span-5 preview"); // outcome
    expect(view.sections["sec-skills"]?.html).toContain("preview");
  });

  it("renders honest stubs (not demo) for empty panels off-canon", () => {
    const view = assembleViewV9(buildAihDataV9([config()]), V9_DEMO);
    expect(view.sections["sec-hero"]?.state).toBe("empty");
    expect(view.sections["sec-hero"]?.html).toContain("aih scaffold");
    expect(view.sections["sec-hero"]?.html).not.toContain("hero-score-big");
    expect(view.sections["sec-wins"]?.html).toContain("aih heal");
  });

  it("radar is null off-canon (the page draws nothing, never the demo radar)", () => {
    expect(assembleViewV9(buildAihDataV9([config()]), V9_DEMO).radar).toBeNull();
    expect(assembleViewV9(buildAihDataV9(ALL), V9_DEMO).radar?.values).toEqual([
      100, 100, 88, 40, 82,
    ]);
  });
});

describe("reportHtmlV9 — document", () => {
  const title = "aih report — local developer console";

  it("is a self-contained document with the real title", () => {
    const html = reportHtmlV9(title, ALL);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`<title>${title}</title>`);
  });

  it("injects AIH_DATA and drives the radar from it", () => {
    const html = reportHtmlV9(title, ALL);
    expect(html).toContain("window.AIH_DATA=");
    expect(html).toContain("AIH_DATA&&AIH_DATA.radar");
    expect(html).not.toContain('var RADAR={"labels":["Layering"'); // original const replaced
  });

  it("does not auto-refresh by default but honors --refresh", () => {
    expect(reportHtmlV9(title, ALL)).not.toContain('http-equiv="refresh"');
    expect(reportHtmlV9(title, ALL, { refresh: 5 })).toContain(
      '<meta http-equiv="refresh" content="5">',
    );
  });

  it("defaults to demo data only under --demo", () => {
    expect(reportHtmlV9(title, ALL)).toContain("<body>");
    const demo = reportHtmlV9(title, [], { demo: true });
    expect(demo).toContain('<body data-demo="on">');
    expect(demo).toContain('"values":[100,100,88,40,82]'); // demo radar
  });

  it("is byte-stable: same inputs render identically", () => {
    expect(reportHtmlV9(title, ALL)).toBe(reportHtmlV9(title, ALL));
    expect(reportHtmlV9(title, [], { demo: true })).toBe(reportHtmlV9(title, [], { demo: true }));
  });

  it("redacts secrets and the home path from the whole report", () => {
    const home = process.env.USERPROFILE || process.env.HOME || "/home/u";
    const leaky = digest("Support pipeline", "body", {
      findings: { selfFix: 0, improvement: 0, escalation: 1 },
      ticket: `Subject: leak\n\nkey sk-ant-api03-LEAKLEAKLEAKLEAK path ${home}/secret.txt`,
    });
    const html = reportHtmlV9(title, [leaky]);
    expect(html).not.toContain("sk-ant-api03-LEAKLEAKLEAKLEAK");
    expect(html).not.toContain(`${home}/secret.txt`);
  });
});
