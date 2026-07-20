import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildCostGateRecord,
  type CostGateVariantMeasurement,
  measureCostGateVariant,
} from "../../../src/binding/frameworks/cost-gate.js";
import { ClaudeHostWriteError } from "../../../src/binding/hosts/claude/surfaces.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "aih-cost-gate-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Materialize a tree of `{ relPath: contents }` under a fresh dir and return its absolute path. */
function tree(name: string, files: Record<string, string>): string {
  const dir = join(scratch, name);
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return dir;
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

describe("measureCostGateVariant", () => {
  it("returns an all-zero baseline measurement for no tree paths (no I/O)", () => {
    const measurement = measureCostGateVariant("baseline", []);
    expect(measurement).toEqual({
      variant: "baseline",
      counts: { skills: 0, agents: 0, commands: 0, rules: 0, hooks: 0, mcpServers: 0 },
      metadataBytes: 0,
      ruleBytes: 0,
      totalBytes: 0,
      projectedTokens: 0,
      evidence: "aih static tree measurement",
    });
    expect(measurement.runtime).toBeUndefined();
  });

  it("aggregates counts/bytes/tokens across multiple lean component roots", () => {
    const RULE_CORE = "# core rule\n";
    const RULE_NESTED = "# nested rule\n";
    const AGENT_PLANNER = "# planner agent\n";
    const SKILL_TDD = "# tdd skill\n\nDoes tdd things.\n";

    const rulesRoot = tree("rules-component", {
      "rules/core.md": RULE_CORE,
      "rules/nested/sub.md": RULE_NESTED,
    });
    const agentRoot = tree("agent-component", { "agents/planner.md": AGENT_PLANNER });
    const skillRoot = tree("skill-component", { "skills/tdd/SKILL.md": SKILL_TDD });

    const measurement = measureCostGateVariant("lean", [rulesRoot, agentRoot, skillRoot]);

    const ruleBytes = byteLen(RULE_CORE) + byteLen(RULE_NESTED);
    const metadataBytes = byteLen(AGENT_PLANNER) + byteLen(SKILL_TDD);
    const totalBytes = ruleBytes + metadataBytes;
    const projectedTokens =
      Math.round(ruleBytes / 4) +
      Math.round(byteLen(AGENT_PLANNER) / 4) +
      Math.round(byteLen(SKILL_TDD) / 4);

    expect(measurement).toEqual({
      variant: "lean",
      counts: { skills: 1, agents: 1, commands: 0, rules: 2, hooks: 0, mcpServers: 0 },
      metadataBytes,
      ruleBytes,
      totalBytes,
      projectedTokens,
      evidence: "aih static tree measurement",
    });
  });

  it("measures a single mixed full plugin tree, separating metadata/rule bytes from the combined total", () => {
    const SKILL_ALPHA = "# alpha skill\n\nDoes alpha things.\n";
    const SKILL_BETA = "# beta skill\n\nDoes beta things.\n";
    const AGENT_REVIEWER = "# reviewer agent\n";
    const COMMAND_DEPLOY = "# deploy command\n";
    const RULE_CORE = "# core rule\n";
    const RULE_NESTED = "# nested rule\n";
    const HOOKS_JSON = JSON.stringify({
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo pre" }] }],
      PostToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: "echo post1" }] },
        { matcher: "Bash", hooks: [{ type: "command", command: "echo post2" }] },
      ],
    });
    const MCP_JSON = JSON.stringify({
      mcpServers: {
        "server-a": { command: "node", args: ["a.js"] },
        "server-b": { command: "node", args: ["b.js"] },
      },
    });

    const pluginRoot = tree("full-plugin", {
      "skills/alpha/SKILL.md": SKILL_ALPHA,
      "skills/beta/SKILL.md": SKILL_BETA,
      "agents/reviewer.md": AGENT_REVIEWER,
      "commands/deploy.md": COMMAND_DEPLOY,
      "rules/core.md": RULE_CORE,
      "rules/nested/sub.md": RULE_NESTED,
      "hooks/hooks.json": HOOKS_JSON,
      ".mcp.json": MCP_JSON,
    });

    const measurement = measureCostGateVariant("full", [pluginRoot]);

    const ruleBytes = byteLen(RULE_CORE) + byteLen(RULE_NESTED);
    const metadataBytes = byteLen(SKILL_ALPHA) + byteLen(SKILL_BETA) + byteLen(AGENT_REVIEWER);
    const totalBytes =
      metadataBytes + byteLen(COMMAND_DEPLOY) + ruleBytes + byteLen(HOOKS_JSON) + byteLen(MCP_JSON);

    expect(measurement.variant).toBe("full");
    expect(measurement.counts).toEqual({
      skills: 2,
      agents: 1,
      commands: 1,
      rules: 2,
      hooks: 3,
      mcpServers: 2,
    });
    expect(measurement.totalBytes).toBe(totalBytes);
    // metadata/rule bytes are a NARROWER slice than totalBytes here — the mixed
    // tree also carries command/hook/mcp bytes that belong to neither bucket.
    expect(measurement.metadataBytes).toBe(metadataBytes);
    expect(measurement.ruleBytes).toBe(ruleBytes);
    expect(measurement.metadataBytes + measurement.ruleBytes).toBeLessThan(measurement.totalBytes);
    expect(measurement.projectedTokens).toBe(Math.round(totalBytes / 4));
  });

  it("throws the shared ClaudeHostWriteError for a missing tree path (fail closed)", () => {
    expect(() => measureCostGateVariant("lean", [join(scratch, "does-not-exist")])).toThrow(
      ClaudeHostWriteError,
    );
  });

  it("throws for a tree path that is a file, not a directory", () => {
    const filePath = join(scratch, "a-file");
    writeFileSync(filePath, "not a dir", "utf8");
    expect(() => measureCostGateVariant("full", [filePath])).toThrow(ClaudeHostWriteError);
  });
});

