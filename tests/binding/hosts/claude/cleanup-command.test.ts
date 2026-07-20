import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ClaudeCleanupApplyResult,
  ClaudeCleanupPlan,
  ClaudeCleanupRollbackResult,
} from "../../../../src/binding/hosts/claude/cleanup.js";
import {
  command,
  executeClaudeCleanupCommand,
} from "../../../../src/binding/hosts/claude/cleanup-command.js";
import type { ClaudeContaminationReport } from "../../../../src/binding/hosts/claude/contamination.js";
import { builtinCommandNames } from "../../../../src/commands/index.js";
import type { PlanResult } from "../../../../src/internals/execute.js";
import type { PlanContext } from "../../../../src/internals/plan.js";
import { buildProgram } from "../../../../src/program.js";
import { makeCtx } from "./support.js";

/**
 * `aih cleanup` CLI-registration tests. The library itself (contamination scan,
 * plan, apply, rollback) is exhaustively covered by cleanup.test.ts /
 * roundtrip.test.ts; these tests cover ONLY what the command layer adds: flag
 * handling, rendering, exit-code wiring, and registration. Home is ALWAYS an
 * mkdtemp fixture injected via `ctx.env` — the real user home is never touched.
 */

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aih-cleanup-cmd-home-"));
  root = mkdtempSync(join(tmpdir(), "aih-cleanup-cmd-root-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, contents: string): void {
  const abs = join(home, ...rel.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents, "utf8");
}

function seedJson(rel: string, value: unknown): void {
  seed(rel, `${JSON.stringify(value, null, 2)}\n`);
}

function settingsBytes(): Buffer {
  return readFileSync(join(home, ".claude", "settings.json"));
}

/** The exact polluted fixture named by the task: an ecc rule, an ecc-* skill, a superpowers plugin entry. */
function seedPollutedHome(): void {
  seed(".claude/rules/ecc/RULES.md", "# ecc rules\n");
  seed(".claude/skills/ecc-review/SKILL.md", "# ecc review\n");
  seedJson(".claude/settings.json", {
    enabledPlugins: { "superpowers@obra": true },
    unrelatedSetting: "keep-me",
  });
}

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  return makeCtx(root, {
    env: { USERPROFILE: home },
    apply: false,
    json: false,
    options: {},
    ...over,
  });
}

/** The single digest's `data` payload, type-asserted for the caller. */
function digestData<T>(result: PlanResult): T {
  expect(result.digests).toHaveLength(1);
  const data = result.digests[0]?.data;
  expect(data).toBeDefined();
  return data as T;
}

/** The exact exitCode formula `runCapability` applies to a returned PlanResult. */
function exitCodeOf(result: PlanResult): number {
  const verifyCode = result.report ? result.report.exitCode() : 0;
  const execFailed = result.execs.some((e) => e.ran && e.ok === false);
  return verifyCode || (execFailed ? 1 : 0);
}

describe("aih cleanup — default preview (read-only)", () => {
  it("prints leakage counts + step listing, exits 0, and changes nothing on disk", async () => {
    seedPollutedHome();
    const before = settingsBytes();

    const result = await executeClaudeCleanupCommand(ctx());

    expect(exitCodeOf(result)).toBe(0);
    const text = result.digests[0]?.text ?? "";
    expect(text).toContain(
      "Leakage: 1 skills, 0 agents, 0 hooks, 1 rules, 1 plugins, 0 mcpServers",
    );
    expect(text).toContain("backup-then-remove skill [ecc] .claude/skills/ecc-review");
    expect(text).toContain("backup-then-remove rule [ecc] .claude/rules/ecc");
    expect(text).toContain("backup-then-disable plugin [superpowers] .claude/settings.json");
    expect(text).toContain("Nothing was changed");

    const data = digestData<{ report: ClaudeContaminationReport; plan: ClaudeCleanupPlan }>(result);
    expect(data.report.leakage).toEqual({
      skills: 1,
      agents: 0,
      hooks: 0,
      rules: 1,
      plugins: 1,
      mcpServers: 0,
    });
    expect(data.plan.steps).toHaveLength(3);
    expect(data.plan.skipped).toEqual([]);
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();

    // Byte-for-byte unchanged — a preview must never write.
    expect(settingsBytes().equals(before)).toBe(true);
  });

  it("skips unknown-attribution surfaces by default; --include-unknown widens the plan", async () => {
    seedPollutedHome();
    seed(".claude/skills/random-notes/SKILL.md", "# personal notes\n");

    const skipped = digestData<{ plan: ClaudeCleanupPlan }>(
      await executeClaudeCleanupCommand(ctx()),
    );
    expect(
      skipped.plan.steps.find((s) => s.path === ".claude/skills/random-notes"),
    ).toBeUndefined();
    expect(
      skipped.plan.skipped.find((s) => s.path === ".claude/skills/random-notes"),
    ).toBeDefined();

    const previewResult = await executeClaudeCleanupCommand(ctx());
    expect(previewResult.digests[0]?.text).toContain(
      "Skipped (unknown attribution — pass --include-unknown to widen)",
    );

    const widened = digestData<{ plan: ClaudeCleanupPlan }>(
      await executeClaudeCleanupCommand(ctx({ options: { includeUnknown: true } })),
    );
    expect(widened.plan.steps.find((s) => s.path === ".claude/skills/random-notes")).toBeDefined();
    expect(widened.plan.skipped).toEqual([]);
  });

  it("surfaces contamination-report warnings for malformed user-scope JSON", async () => {
    seedPollutedHome();
    seed(".mcp.json", "{not valid json");

    const result = await executeClaudeCleanupCommand(ctx());
    const data = digestData<{ report: ClaudeContaminationReport }>(result);
    expect(data.report.warnings.length).toBeGreaterThan(0);
    expect(result.digests[0]?.text).toContain("Warnings:");
  });
});

