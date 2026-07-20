import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyClaudeCleanup,
  ClaudeCleanupError,
  planClaudeCleanup,
  rollbackClaudeCleanup,
} from "../../../../src/binding/hosts/claude/cleanup.js";
import {
  type ClaudeContaminationReport,
  claudeContaminationReport,
} from "../../../../src/binding/hosts/claude/contamination.js";

let home: string;
let projectRoot: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aih-cleanup-home-"));
  projectRoot = mkdtempSync(join(tmpdir(), "aih-cleanup-proj-"));
});

afterEach(() => {
  for (const dir of [home, projectRoot]) rmSync(dir, { recursive: true, force: true });
});

function seed(rel: string, contents: string): void {
  const abs = join(home, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents, "utf8");
}

function seedJson(rel: string, value: unknown): void {
  seed(rel, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, ...rel.split("/")), "utf8")) as Record<string, unknown>;
}

function report(): ClaudeContaminationReport {
  return claudeContaminationReport({ home, projectRoot });
}

/** All framework-attributed pollution (no unknown surfaces) — cleans to a clean report. */
function seedFrameworkPollution(): void {
  seed(".claude/rules/ecc/RULES.md", "# ecc rules\n");
  seed(".claude/rules/ecc/policy/strict.md", "# nested\n");
  seed(".claude/skills/ecc-review/SKILL.md", "# ecc review\n");
  seed(".claude/skills/ecc-review/refs/deep.md", "# nested\n");
  seed(".claude/skills/ecc-plan/SKILL.md", "# ecc plan\n");
  seed(".claude/agents/ecc-architect.md", "# architect\n");
  seedJson(".claude/settings.json", {
    enabledPlugins: { "superpowers@obra": true },
    hooks: {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: "~/.claude/rules/ecc/hooks/pre.sh" }] },
      ],
    },
    mcpServers: { "ecc-memory": { command: "ecc-mcp" } },
    skillOverrides: { "code-review": "superpowers/code-review" },
    telemetry: false,
  });
  seedJson(".mcp.json", { mcpServers: { "superpowers-mcp": { command: "sp" } } });
}

/** Sha256 hex of a file's bytes. */
function digest(abs: string): string {
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

/** Snapshot (relpath -> digest) for every file under `abs`, keyed by home-relative POSIX path. */
function snapshotTree(relRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (rel: string): void => {
    const abs = join(home, ...rel.split("/"));
    if (!existsSync(abs)) return;
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) walk(`${rel}/${name}`);
    } else if (st.isFile()) {
      out.set(rel, digest(abs));
    }
  };
  walk(relRoot);
  return out;
}

describe("planClaudeCleanup — preview shape and safety", () => {
  it("includes only framework-attributed surfaces by default; never whole-settings removal", () => {
    seedFrameworkPollution();
    // An UNKNOWN surface that must be excluded by default.
    seed(".claude/skills/random-notes/SKILL.md", "# personal notes\n");

    const plan = planClaudeCleanup(report());
    expect(plan.schemaVersion).toBe(1);
    expect(plan.includeUnknown).toBe(false);

    // The unknown skill is skipped, not planned.
    expect(plan.steps.find((s) => s.path === ".claude/skills/random-notes")).toBeUndefined();
    expect(plan.skipped.find((s) => s.path === ".claude/skills/random-notes")).toBeDefined();

    // No step ever removes a whole shared JSON file.
    for (const s of plan.steps) {
      if (s.action === "backup-then-remove") {
        expect(s.path).not.toBe(".claude/settings.json");
        expect(s.path).not.toBe(".mcp.json");
        expect(
          s.path.startsWith(".claude/skills/") ||
            s.path.startsWith(".claude/agents/") ||
            s.path.startsWith(".claude/rules/"),
        ).toBe(true);
      } else {
        // disable steps carry a targeted key/hook edit, never a whole-file delete.
        expect([".claude/settings.json", ".mcp.json"]).toContain(s.path);
        expect(s.edit).toBeDefined();
      }
    }

    // The framework-attributed surfaces are all planned.
    const plugin = plan.steps.find((s) => s.surface === "plugin");
    expect(plugin?.edit).toEqual({
      kind: "json-key",
      container: "enabledPlugins",
      key: "superpowers@obra",
    });
    const hook = plan.steps.find((s) => s.surface === "hook");
    expect(hook?.edit).toMatchObject({ kind: "hook", event: "PreToolUse" });
  });

  it("includeUnknown widens the plan to unknown surfaces", () => {
    seedFrameworkPollution();
    seed(".claude/skills/random-notes/SKILL.md", "# personal notes\n");

    const plan = planClaudeCleanup(report(), { includeUnknown: true });
    expect(plan.includeUnknown).toBe(true);
    expect(plan.steps.find((s) => s.path === ".claude/skills/random-notes")).toBeDefined();
    expect(plan.skipped).toEqual([]);
  });

  it("is JSON-serializable", () => {
    seedFrameworkPollution();
    const plan = planClaudeCleanup(report());
    expect(() => JSON.parse(JSON.stringify(plan))).not.toThrow();
  });
});

