import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ClaudeContaminationReport,
  claudeContaminationReport,
} from "../../../../src/binding/hosts/claude/contamination.js";

let home: string;
let projectRoot: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aih-contam-home-"));
  projectRoot = mkdtempSync(join(tmpdir(), "aih-contam-proj-"));
});

afterEach(() => {
  for (const dir of [home, projectRoot]) rmSync(dir, { recursive: true, force: true });
});

/** Write a file under `home`, creating parent dirs. `rel` is a POSIX path. */
function seed(rel: string, contents: string): void {
  const abs = join(home, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents, "utf8");
}

function seedJson(rel: string, value: unknown): void {
  seed(rel, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The canonical polluted laptop shape: a global ECC install (rules/skills/agents)
 * plus a globally enabled Superpowers plugin (enabledPlugins entry + a plugin
 * cache is modeled elsewhere), an ECC MCP server in settings, a Superpowers MCP
 * server in ~/.mcp.json, an ECC hook, and an informational skillOverride.
 */
function seedPollutedLaptop(): void {
  // ECC rules — one top-level dir, counted once.
  seed(".claude/rules/ecc/RULES.md", "# ecc rules\n");
  seed(".claude/rules/ecc/policy/strict.md", "# nested policy\n");
  // ECC skills — two top-level skills; one has nested content (counted once).
  seed(".claude/skills/ecc-review/SKILL.md", "# ecc review\n");
  seed(".claude/skills/ecc-review/refs/deep.md", "# nested ref\n");
  seed(".claude/skills/ecc-plan/SKILL.md", "# ecc plan\n");
  // ECC agents — two markdown agents.
  seed(".claude/agents/ecc-architect.md", "# architect\n");
  seed(".claude/agents/ecc-tester.md", "# tester\n");
  // settings.json — superpowers plugin, ecc hook, ecc mcp server, skillOverride.
  seedJson(".claude/settings.json", {
    enabledPlugins: { "superpowers@obra": true },
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: "~/.claude/rules/ecc/hooks/pre.sh" }],
        },
      ],
    },
    mcpServers: { "ecc-memory": { command: "ecc-mcp" } },
    skillOverrides: { "code-review": "superpowers/code-review" },
    telemetry: false,
  });
  // ~/.mcp.json — a superpowers MCP server at user scope.
  seedJson(".mcp.json", { mcpServers: { "superpowers-mcp": { command: "sp-serve" } } });
}

function bySurface(report: ClaudeContaminationReport, surface: string): string[] {
  return report.entries.filter((e) => e.surface === surface).map((e) => e.name);
}

describe("claudeContaminationReport — polluted laptop fixture", () => {
  it("counts every user-scope surface exactly with correct attributions", () => {
    seedPollutedLaptop();
    const report = claudeContaminationReport({ home, projectRoot });

    expect(report.leakage).toEqual({
      skills: 2,
      agents: 2,
      hooks: 1,
      rules: 1,
      plugins: 1,
      mcpServers: 2,
    });
    expect(report.clean).toBe(false);
    expect(report.verdictInput).toBe("contaminated");
    expect(report.warnings).toEqual([]);

    // Attributions.
    for (const e of report.entries.filter((x) => x.surface === "skill")) {
      expect(e.attribution).toBe("ecc");
    }
    expect(bySurface(report, "skill").sort()).toEqual(["ecc-plan", "ecc-review"]);
    expect(bySurface(report, "agent").sort()).toEqual(["ecc-architect.md", "ecc-tester.md"]);
    expect(bySurface(report, "rule")).toEqual(["ecc"]);
    const plugin = report.entries.find((e) => e.surface === "plugin");
    expect(plugin?.name).toBe("superpowers@obra");
    expect(plugin?.attribution).toBe("superpowers");
    const hook = report.entries.find((e) => e.surface === "hook");
    expect(hook?.attribution).toBe("ecc");
    const mcp = report.entries.filter((e) => e.surface === "mcpServer");
    expect(mcp.map((e) => e.name).sort()).toEqual(["ecc-memory", "superpowers-mcp"]);
    expect(mcp.find((e) => e.name === "ecc-memory")?.attribution).toBe("ecc");
    expect(mcp.find((e) => e.name === "superpowers-mcp")?.attribution).toBe("superpowers");
  });

  it("counts a nested skill directory once at the top level", () => {
    seedPollutedLaptop();
    const report = claudeContaminationReport({ home, projectRoot });
    expect(report.leakage.skills).toBe(2);
    // The nested ref dir is not double-counted.
    expect(bySurface(report, "skill")).not.toContain("refs");
  });

  it("surfaces skillOverrides as informational, not counted in leakage", () => {
    seedPollutedLaptop();
    const report = claudeContaminationReport({ home, projectRoot });
    expect(report.informational.skillOverrides).toEqual(["code-review"]);
  });

  it("home-relative POSIX paths carry no backslashes and point into the user scope", () => {
    seedPollutedLaptop();
    const report = claudeContaminationReport({ home, projectRoot });
    for (const e of report.entries) {
      expect(e.path.includes("\\")).toBe(false);
      expect(e.path.startsWith(".claude/") || e.path === ".mcp.json").toBe(true);
    }
  });
});

