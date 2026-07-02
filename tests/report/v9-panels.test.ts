import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedBlock } from "../../src/bootstrap-ai/canon.js";
import { sha256Hex } from "../../src/bundle/index.js";
import { mergeManagedBlock } from "../../src/internals/markers.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
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
import { renderSkillGovernance } from "../../src/report/v9-render.js";
import type { SupportTemplate } from "../../src/support/render.js";

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

function ctx(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: DIR,
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: home, USERPROFILE: home },
    options: {},
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
  thirdParty: number;
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
  items: Array<{ name: string; scope: string; status: string; detail: string; when: string }>;
  cleared: number;
  runs: number;
  openOverTime: number[];
}

describe("winsDigest", () => {
  it("returns undefined when heal has never run", () => {
    ledger({ capability: "report", status: "success", startedAt: "2026-06-01T00:00:00Z" });
    expect(winsDigest(ctx())).toBeUndefined();
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
  rows: Array<{ name: string; status: string; source?: string; commit?: string }>;
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
    const html = renderSkillGovernance({
      installed: 1,
      approved: 1,
      unapproved: 0,
      stalePin: 0,
      quarantined: 0,
      rows: [{ name: "docs‮what", status: "approved", source: "a/b​x" }],
      packs: [{ name: "core‪evil", skills: 1, approved: 1 }],
    });
    expect(html).not.toContain("‮");
    expect(html).not.toContain("‪");
    expect(html).not.toContain("​");
    expect(html).toContain("docswhat");
    expect(html).toContain("pack coreevil");
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

  it("keeps a pack-free repo's digest byte-identical (no by-pack section, no packs key)", () => {
    put(`${DIR}/skills/src/clean/SKILL.md`, "# clean\n");
    put("aih-skills.lock.json", JSON.stringify({ schemaVersion: 1, skills: [lockEntry("clean")] }));
    const d = skillGovernanceDigest(ctx());
    // Exact pre-pack strings — the rollup must not perturb a repo with no pack tags.
    expect(d?.describe).toBe("Skill governance — 1 installed (1 approved, 0 unapproved, 0 stale)");
    expect(d?.text).toBe(
      "1 external skill installed · 1 approved · 0 unapproved · 0 stale-pin · 0 quarantined.\n\n  All 1 installed skill is approved and in sync.\n",
    );
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
});
