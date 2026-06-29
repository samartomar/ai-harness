import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedBlock } from "../../src/bootstrap-ai/canon.js";
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
  supportDigest,
  winsDigest,
} from "../../src/report/v9-panels.js";
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
  agents: number;
  skills: number;
  rules: number;
  hooks: number;
  packs: string[];
}

describe("eccInventoryDigest", () => {
  it("returns undefined when no ECC content is on disk", () => {
    expect(eccInventoryDigest(ctx())).toBeUndefined();
  });

  it("counts agents, skills (dirs) and hooks scanned from .claude/.kiro", () => {
    put(".claude/agents/code-reviewer.md", "# agent\n");
    put(".claude/agents/planner.md", "# agent\n");
    put(".claude/skills/tdd/SKILL.md", "# skill\n");
    put(".kiro/skills/review/SKILL.md", "# skill\n");
    put(
      ".claude/settings.json",
      JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: "*", hooks: [{ type: "command" }, { type: "command" }] }],
        },
      }),
    );
    const d = eccInventoryDigest(ctx());
    const data = d?.data as EccData;
    expect(data.agents).toBe(2);
    expect(data.skills).toBe(2); // one dir under each of .claude/skills and .kiro/skills
    expect(data.hooks).toBe(2);
    expect(Array.isArray(data.packs)).toBe(true);
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