describe("claudeContaminationReport — clean home", () => {
  it("reports all zeros and clean:true", () => {
    const report = claudeContaminationReport({ home, projectRoot });
    expect(report.leakage).toEqual({
      skills: 0,
      agents: 0,
      hooks: 0,
      rules: 0,
      plugins: 0,
      mcpServers: 0,
    });
    expect(report.clean).toBe(true);
    expect(report.verdictInput).toBe("clean");
    expect(report.entries).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.informational.skillOverrides).toEqual([]);
  });
});

describe("claudeContaminationReport — host-scaffolded empty skill directories", () => {
  it("does not count a contentless immediate directory under ~/.claude/skills/ (host-scaffolded skills/learned)", () => {
    // The Claude CLI scaffolds an EMPTY `skills/learned/` on its own (observed
    // live on 2.1.214–2.1.218 during the W8 acceptance run): a contentless
    // directory is not loadable material and must not dirty a pristine home.
    mkdirSync(join(home, ".claude", "skills", "learned"), { recursive: true });
    const report = claudeContaminationReport({ home, projectRoot });
    expect(report.leakage.skills).toBe(0);
    expect(report.clean).toBe(true);
    expect(report.entries).toEqual([]);
  });

  it("still counts skills/learned the moment anything lands inside it", () => {
    // ECC's legacy continuous-learning defaults its write path to
    // `${HOME}/.claude/skills/learned` (DECISIONS-LOCKED, ECC Full label note);
    // content inside the scaffold must stay visible leakage.
    seed(".claude/skills/learned/instinct.md", "# learned instinct\n");
    const report = claudeContaminationReport({ home, projectRoot });
    expect(report.leakage.skills).toBe(1);
    expect(report.entries.map((e) => e.path)).toEqual([".claude/skills/learned"]);
    expect(report.clean).toBe(false);
  });
});

describe("claudeContaminationReport — malformed user-scope JSON does not crash", () => {
  it("records a warning naming settings.json and still counts other surfaces", () => {
    // Readable surfaces around a broken settings.json.
    seed(".claude/skills/ecc-review/SKILL.md", "# ecc\n");
    seed(".claude/agents/ecc-architect.md", "# a\n");
    seed(".claude/rules/ecc/RULES.md", "# r\n");
    seedJson(".mcp.json", { mcpServers: { "superpowers-mcp": { command: "sp" } } });
    // Broken settings.json (truncated object).
    seed(".claude/settings.json", '{ "enabledPlugins": { ');

    const report = claudeContaminationReport({ home, projectRoot });
    expect(report.warnings.some((w) => w.includes("settings.json"))).toBe(true);
    // Surfaces outside the broken file are still counted.
    expect(report.leakage.skills).toBe(1);
    expect(report.leakage.agents).toBe(1);
    expect(report.leakage.rules).toBe(1);
    expect(report.leakage.mcpServers).toBe(1);
    // The unreadable file contributes nothing.
    expect(report.leakage.plugins).toBe(0);
    expect(report.leakage.hooks).toBe(0);
    expect(report.clean).toBe(false);
  });

  it("records a warning naming .mcp.json when it is malformed", () => {
    seed(".mcp.json", "{ not json");
    const report = claudeContaminationReport({ home, projectRoot });
    expect(report.warnings.some((w) => w.includes(".mcp.json"))).toBe(true);
    expect(report.leakage.mcpServers).toBe(0);
  });
});