describe("applyClaudeCleanup — backup + manifest are written BEFORE any removal", () => {
  it("a step failure after the manifest leaves backup + manifest intact and nothing removed", () => {
    seedFrameworkPollution();
    const plan = planClaudeCleanup(report());

    // Fail on the very first destructive step: nothing should be removed yet.
    const result = applyClaudeCleanup(plan, {
      home,
      runId: "run-fail-0",
      beforeStep: (_step, index) => {
        if (index === 0) throw new Error("injected step failure");
      },
    });

    expect(result.status).toBe("failed");
    expect(result.completed).toEqual([]);
    expect(result.pending.length).toBe(plan.steps.length);

    // Backup + manifest exist despite the failure.
    expect(existsSync(join(result.backupRoot, "manifest.json"))).toBe(true);
    expect(existsSync(join(result.backupRoot, "files"))).toBe(true);

    // Nothing was removed / disabled — every original surface survives.
    expect(existsSync(join(home, ".claude", "skills", "ecc-review"))).toBe(true);
    expect(readJson(".claude/settings.json").enabledPlugins).toEqual({ "superpowers@obra": true });
  });

  it("reports completed vs pending when a later step fails", () => {
    seedFrameworkPollution();
    const plan = planClaudeCleanup(report());

    const result = applyClaudeCleanup(plan, {
      home,
      runId: "run-fail-1",
      beforeStep: (_step, index) => {
        if (index === 1) throw new Error("injected step failure");
      },
    });

    expect(result.status).toBe("failed");
    expect(result.completed.length).toBe(1);
    expect(result.completed[0]).toEqual(plan.steps[0]);
    expect(result.pending[0]).toEqual(plan.steps[1]);
    expect(existsSync(join(result.backupRoot, "manifest.json"))).toBe(true);
  });
});

describe("applyClaudeCleanup — targeted JSON key removal preserves unrelated keys", () => {
  it("removes only the framework keys, leaving unrelated siblings untouched", () => {
    seed(".claude/skills/ecc-review/SKILL.md", "# ecc\n");
    seedJson(".claude/settings.json", {
      enabledPlugins: { "superpowers@obra": true, "userplugin@mkt": true },
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "ecc/pre.sh" }] }],
      },
      mcpServers: { "ecc-memory": { command: "ecc-mcp" }, "user-mcp": { command: "mine" } },
      telemetry: false,
    });

    const plan = planClaudeCleanup(report());
    const result = applyClaudeCleanup(plan, { home, runId: "run-targeted" });
    expect(result.status).toBe("applied");

    const settings = readJson(".claude/settings.json");
    // Framework keys removed; unknown user siblings preserved.
    expect(settings.enabledPlugins).toEqual({ "userplugin@mkt": true });
    expect(settings.mcpServers).toEqual({ "user-mcp": { command: "mine" } });
    // Unrelated top-level key preserved verbatim.
    expect(settings.telemetry).toBe(false);
    // The ecc hook's event emptied out and was pruned.
    expect(settings.hooks).toEqual({});
    // The ecc skill dir is gone.
    expect(existsSync(join(home, ".claude", "skills", "ecc-review"))).toBe(false);
  });
});

