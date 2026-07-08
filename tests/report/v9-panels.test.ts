import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedBlock } from "../../src/bootstrap-ai/canon.js";
import { sha256Hex } from "../../src/bundle/index.js";
import { mergeManagedBlock } from "../../src/internals/markers.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { jsonFile } from "../../src/internals/render.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  coherenceDigest,
  driftDigest,
  eccInventoryDigest,
  mcpServersDigest,
  outcomeDeltasDigest,
  skillGovernanceDigest,
  supportDigest,
  winsDigest,
} from "../../src/report/v9-panels.js";
import { escHtml, renderSkillGovernance, renderWins } from "../../src/report/v9-render.js";
import type { SupportTemplate } from "../../src/support/render.js";

describe("escHtml — attribute-safe HTML escaping", () => {
  it("escapes all five significant characters incl. quotes (attribute-safe)", () => {
    expect(escHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it('escapes & first, so a value in a title="…" attribute can\'t break out', () => {
    // `js/incomplete-html-attribute-sanitization`: the quote must become an entity.
    expect(escHtml('a" onmouseover="x')).toBe("a&quot; onmouseover=&quot;x");
    expect(escHtml("x&y")).toBe("x&amp;y"); // & escaped once, not double-escaped
  });
});

const DIR = "ai-coding";

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-v9panels-"));
  home = mkdtempSync(join(tmpdir(), "aih-v9panels-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  const env = { HOME: home, USERPROFILE: home, ...(over.env ?? {}) };
  return {
    root: dir,
    contextDir: DIR,
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env }),
    env,
    options: {},
    ...over,
  };
}

function put(rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

/** Write under the temp HOME (the machine `~/.claude` install), not the repo root. */
function putHome(rel: string, body: string): void {
  const abs = join(home, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

interface DriftData {
  drifted: Array<{ file: string; delta: string }>;
  synced: string[];
  tracked: number;
}

describe("driftDigest", () => {
  it("returns undefined off-canon (no RULE_ROUTER.md)", () => {
    expect(driftDigest(ctx())).toBeUndefined();
  });

  it("reports an in-sync bootloader as synced", () => {
    put(`${DIR}/RULE_ROUTER.md`, "routing\n");
    put("CLAUDE.md", mergeManagedBlock(undefined, sharedBlock(DIR), "# Repo"));
    const d = driftDigest(ctx());
    expect(d).toBeDefined();
    const data = d?.data as DriftData;
    expect(data.synced).toContain("CLAUDE.md");
    expect(data.drifted).toHaveLength(0);
  });

  it("detects a drifted managed block (different body)", () => {
    put(`${DIR}/RULE_ROUTER.md`, "routing\n");
    put(
      "CLAUDE.md",
      mergeManagedBlock(undefined, { ...sharedBlock(DIR), body: "drifted body\n" }, "# Repo"),
    );
    const d = driftDigest(ctx());
    const data = d?.data as DriftData;
    expect(data.drifted).toHaveLength(1);
    expect(data.drifted[0]?.file).toBe("CLAUDE.md");
    expect(data.tracked).toBe(1);
  });
});

interface ServerData {
  servers: Array<[string, string]>;
  thirdParty?: number;
  catalogError?: string;
  policyDisabled?: string[];
}

describe("mcpServersDigest", () => {
  it("returns undefined when there is no .mcp.json", () => {
    expect(mcpServersDigest(ctx())).toBeUndefined();
  });

  it("maps configured servers to the catalog's egress class", () => {
    put(
      ".mcp.json",
      JSON.stringify({
        mcpServers: { "code-review-graph": { command: "uvx" }, "totally-unknown-xyz": {} },
      }),
    );
    const d = mcpServersDigest(ctx());
    const data = d?.data as ServerData;
    expect(data.servers).toContainEqual(["code-review-graph", "local"]);
    expect(data.servers).toContainEqual(["totally-unknown-xyz", "unknown"]);
  });

  it("flags third-party egress", () => {
    put(".mcp.json", JSON.stringify({ mcpServers: { context7: {} } }));
    const data = mcpServersDigest(ctx())?.data as ServerData;
    expect(data.servers).toContainEqual(["context7", "third-party"]);
    expect(data.thirdParty).toBe(1);
  });

  it("uses org-policy MCP egress and disabled-server rules", () => {
    put(
      ".mcp.json",
      JSON.stringify({ mcpServers: { github: {}, context7: {}, "code-review-graph": {} } }),
    );
    put(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { incumbentHosts: [], disabledServers: ["context7"] },
      }),
    );

    const data = mcpServersDigest(ctx())?.data as ServerData;

    expect(data.servers).toContainEqual(["github", "third-party"]);
    expect(data.servers).toContainEqual(["context7", "third-party"]);
    expect(data.policyDisabled).toEqual(["context7"]);
    expect(data.thirdParty).toBe(2);
  });

  it("reports disabled GitHub egress without consulting invalid ambient GITHUB_HOST", () => {
    put(".mcp.json", JSON.stringify({ mcpServers: { github: {} } }));
    put(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { disabledServers: ["github"] },
      }),
    );

    const d = mcpServersDigest(ctx({ env: { GITHUB_HOST: "github.internal.example" } }));
    const data = d?.data as ServerData;

    expect(d?.text).not.toContain("policy-aware MCP catalog unavailable");
    expect(data.catalogError).toBeUndefined();
    expect(data.servers).toContainEqual(["github", "third-party"]);
    expect(data.policyDisabled).toEqual(["github"]);
  });

  it("fails closed instead of claiming no third-party egress when the catalog fails", () => {
    put(".mcp.json", JSON.stringify({ mcpServers: { github: {} } }));

    const d = mcpServersDigest(ctx({ env: { GITHUB_HOST: "github.internal.example" } }));
    const data = d?.data as ServerData;

    expect(d?.text).toContain("policy-aware MCP catalog unavailable");
    expect(d?.text).not.toContain("No third-party egress.");
    expect(data.catalogError).toContain("GITHUB_HOST must be an https origin");
    expect(data.servers).toEqual([["github", "unknown"]]);
    expect(data.thirdParty).toBeUndefined();
  });
});

/** A minimal SupportTemplate for the given kind (only the fields supportDigest reads). */
function tpl(kind: SupportTemplate["kind"], subject: string, body = "b"): SupportTemplate {
  return {
    id: `${kind}:x`,
    code: "report.low-adoption",
    kind,
    audience: "developer",
    severity: "optional",
    subject,
    body,
    copyLabel: "copy",
  } as unknown as SupportTemplate;
}

describe("supportDigest", () => {
  it("counts findings by who acts and surfaces the first escalation ticket", () => {
    const d = supportDigest([
      tpl("self-fix", "a"),
      tpl("self-fix", "b"),
      tpl("improvement", "c"),
      tpl("escalation", "MCP blocked", "add the corporate root CA"),
    ]);
    const data = d.data as {
      findings: { selfFix: number; improvement: number; escalation: number };
      ticket: string;
    };
    expect(data.findings).toEqual({ selfFix: 2, improvement: 1, escalation: 1 });
    expect(data.ticket).toContain("Subject: MCP blocked");
    expect(data.ticket).toContain("add the corporate root CA");
  });

  it("yields zero findings and an empty ticket for no templates", () => {
    const data = supportDigest([]).data as {
      findings: { selfFix: number; improvement: number; escalation: number };
      ticket: string;
    };
    expect(data.findings).toEqual({ selfFix: 0, improvement: 0, escalation: 0 });
    expect(data.ticket).toBe("");
  });
});

function marker(...targets: string[]): void {
  put(".aih-config.json", JSON.stringify({ schemaVersion: 1, contextDir: DIR, targets }));
}

function inSync(): string {
  return mergeManagedBlock(undefined, sharedBlock(DIR), "# Repo");
}

interface EccData {
  version?: string;
  machine: { agents: number; skills: number; rules: number };
  repo: { agents: number; skills: number; rules: number; hooks: number };
  dup: number;
  packs: string[];
  skillNames?: string[];
}

describe("eccInventoryDigest", () => {
  it("returns undefined when neither machine nor repo has ECC content", () => {
    expect(eccInventoryDigest(ctx())).toBeUndefined();
  });

  it("counts repo-local content as TEAM OVERRIDES, separate from (empty) machine ECC", () => {
    put(".claude/agents/architecture-drift.md", "# agent\n");
    put(".claude/agents/security-audit.md", "# agent\n");
    put(".claude/skills/aws-hardening/SKILL.md", "# skill\n");
    put(".kiro/skills/governance/SKILL.md", "# skill\n");
    put(
      ".claude/settings.json",
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "*", hooks: [{ type: "command" }, { type: "command" }] }],
        },
      }),
    );
    const data = eccInventoryDigest(ctx())?.data as EccData;
    expect(data.repo.agents).toBe(2);
    expect(data.repo.skills).toBe(2); // one dir under each of .claude/skills and .kiro/skills
    expect(data.repo.hooks).toBe(2);
    expect(data.machine).toEqual({ agents: 0, skills: 0, rules: 0 }); // empty temp home
    expect(data.dup).toBe(0); // repo names don't collide with the (empty) machine ECC
    expect(Array.isArray(data.packs)).toBe(true);
  });

  it("reads machine ECC from ~/.claude (incl. nested rules) and flags repo duplication", () => {
    putHome(".claude/agents/architect.md", "# agent\n");
    putHome(".claude/agents/code-reviewer.md", "# agent\n");
    putHome(".claude/skills/tdd/SKILL.md", "# skill\n");
    putHome(".claude/rules/ecc/common/coding-style.md", "# rule\n"); // nested → recursive count
    // repo forks one machine agent (code-reviewer) + adds its own
    put(".claude/agents/code-reviewer.md", "# forked\n");
    put(".claude/agents/architecture-drift.md", "# own\n");
    const data = eccInventoryDigest(ctx())?.data as EccData;
    expect(data.machine).toEqual({ agents: 2, skills: 1, rules: 1 });
    expect(data.repo.agents).toBe(2);
    expect(data.dup).toBe(1); // code-reviewer collides with a machine-ECC agent
  });

  it("counts the LIVE ecc/ namespace (not flat plugin skills) + takes version from the manifest", () => {
    // manifest supplies version/commit only (its counts are a stale snapshot)
    putHome(
      ".claude/ecc/install-state.json",
      JSON.stringify({
        source: { repoVersion: "2.0.0", repoCommit: "68e926bf77dd00" },
        request: { profile: "developer" },
      }),
    );
    // current ECC lives under the ecc/ namespace …
    putHome(".claude/agents/architect.md", "x");
    putHome(".claude/agents/code-reviewer.md", "x");
    putHome(".claude/skills/ecc/python-patterns/SKILL.md", "x");
    putHome(".claude/skills/ecc/react-testing/SKILL.md", "x");
    putHome(".claude/skills/ecc/security-review/SKILL.md", "x");
    putHome(".claude/rules/ecc/common/coding-style.md", "x");
    // … and a PLUGIN skill sits flat in skills/ — it must NOT count as ECC
    putHome(".claude/skills/cloudflare/SKILL.md", "x");
    // repo forks one ECC agent (code-reviewer) + adds its own
    put(".claude/agents/code-reviewer.md", "forked");
    put(".claude/agents/architecture-drift.md", "own");
    const data = eccInventoryDigest(ctx())?.data as EccData;
    expect(data.version).toBe("2.0.0");
    // skills counted from skills/ecc/ (3) — the flat cloudflare plugin skill is excluded
    expect(data.machine).toEqual({ agents: 2, skills: 3, rules: 1 });
    expect(data.skillNames).toEqual(["python-patterns", "react-testing", "security-review"]);
    expect(data.dup).toBe(1); // repo code-reviewer is an ECC agent (name match)
  });

  it("counts the current ECC repo layout under ~/.claude/ecc/.agents/skills", () => {
    putHome(
      ".claude/ecc/install-state.json",
      JSON.stringify({
        source: { repoVersion: "2.0.0", repoCommit: "68e926bf77dd00" },
        request: { profile: "developer" },
      }),
    );
    putHome(".claude/ecc/.agents/skills/security-review/SKILL.md", "x");
    putHome(".claude/ecc/.agents/skills/tdd-workflow/SKILL.md", "x");
    putHome(".claude/ecc/.agents/skills/agent-sort/SKILL.md", "x");
    putHome(".claude/skills/cloudflare/SKILL.md", "x");

    const data = eccInventoryDigest(ctx())?.data as EccData;

    expect(data.machine.skills).toBe(3);
    expect(data.skillNames).toEqual(["agent-sort", "security-review", "tdd-workflow"]);
  });
});