describe("claudeContaminationReport — project scope is never read", () => {
  it("a project-scope surface never appears in the user-scope report", () => {
    // Pollute the PROJECT root, leave home clean.
    const projSkill = join(projectRoot, ".claude", "skills", "proj-skill", "SKILL.md");
    mkdirSync(dirname(projSkill), { recursive: true });
    writeFileSync(projSkill, "# project skill\n", "utf8");

    const report = claudeContaminationReport({ home, projectRoot });
    expect(report.clean).toBe(true);
    expect(report.leakage.skills).toBe(0);
    expect(report.entries.find((e) => e.name === "proj-skill")).toBeUndefined();
  });
});

// -- current-layout ECC machine roots (`~/.claude/ecc/`, `agents/ecc/`) ----------

describe("claudeContaminationReport — current-layout ECC machine install", () => {
  it("flags a skills-only ECC install living solely under ~/.claude/ecc/ (no legacy namespace)", () => {
    // No SKILL.md required: machineEccSkillNames (report/v9-panels.ts) counts
    // immediate directories, and this scan mirrors it.
    mkdirSync(join(home, ".claude", "ecc", "skills", "planning"), { recursive: true });
    mkdirSync(join(home, ".claude", "ecc", ".agents", "skills", "tdd"), { recursive: true });
    seed(".claude/agents/ecc/reviewer.md", "# reviewer\n");

    const report = claudeContaminationReport({ home, projectRoot });

    expect(report.clean).toBe(false);
    expect(report.verdictInput).toBe("contaminated");
    expect(report.leakage.skills).toBe(2);
    expect(report.leakage.agents).toBe(1);
    expect(bySurface(report, "skill").sort()).toEqual(["planning", "tdd"]);
    const skillPaths = report.entries
      .filter((e) => e.surface === "skill")
      .map((e) => e.path)
      .sort();
    expect(skillPaths).toEqual([".claude/ecc/.agents/skills/tdd", ".claude/ecc/skills/planning"]);
    expect(report.entries.every((e) => e.surface !== "skill" || e.attribution === "ecc")).toBe(
      true,
    );
    const agent = report.entries.find((e) => e.surface === "agent");
    expect(agent).toEqual({
      surface: "agent",
      name: "ecc/reviewer.md",
      path: ".claude/agents/ecc/reviewer.md",
      attribution: "ecc",
    });
  });

  it("name-dedupes a skill present in both current ECC roots (canon: machineEccSkillNames)", () => {
    mkdirSync(join(home, ".claude", "ecc", "skills", "planning"), { recursive: true });
    mkdirSync(join(home, ".claude", "ecc", ".agents", "skills", "planning"), { recursive: true });

    const report = claudeContaminationReport({ home, projectRoot });

    expect(report.leakage.skills).toBe(1);
    expect(report.entries.find((e) => e.surface === "skill")?.path).toBe(
      ".claude/ecc/skills/planning",
    );
  });

  it("name-dedupes a current-root skill against the same name under ~/.claude/skills/", () => {
    seed(".claude/skills/planning/SKILL.md", "# planning\n");
    mkdirSync(join(home, ".claude", "ecc", "skills", "planning"), { recursive: true });

    const report = claudeContaminationReport({ home, projectRoot });

    expect(report.leakage.skills).toBe(1);
    expect(report.entries.find((e) => e.surface === "skill")?.path).toBe(".claude/skills/planning");
  });
});