describe("aih cleanup --apply", () => {
  it("backs up, removes pollution, prints backupRoot + steps, and leaves unrelated keys untouched", async () => {
    seedPollutedHome();

    const result = await executeClaudeCleanupCommand(ctx({ apply: true }));

    expect(exitCodeOf(result)).toBe(0);
    const data = digestData<ClaudeCleanupApplyResult>(result);
    expect(data.status).toBe("applied");
    expect(existsSync(join(data.backupRoot, "manifest.json"))).toBe(true);
    expect(result.digests[0]?.text).toContain(`Backup: ${data.backupRoot}`);
    expect(result.digests[0]?.text).toContain("Completed:");
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();

    // Pollution removed.
    expect(existsSync(join(home, ".claude", "skills", "ecc-review"))).toBe(false);
    expect(existsSync(join(home, ".claude", "rules", "ecc"))).toBe(false);

    // Unrelated settings key survives; the framework plugin key is gone.
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.enabledPlugins).toEqual({});
    expect(settings.unrelatedSetting).toBe("keep-me");
  });
});

describe("aih cleanup --apply then --rollback", () => {
  it("restores every backed-up file byte-identically", async () => {
    seedPollutedHome();
    const beforeApply = settingsBytes();

    const applied = await executeClaudeCleanupCommand(ctx({ apply: true }));
    const applyData = digestData<ClaudeCleanupApplyResult>(applied);
    expect(applyData.status).toBe("applied");
    expect(existsSync(join(home, ".claude", "skills", "ecc-review"))).toBe(false);

    const rolledBack = await executeClaudeCleanupCommand(
      ctx({ options: { rollback: applyData.backupRoot } }),
    );
    expect(exitCodeOf(rolledBack)).toBe(0);
    const rollbackData = digestData<ClaudeCleanupRollbackResult>(rolledBack);
    expect(rollbackData.skippedDrifted).toEqual([]);
    expect(rollbackData.restored.length).toBeGreaterThan(0);
    expect(rolledBack.digests[0]?.text).toContain("Restored:");
    expect(() => JSON.parse(JSON.stringify(rolledBack))).not.toThrow();

    expect(existsSync(join(home, ".claude", "skills", "ecc-review"))).toBe(true);
    expect(existsSync(join(home, ".claude", "rules", "ecc"))).toBe(true);
    expect(settingsBytes().equals(beforeApply)).toBe(true);
  });
});

describe("aih cleanup --rollback refusals", () => {
  it("fails closed with the typed message on a schema-tampered manifest; live files untouched", async () => {
    seedPollutedHome();
    const applied = await executeClaudeCleanupCommand(ctx({ apply: true }));
    const applyData = digestData<ClaudeCleanupApplyResult>(applied);
    writeFileSync(join(applyData.backupRoot, "manifest.json"), '{"schemaVersion":2}', "utf8");
    const liveSettingsBefore = readFileSync(join(home, ".claude", "settings.json"), "utf8");

    await expect(
      executeClaudeCleanupCommand(ctx({ options: { rollback: applyData.backupRoot } })),
    ).rejects.toThrow(/refusing tampered cleanup manifest/);

    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(liveSettingsBefore);
  });

  it("refuses --rollback combined with --apply", async () => {
    await expect(
      executeClaudeCleanupCommand(ctx({ apply: true, options: { rollback: "some-backup-root" } })),
    ).rejects.toThrow(/--rollback cannot be combined with --apply/);
  });

  it("refuses --rollback combined with --include-unknown", async () => {
    await expect(
      executeClaudeCleanupCommand(
        ctx({ options: { rollback: "some-backup-root", includeUnknown: true } }),
      ),
    ).rejects.toThrow(/--rollback cannot be combined with --include-unknown/);
  });
});

describe("aih cleanup — registration", () => {
  it("declares the --rollback and --include-unknown options on its CommandSpec", () => {
    expect(command.name).toBe("cleanup");
    expect((command.options ?? []).map((o) => o.flags)).toEqual(
      expect.arrayContaining(["--rollback <backupRoot>", "--include-unknown"]),
    );
  });

  it("appears in builtinCommandNames()", () => {
    expect(builtinCommandNames()).toContain("cleanup");
  });

  it("registers on the built program and renders --help with its flags", () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === "cleanup");
    expect(cmd).toBeDefined();
    const help = cmd?.helpInformation() ?? "";
    expect(help).toContain("cleanup");
    expect(help).toContain("--apply");
    expect(help).toContain("--json");
    expect(help).toContain("--rollback <backupRoot>");
    expect(help).toContain("--include-unknown");
  });
});