interface CoherenceData {
  clis: string[];
  dims: string[];
  cells: Record<string, string[]>;
  agreementPct: number;
}

describe("coherenceDigest", () => {
  it("returns undefined off-canon", () => {
    marker("claude", "codex");
    expect(coherenceDigest(ctx())).toBeUndefined();
  });

  it("returns undefined with fewer than two targeted CLIs", () => {
    marker("claude");
    put(`${DIR}/RULE_ROUTER.md`, "routing\n");
    put("CLAUDE.md", inSync());
    expect(coherenceDigest(ctx())).toBeUndefined();
  });

  it("computes per-CLI cells + an agreement % across two CLIs", () => {
    marker("claude", "codex");
    put(`${DIR}/RULE_ROUTER.md`, "routing\n");
    put("CLAUDE.md", inSync());
    put("AGENTS.md", inSync());
    const d = coherenceDigest(ctx());
    const data = d?.data as CoherenceData;
    expect(data.clis).toEqual(["claude", "codex"]);
    expect(data.dims).toEqual(["rules", "router", "mcp", "loads"]);
    // in-sync bootloaders → rules + router cells are ok for both CLIs
    expect(data.cells.claude?.[0]).toBe("ok");
    expect(data.cells.claude?.[1]).toBe("ok");
    expect(data.cells.codex?.[0]).toBe("ok");
    expect(typeof data.agreementPct).toBe("number");
    expect(data.agreementPct).toBeGreaterThanOrEqual(50);
  });

  it("marks a global-scoped MCP (codex ~/.codex) as 'global' — wired but machine-local", () => {
    marker("claude", "codex");
    put(`${DIR}/RULE_ROUTER.md`, "routing\n");
    put("CLAUDE.md", inSync());
    put("AGENTS.md", inSync());
    put(".mcp.json", JSON.stringify({ mcpServers: { x: {} } })); // claude: repo-committed MCP → ok
    putHome(".codex/config.toml", '[mcp_servers.foo]\ncommand = "x"\n'); // codex: global MCP → global
    const data = coherenceDigest(ctx())?.data as CoherenceData;
    expect(data.cells.claude?.[2]).toBe("ok"); // mcp dim, repo-scoped
    expect(data.cells.codex?.[2]).toBe("global"); // wired but machine-local → neutral, not a warn
  });
});

