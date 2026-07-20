import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  contextCostFromPluginDetails,
  contextCostFromPluginDetailsText,
  estimateContextCostFromTree,
} from "../../../../src/binding/hosts/claude/context-cost.js";
import { ClaudeHostWriteError } from "../../../../src/binding/hosts/claude/surfaces.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "aih-claude-ctxcost-"));
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

describe("estimateContextCostFromTree", () => {
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

  function fullFixture(name: string): string {
    return tree(name, {
      "skills/alpha/SKILL.md": SKILL_ALPHA,
      "skills/beta/SKILL.md": SKILL_BETA,
      "agents/reviewer.md": AGENT_REVIEWER,
      "commands/deploy.md": COMMAND_DEPLOY,
      "rules/core.md": RULE_CORE,
      "rules/nested/sub.md": RULE_NESTED,
      "hooks/hooks.json": HOOKS_JSON,
      ".mcp.json": MCP_JSON,
    });
  }

  it("counts every surface, sums bytes, and projects tokens as round(bytes/4)", () => {
    const dir = fullFixture("full");
    const report = estimateContextCostFromTree(dir);

    const expectedBytes =
      byteLen(SKILL_ALPHA) +
      byteLen(SKILL_BETA) +
      byteLen(AGENT_REVIEWER) +
      byteLen(COMMAND_DEPLOY) +
      byteLen(RULE_CORE) +
      byteLen(RULE_NESTED) +
      byteLen(HOOKS_JSON) +
      byteLen(MCP_JSON);

    expect(report).toEqual({
      source: "aih-estimate",
      evidence: "aih static tree estimate (bytes/4)",
      projectedTokens: Math.round(expectedBytes / 4),
      counts: { skills: 2, agents: 1, commands: 1, rules: 2, hooks: 3, mcpServers: 2 },
      totalBytes: expectedBytes,
      estimate: true,
    });
  });

  it("counts skills via the top-level */SKILL.md layout when there is no skills/ dir", () => {
    const dir = tree("toplevel-skills", {
      "gamma/SKILL.md": "# gamma\n",
      "delta/SKILL.md": "# delta\n",
    });
    const report = estimateContextCostFromTree(dir);
    expect(report.counts.skills).toBe(2);
  });

  it("returns all-zero counts for an empty directory without throwing", () => {
    const dir = join(scratch, "empty");
    mkdirSync(dir, { recursive: true });
    const report = estimateContextCostFromTree(dir);
    expect(report).toEqual({
      source: "aih-estimate",
      evidence: "aih static tree estimate (bytes/4)",
      projectedTokens: 0,
      counts: { skills: 0, agents: 0, commands: 0, rules: 0, hooks: 0, mcpServers: 0 },
      totalBytes: 0,
      estimate: true,
    });
  });

  it("counts nested rules/**/*.md files recursively", () => {
    const dir = tree("nested-rules", {
      "rules/a.md": "a",
      "rules/group/b.md": "b",
      "rules/group/deep/c.md": "c",
    });
    const report = estimateContextCostFromTree(dir);
    expect(report.counts.rules).toBe(3);
  });

  it("fails closed on a missing tree path", () => {
    expect(() => estimateContextCostFromTree(join(scratch, "does-not-exist"))).toThrow(
      ClaudeHostWriteError,
    );
  });

  it("fails closed when the tree path is a file, not a directory", () => {
    const filePath = join(scratch, "a-file");
    writeFileSync(filePath, "not a dir", "utf8");
    expect(() => estimateContextCostFromTree(filePath)).toThrow(ClaudeHostWriteError);
  });

  it("fails closed on malformed hooks/hooks.json", () => {
    const dir = tree("bad-hooks", { "hooks/hooks.json": "{ not: valid json" });
    expect(() => estimateContextCostFromTree(dir)).toThrow(ClaudeHostWriteError);
  });

  it("fails closed when a hooks.json event value is not an array", () => {
    const dir = tree("bad-hooks-shape", {
      "hooks/hooks.json": JSON.stringify({ PreToolUse: "not-an-array" }),
    });
    expect(() => estimateContextCostFromTree(dir)).toThrow(ClaudeHostWriteError);
  });

  it("fails closed on malformed .mcp.json", () => {
    const dir = tree("bad-mcp", { ".mcp.json": "{ not: valid json" });
    expect(() => estimateContextCostFromTree(dir)).toThrow(ClaudeHostWriteError);
  });

  it("fails closed when mcpServers is present but not an object", () => {
    const dir = tree("bad-mcp-shape", { ".mcp.json": JSON.stringify({ mcpServers: ["oops"] }) });
    expect(() => estimateContextCostFromTree(dir)).toThrow(ClaudeHostWriteError);
  });

  it("falls back to mcp.json when .mcp.json is absent", () => {
    const dir = tree("mcp-fallback", {
      "mcp.json": JSON.stringify({ mcpServers: { one: {}, two: {}, three: {} } }),
    });
    const report = estimateContextCostFromTree(dir);
    expect(report.counts.mcpServers).toBe(3);
  });
});