describe("applyClaudeCleanup + rollbackClaudeCleanup — full round-trip", () => {
  it("polluted -> cleanup -> clean -> rollback -> byte-identical -> polluted", () => {
    seedFrameworkPollution();
    expect(report().clean).toBe(false);

    // Snapshot every file that will be backed up (ecc trees + the two JSON files).
    const before = new Map<string, string>([
      ...snapshotTree(".claude/skills"),
      ...snapshotTree(".claude/agents"),
      ...snapshotTree(".claude/rules"),
    ]);
    before.set(".claude/settings.json", digest(join(home, ".claude", "settings.json")));
    before.set(".mcp.json", digest(join(home, ".mcp.json")));

    const plan = planClaudeCleanup(report());
    const applied = applyClaudeCleanup(plan, { home, runId: "run-roundtrip" });
    expect(applied.status).toBe("applied");

    // The world is clean after cleanup.
    expect(report().clean).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "ecc-review"))).toBe(false);

    // Rollback restores every backed-up file byte-identically.
    const rolledBack = rollbackClaudeCleanup(applied.backupRoot, { home });
    expect(rolledBack.skippedDrifted).toEqual([]);
    for (const [rel, expectedDigest] of before) {
      const abs = join(home, ...rel.split("/"));
      expect(existsSync(abs)).toBe(true);
      expect(digest(abs)).toBe(expectedDigest);
    }

    // And the contamination returns.
    expect(report().clean).toBe(false);
  });
});

describe("rollbackClaudeCleanup — refuses tampered state", () => {
  it("throws on a schema-broken manifest", () => {
    seedFrameworkPollution();
    const applied = applyClaudeCleanup(planClaudeCleanup(report()), { home, runId: "run-schema" });
    // Corrupt the manifest so it no longer matches the schema.
    writeFileSync(join(applied.backupRoot, "manifest.json"), '{"schemaVersion":2}', "utf8");
    expect(() => rollbackClaudeCleanup(applied.backupRoot, { home })).toThrow(ClaudeCleanupError);
  });

  it("skips (never overwrites) an entry whose backup digest no longer matches", () => {
    seedFrameworkPollution();
    const applied = applyClaudeCleanup(planClaudeCleanup(report()), { home, runId: "run-digest" });

    // Tamper the backed-up settings.json under files/, leaving the manifest digest stale.
    const tamperedBackup = join(applied.backupRoot, "files", ".claude", "settings.json");
    const postApplySettings = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    writeFileSync(tamperedBackup, '{"tampered":true}\n', "utf8");

    const rolledBack = rollbackClaudeCleanup(applied.backupRoot, { home });
    // The drifted entry is reported and skipped.
    expect(rolledBack.skippedDrifted.some((s) => s.path === ".claude/settings.json")).toBe(true);
    // The live settings.json was NOT overwritten with the tampered backup bytes.
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(postApplySettings);
    expect(readJson(".claude/settings.json").tampered).toBeUndefined();
    // Other entries still restored (the ecc skill tree came back).
    expect(rolledBack.restored.length).toBeGreaterThan(0);
    expect(existsSync(join(home, ".claude", "skills", "ecc-review"))).toBe(true);
  });
});

describe("applyClaudeCleanup — double-apply is safe", () => {
  it("a second apply of the same plan no-ops on already-removed entries", () => {
    seedFrameworkPollution();
    const plan = planClaudeCleanup(report());

    const first = applyClaudeCleanup(plan, { home, runId: "run-1" });
    expect(first.status).toBe("applied");
    const afterFirst = readFileSync(join(home, ".claude", "settings.json"), "utf8");

    const second = applyClaudeCleanup(plan, { home, runId: "run-2" });
    expect(second.status).toBe("applied");
    // The remove steps found their targets already gone.
    expect(second.skippedAbsent.length).toBeGreaterThan(0);
    // Disk state is unchanged by the second run.
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(afterFirst);
    expect(report().clean).toBe(true);
  });
});