describe("buildCostGateRecord", () => {
  function measurement(
    variant: CostGateVariantMeasurement["variant"],
    projectedTokens: number | undefined,
  ): CostGateVariantMeasurement {
    return {
      variant,
      counts: { skills: 0, agents: 0, commands: 0, rules: 0, hooks: 0, mcpServers: 0 },
      metadataBytes: 0,
      ruleBytes: 0,
      totalBytes: 0,
      ...(projectedTokens === undefined ? {} : { projectedTokens }),
      evidence: "aih static tree measurement",
    };
  }

  it("computes projectedTokens deltas across baseline/lean/full", () => {
    const record = buildCostGateRecord(
      measurement("baseline", 100),
      measurement("lean", 900),
      measurement("full", 5000),
    );
    expect(record.deltas).toEqual({ leanVsBaseline: 800, fullVsBaseline: 4900, fullVsLean: 4100 });
    expect(record.verdict).toBe("no-budget-set");
    expect(record.budget).toBeUndefined();
    expect("budget" in record).toBe(false);
  });

  it("defaults an absent projectedTokens to 0 for delta math (never NaN)", () => {
    const record = buildCostGateRecord(
      measurement("baseline", undefined),
      measurement("lean", 500),
      measurement("full", undefined),
    );
    expect(record.deltas).toEqual({ leanVsBaseline: 500, fullVsBaseline: 0, fullVsLean: -500 });
  });

  it("verdict is within-budget when lean tokens are at or under the budget", () => {
    const atBudget = buildCostGateRecord(
      measurement("baseline", 0),
      measurement("lean", 1000),
      measurement("full", 5000),
      { leanTokenBudget: 1000, approvedBy: "maintainer", approvedOn: "2026-07-01" },
    );
    expect(atBudget.verdict).toBe("within-budget");

    const underBudget = buildCostGateRecord(
      measurement("baseline", 0),
      measurement("lean", 900),
      measurement("full", 5000),
      { leanTokenBudget: 1000, approvedBy: "maintainer", approvedOn: "2026-07-01" },
    );
    expect(underBudget.verdict).toBe("within-budget");
  });

  it("verdict is over-budget when lean tokens exceed the budget", () => {
    const record = buildCostGateRecord(
      measurement("baseline", 0),
      measurement("lean", 1001),
      measurement("full", 5000),
      { leanTokenBudget: 1000, approvedBy: "maintainer", approvedOn: "2026-07-01" },
    );
    expect(record.verdict).toBe("over-budget");
    expect(record.budget).toEqual({
      leanTokenBudget: 1000,
      approvedBy: "maintainer",
      approvedOn: "2026-07-01",
    });
  });

  it("round-trips through JSON with a budget present", () => {
    const record = buildCostGateRecord(
      measurement("baseline", 100),
      measurement("lean", 900),
      measurement("full", 5000),
      { leanTokenBudget: 1000, approvedBy: "maintainer", approvedOn: "2026-07-01" },
    );
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });

  it("round-trips through JSON with no budget (the key stays absent, not null)", () => {
    const record = buildCostGateRecord(
      measurement("baseline", 100),
      measurement("lean", 900),
      measurement("full", 5000),
    );
    const roundTripped = JSON.parse(JSON.stringify(record));
    expect(roundTripped).toEqual(record);
    expect(Object.keys(roundTripped)).not.toContain("budget");
  });
});