describe("contextCostFromPluginDetails", () => {
  it("counts full components, marks host-reported, and passes through a numeric projectedTokens", () => {
    const report = contextCostFromPluginDetails({
      components: {
        skills: [{ name: "a" }, { name: "b" }],
        agents: [{ name: "r" }],
        commands: [{ name: "d" }],
        hooks: [{ event: "PreToolUse" }, { event: "PostToolUse" }, { event: "PreToolUse" }],
        mcpServers: [{ name: "server-a" }, { name: "server-b" }],
      },
      projectedTokens: 4200,
    });
    expect(report).toEqual({
      source: "host-reported",
      evidence: "claude plugin details",
      projectedTokens: 4200,
      counts: { skills: 2, agents: 1, commands: 1, rules: 0, hooks: 3, mcpServers: 2 },
      totalBytes: 0,
      estimate: false,
    });
  });

  it("passes through a { total } shaped projectedTokens", () => {
    const report = contextCostFromPluginDetails({ projectedTokens: { total: 999 } });
    expect(report.projectedTokens).toBe(999);
    expect(report.counts).toEqual({
      skills: 0,
      agents: 0,
      commands: 0,
      rules: 0,
      hooks: 0,
      mcpServers: 0,
    });
  });

  it("leaves projectedTokens undefined for a partial (components-only) payload — no fabrication", () => {
    const report = contextCostFromPluginDetails({ components: { skills: [{}, {}, {}] } });
    expect(report.projectedTokens).toBeUndefined();
    expect(report.counts).toEqual({
      skills: 3,
      agents: 0,
      commands: 0,
      rules: 0,
      hooks: 0,
      mcpServers: 0,
    });
    expect(report.source).toBe("host-reported");
    expect(report.estimate).toBe(false);
  });

  describe("rejects an unrecognized payload", () => {
    const cases: Array<[string, unknown]> = [
      ["undefined", undefined],
      ["null", null],
      ["a string", "garbage"],
      ["a number", 42],
      ["an array", [1, 2, 3]],
      ["an empty object", {}],
    ];
    it.each(cases)("rejects %s", (_label, payload) => {
      expect(() => contextCostFromPluginDetails(payload)).toThrow(ClaudeHostWriteError);
    });
  });

  describe("rejects a non-array components.<key>", () => {
    const cases: Array<[string, unknown]> = [
      ["skills", { components: { skills: "oops" } }],
      ["agents", { components: { agents: {} } }],
      ["commands", { components: { commands: 5 } }],
      ["hooks", { components: { hooks: "x" } }],
      ["mcpServers", { components: { mcpServers: null } }],
    ];
    it.each(cases)("rejects non-array components.%s", (_key, payload) => {
      expect(() => contextCostFromPluginDetails(payload)).toThrow(ClaudeHostWriteError);
    });
  });

  it("rejects a components value that is not itself an object", () => {
    expect(() => contextCostFromPluginDetails({ components: "oops" })).toThrow(
      ClaudeHostWriteError,
    );
    expect(() => contextCostFromPluginDetails({ components: [1, 2, 3] })).toThrow(
      ClaudeHostWriteError,
    );
  });

  it("rejects a non-finite projectedTokens", () => {
    expect(() => contextCostFromPluginDetails({ projectedTokens: Number.NaN })).toThrow(
      ClaudeHostWriteError,
    );
    expect(() =>
      contextCostFromPluginDetails({ projectedTokens: Number.POSITIVE_INFINITY }),
    ).toThrow(ClaudeHostWriteError);
  });
});