/** Write run-ledger rows to `.aih/runs/2026-06.jsonl`. */
function ledger(...rows: Array<Record<string, unknown>>): void {
  put(".aih/runs/2026-06.jsonl", `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

interface OutcomeData {
  leadTimeDays: number;
  reworkRatePct: number;
  mttr: { driftHours: number; externalCheckDays: number };
}

describe("outcomeDeltasDigest", () => {
  it("returns undefined with fewer than two ledger samples", async () => {
    ledger({ capability: "report", status: "failed", finishedAt: "2026-06-01T00:00:00Z" });
    expect(await outcomeDeltasDigest(ctx())).toBeUndefined();
  });

  it("computes MTTR from a broken→green run-ledger transition", async () => {
    ledger(
      { capability: "report", status: "failed", finishedAt: "2026-06-01T00:00:00Z" },
      { capability: "report", status: "success", finishedAt: "2026-06-01T03:00:00Z" },
      { capability: "heal", status: "failed", finishedAt: "2026-06-02T00:00:00Z" },
      { capability: "heal", status: "success", finishedAt: "2026-06-03T00:00:00Z" },
    );
    const data = (await outcomeDeltasDigest(ctx()))?.data as OutcomeData;
    expect(data.mttr.driftHours).toBe(3); // report: 3h broken→green
    expect(data.mttr.externalCheckDays).toBe(1); // heal: 24h → 1 day
  });
});

interface WinsData {
  items: Array<{
    name: string;
    scope: string;
    status: "fixed" | "broken" | "na";
    detail: string;
    when: string;
  }>;
  cleared: number;
  runs: number;
  since: string;
  openOverTime: number[];
  ledger?: { runs: number; verificationFail: number; supportFindings: number };
}

describe("winsDigest", () => {
  it("returns undefined without any run history", () => {
    expect(winsDigest(ctx())).toBeUndefined();
  });

  it("surfaces run-ledger counts even before heal has populated remediation rows", () => {
    ledger(
      {
        capability: "report",
        status: "failed",
        startedAt: "2026-06-01T00:00:00Z",
        verification: { pass: 4, fail: 2, skip: 0 },
        support: { findings: 3, templates: 1 },
      },
      {
        capability: "report",
        status: "failed",
        startedAt: "2026-06-02T00:00:00Z",
        verification: { fail: "9" },
        support: { findings: "8" },
      },
    );
    const d = winsDigest(ctx());
    const data = d?.data as WinsData;
    expect(d?.describe).toBe("Remediation — no heal history");
    expect(d?.text).toContain("No heal history");
    expect(d?.text).toContain("2 verification.fail · 3 support.findings");
    expect(data.items).toEqual([]);
    expect(data.ledger).toEqual({ runs: 2, verificationFail: 2, supportFindings: 3 });
    expect(renderWins(data)).toContain("support.findings");
    expect(renderWins(data)).toContain("ledger rows");
    expect(renderWins(data)).not.toContain("Runtime is green");
  });

  it("summarizes the heal remediation ledger (cumulative + per-scope rows)", () => {
    ledger(
      {
        capability: "heal",
        status: "failed",
        startedAt: "2026-06-01T00:00:00Z",
        verification: { pass: 2, fail: 2, skip: 0 },
      },
      {
        capability: "report",
        status: "failed",
        startedAt: "2026-06-02T00:00:00Z",
        verification: { pass: 3, fail: 1, skip: 0 },
        support: { findings: 2, templates: 2 },
      },
      {
        capability: "heal",
        status: "success",
        startedAt: "2026-06-03T00:00:00Z",
        verification: { pass: 4, fail: 0, skip: 0 },
      },
    );
    const data = winsDigest(ctx())?.data as WinsData;
    expect(data.items).toHaveLength(4);
    expect(data.items.every((i) => i.status === "fixed")).toBe(true);
    expect(data.cleared).toBe(4);
    expect(data.runs).toBe(2);
    expect(data.openOverTime).toEqual([2, 0]);
    expect(data.ledger).toEqual({ runs: 3, verificationFail: 3, supportFindings: 2 });
  });

  it("marks only the scopes the last heal probed (.aih/heal-last.json); others are na (§2b)", () => {
    ledger({
      capability: "heal",
      status: "success",
      startedAt: "2026-06-03T00:00:00Z",
      finishedAt: "2026-06-03T00:00:05Z",
      verification: { pass: 2, fail: 0, skip: 0 },
    });
    put(".aih/heal-last.json", JSON.stringify({ scopes: ["certs", "npm"] }));
    const data = winsDigest(ctx())?.data as WinsData;
    const byScope = Object.fromEntries(data.items.map((i) => [i.scope, i]));
    expect(byScope.certs?.status).toBe("fixed");
    expect(byScope.npm?.status).toBe("fixed");
    expect(byScope.path?.status).toBe("na");
    expect(byScope.mcp?.status).toBe("na");
    expect(byScope.mcp?.detail).toContain("(not probed)");
    expect(data.cleared).toBe(2); // only probed + green count as cleared
    // a fixed row carries the latest heal run's date; a na row stays blank
    expect(byScope.certs?.when).toBe("Jun 3");
    expect(byScope.path?.when).toBe("");
  });
});

interface SkillGovData {
  installed: number;
  approved: number;
  unapproved: number;
  stalePin: number;
  rows: Array<{
    name: string;
    status: "approved" | "unapproved" | "stale-pin" | "quarantined";
    source?: string;
    commit?: string;
  }>;
  scanner?: {
    reports: number;
    newestAt?: string;
    verdicts: { GREEN: number; YELLOW: number; RED: number; UNKNOWN: number };
    analyzers: string[];
    gaps: string[];
  };
  approvalVerdicts?: { GREEN: number; YELLOW: number };
}

describe("skillGovernanceDigest", () => {
  it("returns undefined with no skills on disk and no committed approvals", () => {
    expect(skillGovernanceDigest(ctx())).toBeUndefined();
  });

  it("is live with an unapproved on-disk skill (nothing in the lock)", () => {
    put(`${DIR}/skills/loose/foo/SKILL.md`, "# foo\n");
    const d = skillGovernanceDigest(ctx());
    expect(d).toBeDefined();
    expect(d?.describe).toContain("1 installed (0 approved, 1 unapproved, 0 stale)");
    const data = d?.data as SkillGovData;
    expect(data).toMatchObject({ installed: 1, approved: 0, unapproved: 1, stalePin: 0 });
    expect(data.rows[0]).toMatchObject({ name: "foo", status: "unapproved" });
    expect(d?.text).toContain("foo — unapproved");
  });

  it("is live from the lock alone even when no skill is on disk yet", () => {
    put(
      "aih-skills.lock.json",
      JSON.stringify({
        schemaVersion: 1,
        skills: [
          {
            name: "clean",
            source: `owner/repo@${"a".repeat(40)}`,
            commit: "a".repeat(40),
            verdict: "GREEN",
            scope: "repo",
            card: `${DIR}/skill-cards/clean.json`,
            evidenceSha256: "0".repeat(64),
            approvedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const d = skillGovernanceDigest(ctx());
    expect(d).toBeDefined();
    // On disk it's absent → installed 0, but the lock keeps the panel live to govern.
    const data = d?.data as SkillGovData;
    expect(data.installed).toBe(0);
    expect(data.scanner?.gaps).toContain(
      "no skill vet evidence artifacts found in .aih/skill-reports",
    );
  });

  it("is live from scanner evidence alone so blocked attempts are not hidden", () => {
    put(
      ".aih/skill-reports/blocked.json",
      JSON.stringify({
        schemaVersion: 1,
        source: "owner/blocked",
        checks: [],
        analyzersRun: ["aih-native"],
        verdict: "RED",
        reasons: ["blocked"],
      }),
    );

    const d = skillGovernanceDigest(ctx());
    const data = d?.data as SkillGovData;
    expect(data.installed).toBe(0);
    expect(data.scanner).toMatchObject({
      reports: 1,
      verdicts: { GREEN: 0, YELLOW: 0, RED: 1, UNKNOWN: 0 },
      analyzers: ["aih-native"],
      gaps: [],
    });
    const html = renderSkillGovernance({
      installed: data.installed,
      approved: data.approved,
      unapproved: data.unapproved,
      stalePin: data.stalePin,
      quarantined: 0,
      rows: data.rows,
      scanner: data.scanner,
      approvalVerdicts: data.approvalVerdicts,
    });
    expect(html).toContain("scanner age");
    expect(html).toContain("RED 1");
    expect(html).toContain("scanner, marketplace");
  });

  it("is live from unreadable scanner evidence alone so the gap is visible", () => {
    put(".aih/skill-reports/broken.json", "{ not json");

    const d = skillGovernanceDigest(ctx());
    const data = d?.data as SkillGovData;
    expect(data.scanner).toMatchObject({
      reports: 0,
      verdicts: { GREEN: 0, YELLOW: 0, RED: 0, UNKNOWN: 0 },
      gaps: ["1 skill vet evidence artifact(s) could not be parsed"],
    });
    const html = renderSkillGovernance({
      installed: data.installed,
      approved: data.approved,
      unapproved: data.unapproved,
      stalePin: data.stalePin,
      quarantined: 0,
      rows: data.rows,
      scanner: data.scanner,
      approvalVerdicts: data.approvalVerdicts,
    });
    expect(html).toContain("could not be parsed");
  });

  it("surfaces scanner age plus RED/YELLOW/UNKNOWN evidence counts from skill reports", () => {
    put(`${DIR}/skills/src/alpha/SKILL.md`, "# alpha\n");
    put(
      "aih-skills.lock.json",
      JSON.stringify({
        schemaVersion: 1,
        skills: [lockEntry("alpha", "docs"), { ...lockEntry("review", "docs"), verdict: "YELLOW" }],
      }),
    );
    const evidence = (verdict: string, analyzer: string): string =>
      JSON.stringify({
        schemaVersion: 1,
        source: "owner/repo",
        checks: [],
        analyzersRun: [analyzer],
        verdict,
        reasons: [],
      });
    put(".aih/skill-reports/alpha.json", evidence("RED", "skillspector"));
    put(".aih/skill-reports/beta.json", evidence("UNKNOWN", "aih-native"));
    put(".aih/skill-reports/gamma.json", evidence("YELLOW", "skillspector"));
    const newest = new Date("2026-07-02T12:00:00Z");
    utimesSync(join(dir, ".aih/skill-reports/alpha.json"), newest, newest);
    utimesSync(
      join(dir, ".aih/skill-reports/beta.json"),
      new Date("2026-07-01T12:00:00Z"),
      new Date("2026-07-01T12:00:00Z"),
    );
    utimesSync(
      join(dir, ".aih/skill-reports/gamma.json"),
      new Date("2026-06-30T12:00:00Z"),
      new Date("2026-06-30T12:00:00Z"),
    );

    const d = skillGovernanceDigest(ctx());
    const data = d?.data as SkillGovData;
    expect(data.scanner).toMatchObject({
      reports: 3,
      newestAt: "2026-07-02",
      verdicts: { GREEN: 0, YELLOW: 1, RED: 1, UNKNOWN: 1 },
      analyzers: ["aih-native", "skillspector"],
      gaps: [],
    });
    expect(data.approvalVerdicts).toEqual({ GREEN: 1, YELLOW: 1 });
    expect(d?.text).toContain("scanner verdicts: GREEN 0 · YELLOW 1 · RED 1 · UNKNOWN 1");
    const html = renderSkillGovernance({
      installed: data.installed,
      approved: data.approved,
      unapproved: data.unapproved,
      stalePin: data.stalePin,
      quarantined: 0,
      rows: data.rows,
      scanner: data.scanner,
      approvalVerdicts: data.approvalVerdicts,
    });
    expect(html).toContain("newest scan 2026-07-02");
    expect(html).toContain("RED 1 · UNKNOWN 1");
    expect(html).toContain("GREEN 1 · YELLOW 1");
  });

  it("counts a quarantined skill in the title breakdown and NEVER as clean (review high)", () => {
    put(`.aih/quarantine/${DIR}/skills/src/parked/SKILL.md`, "# parked\n");
    const d = skillGovernanceDigest(ctx());
    expect(d).toBeDefined();
    // The breakdown must sum to installed — quarantined is named, not silently dropped.
    expect(d?.describe).toContain("1 installed (0 approved, 0 unapproved, 0 stale, 1 quarantined)");
    const data = d?.data as SkillGovData & { quarantined: number };
    expect(data.quarantined).toBe(1);
    // And the rendered panel must not claim "all approved" while a skill is parked.
    const html = renderSkillGovernance({
      installed: 1,
      approved: 0,
      unapproved: 0,
      stalePin: 0,
      quarantined: 1,
      rows: [{ name: "parked", status: "quarantined" }],
    });
    expect(html).not.toContain("approved</b><span>every external skill");
    expect(html).toContain("not fully approved");
  });

  it("strips control/bidi characters from skill and pack labels (Codex low)", () => {
    // escHtml stops executable injection; bidi overrides could still VISUALLY spoof
    // a governance row (e.g. RTL-reversing "approved"). Both label paths strip them.
    // Escapes only — never literal bidi bytes in source (repo rule).
    const html = renderSkillGovernance({
      installed: 1,
      approved: 1,
      unapproved: 0,
      stalePin: 0,
      quarantined: 0,
      rows: [{ name: "docs\u202ewhat", status: "approved", source: "a/b\u200bx" }],
      packs: [{ name: "core\u202aevil", skills: 1, approved: 1 }],
    });
    expect(html).not.toContain("\u202e");
    expect(html).not.toContain("\u202a");
    expect(html).not.toContain("\u200b");
    expect(html).toContain("docswhat");
    expect(html).toContain("pack coreevil");
  });

  it("never renders 'all approved' above a failing governance artifact (review HIGH)", () => {
    // Zero installed skills + a broken, unsigned marketplace artifact: the badge and
    // status box must warn — a green headline directly above a warn row is a lie.
    const base = {
      installed: 0,
      approved: 0,
      unapproved: 0,
      stalePin: 0,
      quarantined: 0,
      rows: [],
    };
    const broken = renderSkillGovernance({
      ...base,
      marketplace: { skills: 0, findings: 3, signed: false },
    });
    expect(broken).not.toContain("all approved");
    expect(broken).toContain("artifacts need attention");
    expect(broken).toContain("Governance artifacts need attention");
    // Same for a checksum-mismatched or stale evidence bundle and an invalid policy.
    for (const model of [
      { ...base, evidence: { artifacts: 1, current: false, stale: false } },
      { ...base, evidence: { artifacts: 1, current: true, stale: true } },
      { ...base, orgPolicy: { present: true as const, valid: false } },
    ]) {
      expect(renderSkillGovernance(model)).not.toContain("all approved");
    }
    // HEALTHY artifacts must not flip the badge: all-green stays "all approved".
    const healthy = renderSkillGovernance({
      ...base,
      installed: 1,
      approved: 1,
      rows: [{ name: "clean", status: "approved" as const }],
      marketplace: { skills: 1, findings: 0, signed: true },
      evidence: { artifacts: 2, current: true, stale: false },
      orgPolicy: { present: true as const, valid: true },
    });
    expect(healthy).toContain("all approved");
    // And skill problems still take precedence over the artifact wording.
    const unattested = renderSkillGovernance({
      ...base,
      installed: 1,
      unapproved: 1,
      rows: [{ name: "rogue", status: "unapproved" as const }],
      marketplace: { skills: 0, findings: 3, signed: false },
    });
    expect(unattested).toContain("1 unattested");
  });

  it("renders an un-re-verified large bundle neutrally — not as an issue", () => {
    // `current` undefined = re-hash skipped for size; that is honesty about NOT
    // checking, so it must neither claim consistency nor warn like a mismatch.
    const html = renderSkillGovernance({
      installed: 1,
      approved: 1,
      unapproved: 0,
      stalePin: 0,
      quarantined: 0,
      rows: [{ name: "clean", status: "approved" }],
      evidence: { artifacts: 40, stale: false },
    });
    expect(html).toContain("not re-verified (large bundle)");
    expect(html).not.toContain("checksums mismatch");
    expect(html).not.toContain("internally consistent");
    expect(html).toContain("all approved"); // unchecked ≠ failing
  });

  /** A schema-valid lock entry for `name`, optionally tagged with a pack. */
  const lockEntry = (name: string, pack?: string): Record<string, unknown> => ({
    name,
    source: `owner/repo@${"a".repeat(40)}`,
    commit: "a".repeat(40),
    verdict: "GREEN",
    ...(pack !== undefined ? { pack } : {}),
    scope: "repo",
    card: `${DIR}/skill-cards/${name}.json`,
    evidenceSha256: "0".repeat(64),
    approvedAt: "2026-01-01T00:00:00.000Z",
  });

  it("adds the by-pack rollup (data + body line) when lock entries carry pack tags", () => {
    put(`${DIR}/skills/src/alpha/SKILL.md`, "# alpha\n");
    put(`${DIR}/skills/src/beta/SKILL.md`, "# beta\n");
    put(
      "aih-skills.lock.json",
      JSON.stringify({
        schemaVersion: 1,
        skills: [lockEntry("alpha", "docs"), lockEntry("beta", "docs")],
      }),
    );
    // beta was acquired at a DIFFERENT commit than the approval pin → stale-pin, so
    // the pack rollup's `approved` must count 1 of 2 (not skills-on-disk).
    put(
      ".aih/trust-lock.json",
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: "owner-repo",
            kind: "github",
            source: "owner/repo",
            pinnedSha: "d".repeat(40),
            promotedAt: "2026-01-01T00:00:00.000Z",
            promotedSkills: ["beta"],
            analyzersRun: ["aih-native"],
            artifactHashes: [],
            findings: [],
          },
        ],
      }),
    );
    const d = skillGovernanceDigest(ctx());
    const data = d?.data as SkillGovData & {
      packs?: Array<{ name: string; skills: number; approved: number }>;
    };
    expect(data.packs).toEqual([{ name: "docs", skills: 2, approved: 1 }]);
    expect(d?.text).toContain("by pack:");
    expect(d?.text).toContain("  docs — 1/2 approved");
    // The rendered panel gains the per-pack row only when the model carries packs.
    const model = {
      installed: 2,
      approved: 1,
      unapproved: 0,
      stalePin: 1,
      quarantined: 0,
      rows: [],
    };
    const withPacks = renderSkillGovernance({
      ...model,
      packs: [{ name: "docs", skills: 2, approved: 1 }],
    });
    expect(withPacks).toContain("pack docs");
    expect(withPacks).toContain("1 of 2 approved");
    // Pack-free models render byte-identically whether `packs` is absent or empty.
    expect(renderSkillGovernance(model)).toBe(renderSkillGovernance({ ...model, packs: [] }));
    expect(renderSkillGovernance(model)).not.toContain("pack docs");
  });

  it("counts a quarantined member in its pack's rollup — tag survives quarantine (#111 regression)", () => {
    put(`${DIR}/skills/src/alpha/SKILL.md`, "# alpha\n");
    put(`.aih/quarantine/${DIR}/skills/src/parked/SKILL.md`, "# parked\n");
    put(
      "aih-skills.lock.json",
      JSON.stringify({
        schemaVersion: 1,
        skills: [lockEntry("alpha", "docs"), lockEntry("parked", "docs")],
      }),
    );
    const d = skillGovernanceDigest(ctx());
    const data = d?.data as SkillGovData & {
      packs?: Array<{ name: string; skills: number; approved: number; quarantined?: number }>;
    };
    // The parked member widens `skills` (not `approved`) and is named per pack.
    expect(data.packs).toEqual([{ name: "docs", skills: 2, approved: 1, quarantined: 1 }]);
    expect(d?.text).toContain("  docs — 1/2 approved · 1 quarantined");
    // Its row keeps the lock provenance (source/commit), no longer "not in lock".
    const parked = data.rows.find((r) => r.name === "parked");
    expect(parked).toMatchObject({ status: "quarantined", commit: "a".repeat(40) });
    // Render: the per-pack row names the parked member only when the count rides in.
    const model = {
      installed: 2,
      approved: 1,
      unapproved: 0,
      stalePin: 0,
      quarantined: 1,
      rows: [],
    };
    const withQuarantined = renderSkillGovernance({
      ...model,
      packs: [{ name: "docs", skills: 2, approved: 1, quarantined: 1 }],
    });
    expect(withQuarantined).toContain("1 of 2 approved · 1 quarantined");
    // Absent and zero render byte-identically — the conditional-render idiom.
    expect(
      renderSkillGovernance({ ...model, packs: [{ name: "docs", skills: 2, approved: 1 }] }),
    ).toBe(
      renderSkillGovernance({
        ...model,
        packs: [{ name: "docs", skills: 2, approved: 1, quarantined: 0 }],
      }),
    );
  });

  it("keeps a pack-free repo's digest free of pack rollups", () => {
    put(`${DIR}/skills/src/clean/SKILL.md`, "# clean\n");
    put("aih-skills.lock.json", JSON.stringify({ schemaVersion: 1, skills: [lockEntry("clean")] }));
    const d = skillGovernanceDigest(ctx());
    expect(d?.describe).toBe("Skill governance — 1 installed (1 approved, 0 unapproved, 0 stale)");
    expect(d?.text).toContain(
      "1 external skill installed · 1 approved · 0 unapproved · 0 stale-pin · 0 quarantined.",
    );
    expect(d?.text).toContain("All 1 installed skill is approved and in sync.");
    expect(d?.text).toContain("scanner & verdict evidence:");
    expect(d?.text).not.toContain("by pack:");
    expect(Object.keys(d?.data as Record<string, unknown>)).not.toContain("packs");
    // No marketplace artifact on disk → no key, no "distribution & audit" section.
    expect(Object.keys(d?.data as Record<string, unknown>)).not.toContain("marketplace");
    expect(d?.text).not.toContain("distribution & audit");
  });

  /**
   * A minimal GREEN marketplace artifact under `.aih/marketplace`: one packaged
   * skill, every file present + hashed, SHA256SUMS covering the whole tree — the
   * exact shape `marketplace build` writes, so `marketplaceReport` grades it clean.
   */
  const putMarketplace = (withSig: boolean): void => {
    const skillBody = "# x\n";
    const cardBody = "{}\n";
    const evidenceBody = "{}\n";
    const manifest = JSON.stringify({
      schemaVersion: 1,
      name: "acme",
      skills: [
        {
          name: "x",
          source: `owner/repo@${"a".repeat(40)}`,
          commit: "a".repeat(40),
          verdict: "GREEN",
          card: "cards/x.json",
          evidence: "evidence/x.json",
          files: [
            {
              path: "files/x/SKILL.md",
              sha256: sha256Hex(skillBody),
              bytes: Buffer.byteLength(skillBody),
            },
          ],
        },
      ],
    });
    put(".aih/marketplace/marketplace.json", manifest);
    put(".aih/marketplace/cards/x.json", cardBody);
    put(".aih/marketplace/evidence/x.json", evidenceBody);
    put(".aih/marketplace/files/x/SKILL.md", skillBody);
    const sums = `${[
      `${sha256Hex(manifest)}  marketplace.json`,
      `${sha256Hex(cardBody)}  cards/x.json`,
      `${sha256Hex(evidenceBody)}  evidence/x.json`,
      `${sha256Hex(skillBody)}  files/x/SKILL.md`,
    ].join("\n")}\n`;
    put(".aih/marketplace/SHA256SUMS", sums);
    if (withSig) put(".aih/marketplace/SHA256SUMS.sig", "sig-bytes\n");
  };

  it("surfaces a green marketplace artifact — and keeps the digest live from it alone", () => {
    // No skills, no lock: the built artifact IS something to govern.
    putMarketplace(true);
    const d = skillGovernanceDigest(ctx());
    expect(d).toBeDefined();
    const data = d?.data as SkillGovData & {
      marketplace?: { skills: number; findings: number; signed: boolean };
    };
    expect(data.marketplace).toEqual({ skills: 1, findings: 0, signed: true });
    expect(d?.text).toContain("distribution & audit:");
    // Presence claim ONLY — verification is `marketplace validate`'s spawn.
    expect(d?.text).toContain("1 skill(s) · 0 finding(s) · signature file present");
    expect(d?.text).not.toContain("signature verified");
  });

  it("grades a broken, unsigned marketplace artifact with findings (never crashes)", () => {
    // A manifest alone: sums missing → coverage finding; no sig → unsigned.
    put(".aih/marketplace/marketplace.json", "{ not json");
    const d = skillGovernanceDigest(ctx());
    const data = d?.data as SkillGovData & {
      marketplace?: { skills: number; findings: number; signed: boolean };
    };
    expect(data.marketplace?.skills).toBe(0);
    expect(data.marketplace?.findings).toBeGreaterThan(0);
    expect(data.marketplace?.signed).toBe(false);
    expect(d?.text).toContain("unsigned");
  });

  /**
   * A minimal evidence bundle under `.aih/evidence-bundle` in `evidence build`'s
   * exact layout: `files/<rel>` copy of the skills lock plus generated metadata,
   * all covered by SHA256SUMS.
   */
  const putEvidenceBundle = (lockBody: string): void => {
    const bundled = `${lockBody}\n`; // evidence build normalizes to one trailing newline
    const manifest = {
      schemaVersion: 1,
      files: [
        {
          path: "aih-skills.lock.json",
          bytes: Buffer.byteLength(bundled, "utf8"),
          sha256: sha256Hex(bundled),
        },
      ],
    };
    const evidence = {
      schemaVersion: 1,
      artifacts: [
        {
          kind: "skills-lock",
          path: "aih-skills.lock.json",
          sha256: sha256Hex(bundled),
          schemaVersion: 1,
        },
      ],
    };
    const manifestBody = jsonFile(manifest);
    const evidenceBody = jsonFile(evidence);
    put(".aih/evidence-bundle/files/aih-skills.lock.json", bundled);
    put(".aih/evidence-bundle/manifest.json", manifestBody);
    put(".aih/evidence-bundle/evidence.json", evidenceBody);
    put(
      ".aih/evidence-bundle/SHA256SUMS",
      `${sha256Hex(bundled)}  files/aih-skills.lock.json\n` +
        `${sha256Hex(manifestBody)}  manifest.json\n` +
        `${sha256Hex(evidenceBody)}  evidence.json\n`,
    );
  };

  it("surfaces a current, non-stale evidence bundle — live from the bundle alone", () => {
    const lock = JSON.stringify({ schemaVersion: 1, skills: [lockEntry("clean")] });
    put("aih-skills.lock.json", lock);
    putEvidenceBundle(lock);
    const d = skillGovernanceDigest(ctx());
    expect(d).toBeDefined();
    const data = d?.data as SkillGovData & {
      evidence?: { artifacts: number; current: boolean; stale: boolean };
    };
    expect(data.evidence).toEqual({ artifacts: 1, current: true, stale: false });
    expect(d?.text).toContain("evidence bundle (.aih/evidence-bundle) — 1 artifact(s)");
    expect(d?.text).toContain("internally consistent");
    expect(d?.text).not.toContain("rebuild:");
  });

  it("flags a bundle whose bundled lock the live lock has moved past as stale", () => {
    const oldLock = JSON.stringify({ schemaVersion: 1, skills: [] });
    putEvidenceBundle(oldLock);
    // The live lock gained an approval AFTER the bundle was built.
    put("aih-skills.lock.json", JSON.stringify({ schemaVersion: 1, skills: [lockEntry("newer")] }));
    const d = skillGovernanceDigest(ctx());
    const data = d?.data as SkillGovData & {
      evidence?: { artifacts: number; current: boolean; stale: boolean };
    };
    // Internally the bundle still verifies — staleness is the LIVE-lock signal.
    expect(data.evidence).toEqual({ artifacts: 1, current: true, stale: true });
    expect(d?.text).toContain("live skills lock has moved past the bundled copy");
    expect(d?.text).toContain("rebuild: `aih evidence build --apply`");
  });

  it("flags a tampered bundled copy as not internally consistent", () => {
    const lock = JSON.stringify({ schemaVersion: 1, skills: [] });
    put("aih-skills.lock.json", lock);
    putEvidenceBundle(lock);
    put(".aih/evidence-bundle/files/aih-skills.lock.json", '{"tampered":true}\n');
    const d = skillGovernanceDigest(ctx());
    const data = d?.data as SkillGovData & { evidence?: { current: boolean; stale: boolean } };
    expect(data.evidence?.current).toBe(false);
    expect(data.evidence?.stale).toBe(true); // the bundled copy no longer matches the live lock either
    expect(d?.text).toContain("bundled copies do NOT match SHA256SUMS");
  });

  it("skips the integrity re-hash past the manifest-declared size budget (review MEDIUM)", () => {
    // A bundle whose manifest declares more bytes than the digest-time budget is NOT
    // re-hashed on every report — `current` is omitted and the text says so honestly.
    // (The bundled files themselves stay tiny; only the DECLARED size trips the cap,
    // which is the point: one cheap manifest read decides, no hashing happens.)
    const lock = JSON.stringify({ schemaVersion: 1, skills: [] });
    put("aih-skills.lock.json", lock);
    putEvidenceBundle(lock);
    put(
      ".aih/evidence-bundle/manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        files: [{ path: "aih-skills.lock.json", bytes: 32 * 1024 * 1024, sha256: "0".repeat(64) }],
      }),
    );
    const d = skillGovernanceDigest(ctx());
    const data = d?.data as SkillGovData & {
      evidence?: { artifacts: number; current?: boolean; stale: boolean };
    };
    expect(data.evidence).toBeDefined();
    expect(data.evidence && "current" in data.evidence).toBe(false);
    expect(d?.text).toContain(
      "integrity not re-verified (large bundle; check: `aih verify-bundle`)",
    );
    expect(d?.text).not.toContain("internally consistent");
    // Not an issue → no rebuild hint from the consistency side (the lock is in sync here).
    expect(d?.text).not.toContain("rebuild:");
  });

  it("renders the evidence row only when the model carries it (byte-identical absent)", () => {
    const model = {
      installed: 1,
      approved: 1,
      unapproved: 0,
      stalePin: 0,
      quarantined: 0,
      rows: [],
    };
    const current = renderSkillGovernance({
      ...model,
      evidence: { artifacts: 14, current: true, stale: false },
    });
    expect(current).toContain("evidence bundle");
    expect(current).toContain("14 artifacts · internally consistent");
    const stale = renderSkillGovernance({
      ...model,
      evidence: { artifacts: 14, current: true, stale: true },
    });
    expect(stale).toContain("internally consistent · behind live skills lock");
    expect(renderSkillGovernance(model)).not.toContain("evidence bundle");
  });

  it("renders the marketplace row only when the model carries it (byte-identical absent)", () => {
    const model = {
      installed: 1,
      approved: 1,
      unapproved: 0,
      stalePin: 0,
      quarantined: 0,
      rows: [],
    };
    const withMp = renderSkillGovernance({
      ...model,
      marketplace: { skills: 2, findings: 0, signed: true },
    });
    expect(withMp).toContain("marketplace artifact");
    expect(withMp).toContain("2 skills · 0 findings · signature file present");
    const unsigned = renderSkillGovernance({
      ...model,
      marketplace: { skills: 2, findings: 3, signed: false },
    });
    expect(unsigned).toContain("3 findings · unsigned");
    expect(renderSkillGovernance(model)).not.toContain("marketplace artifact");
  });

  it("surfaces a valid org policy — live from the policy file alone", () => {
    put(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "team",
        references: { repoContract: `${DIR}/project.md` },
      }),
    );
    const d = skillGovernanceDigest(ctx());
    expect(d).toBeDefined();
    const data = d?.data as SkillGovData & {
      orgPolicy?: { present: true; valid: boolean; error?: string };
    };
    expect(data.orgPolicy).toEqual({ present: true, valid: true });
    // Presence + parse ONLY — the line routes the deep check to `policy validate`.
    expect(d?.text).toContain("org policy (aih-org-policy.json) — present · parses");
    expect(d?.text).toContain("deep validation: `aih policy validate`");
  });

  it("reports an invalid org policy with a sanitized, truncated first error line", () => {
    // Schema-invalid (missing references) + a bidi override smuggled into a value.
    put("aih-org-policy.json", JSON.stringify({ schemaVersion: 1, minimumPosture: "team\u202e" }));
    const d = skillGovernanceDigest(ctx());
    const data = d?.data as SkillGovData & {
      orgPolicy?: { present: true; valid: boolean; error?: string };
    };
    expect(data.orgPolicy?.present).toBe(true);
    expect(data.orgPolicy?.valid).toBe(false);
    expect(data.orgPolicy?.error).toBeDefined();
    expect(data.orgPolicy?.error).not.toContain("\u202e");
    expect((data.orgPolicy?.error ?? "").length).toBeLessThanOrEqual(160);
    expect(d?.text).toContain("INVALID:");
  });

  it("renders the org-policy row only when the model carries it (byte-identical absent)", () => {
    const model = {
      installed: 1,
      approved: 1,
      unapproved: 0,
      stalePin: 0,
      quarantined: 0,
      rows: [],
    };
    const valid = renderSkillGovernance({ ...model, orgPolicy: { present: true, valid: true } });
    expect(valid).toContain("org policy");
    expect(valid).toContain("valid (schema parse)");
    const invalid = renderSkillGovernance({
      ...model,
      orgPolicy: { present: true, valid: false, error: "org-policy is invalid: <bad & broken>" },
    });
    expect(invalid).toContain("invalid — org-policy is invalid: &lt;bad &amp; broken&gt;");
    expect(renderSkillGovernance(model)).not.toContain("org policy");
  });
});