describe("contextCostFromPluginDetailsText (empirically corrected: `claude plugin details` has no --json flag)", () => {
  const FULL_TEXT = [
    "Superpowers v1.0.0",
    "",
    "Skills (2)",
    "  - brainstorming",
    "  - writing-plans",
    "",
    "Agents (1)",
    "  - reviewer",
    "",
    "Hooks (3)",
    "  - PreToolUse",
    "",
    "MCP servers (2)",
    "  - server-a",
    "",
    "LSP servers (1)",
    "  - typescript",
    "",
    "Always-on:   ~27 tok",
    "",
  ].join("\n");

  it("parses the full component inventory and the Always-on token line", () => {
    const report = contextCostFromPluginDetailsText(FULL_TEXT);
    expect(report).toEqual({
      source: "host-reported",
      evidence: "claude plugin details (text)",
      projectedTokens: 27,
      counts: { skills: 2, agents: 1, commands: 0, rules: 0, hooks: 3, mcpServers: 2 },
      totalBytes: 0,
      estimate: false,
    });
  });

  it("counts absent categories as zero (per-category optionality, like the JSON-payload sibling)", () => {
    const text = "Skills (1)\n  - solo-skill\n\nAlways-on:   ~10 tok\n";
    const report = contextCostFromPluginDetailsText(text);
    expect(report.counts).toEqual({
      skills: 1,
      agents: 0,
      commands: 0,
      rules: 0,
      hooks: 0,
      mcpServers: 0,
    });
    expect(report.projectedTokens).toBe(10);
  });

  it("leaves projectedTokens undefined when the Always-on line is absent — no fabrication", () => {
    const text = "Skills (1)\n  - solo-skill\n";
    const report = contextCostFromPluginDetailsText(text);
    expect(report.projectedTokens).toBeUndefined();
    expect(report.counts.skills).toBe(1);
    expect(report.source).toBe("host-reported");
    expect(report.estimate).toBe(false);
  });

  it("succeeds on an Always-on line alone (no component headers) — all counts zero, tokens present", () => {
    const report = contextCostFromPluginDetailsText("Always-on:   ~5 tok\n");
    expect(report.projectedTokens).toBe(5);
    expect(report.counts).toEqual({
      skills: 0,
      agents: 0,
      commands: 0,
      rules: 0,
      hooks: 0,
      mcpServers: 0,
    });
  });

  it("is tolerant of case and header naming variance (MCP Servers vs MCP servers)", () => {
    const report = contextCostFromPluginDetailsText("MCP Servers (4)\n\nAlways-On:   ~1 tok\n");
    expect(report.counts.mcpServers).toBe(4);
  });

  describe("rejects unrecognized text — never fabricates a report", () => {
    const cases: Array<[string, string]> = [
      ["empty string", ""],
      ["unrelated prose", "This plugin does not have any structured output at all.\n"],
      ["whitespace only", "   \n\n  \n"],
    ];
    it.each(cases)("rejects %s", (_label, text) => {
      expect(() => contextCostFromPluginDetailsText(text)).toThrow(ClaudeHostWriteError);
    });

    it("rejects a non-string input", () => {
      expect(() => contextCostFromPluginDetailsText(42 as unknown as string)).toThrow(
        ClaudeHostWriteError,
      );
    });
  });
});
