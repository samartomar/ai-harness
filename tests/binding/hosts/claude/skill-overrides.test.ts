import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ClaudeManagedPlan,
  ClaudeManagedWriteEngine,
  finalizeClaudeOwnership,
} from "../../../../src/binding/hosts/claude/managed-writes.js";
import { planClaudeRemoval } from "../../../../src/binding/hosts/claude/removal.js";
import {
  type PinnedSkillInventory,
  queueSkillDenyList,
  skillDenyListReport,
} from "../../../../src/binding/hosts/claude/skill-overrides.js";
import {
  CLAUDE_SETTINGS_PATH,
  ClaudeHostWriteError,
} from "../../../../src/binding/hosts/claude/surfaces.js";
import type {
  BindingLock,
  BindingOwnershipEntry,
  BindingWrite,
} from "../../../../src/binding/lock.js";
import type { BindingDeclaration } from "../../../../src/binding/schema.js";
import { applyActions, readJson } from "./support.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-claude-skillov-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, contents: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function declaration(): BindingDeclaration {
  return {
    schemaVersion: 1,
    framework: { id: "gstack", host: "claude" },
    source: {
      kind: "git",
      repository: "example/gstack",
      commitSha: "c".repeat(40),
      treeDigest: "a".repeat(64),
    },
  };
}

function lockFrom(writes: BindingWrite[], ownership: BindingOwnershipEntry[]): BindingLock {
  const digest = "a".repeat(64);
  return {
    schemaVersion: 1,
    declaration: declaration(),
    writes,
    scannedDigest: digest,
    loadedDigest: digest,
    match: true,
    ownership,
  };
}

/** Apply `built`'s actions and seal ownership into a lock ready for removal. */
async function bindAndLock(built: ClaudeManagedPlan): Promise<BindingLock> {
  await applyActions(root, built.actions);
  const ownership = finalizeClaudeOwnership(root, built.ownership);
  return lockFrom(built.writes, ownership);
}

const DIGEST_A = "1".repeat(64);
const DIGEST_B = "2".repeat(64);

function inventory(names: readonly string[], sourceDigest = DIGEST_A): PinnedSkillInventory {
  return { names, sourceDigest };
}

describe("queueSkillDenyList", () => {
  it('writes exact "off" entries per pinned name as depth-2 skillOverrides pointers', () => {
    const engine = new ClaudeManagedWriteEngine(root);
    const result = queueSkillDenyList(engine, inventory(["alpha", "beta"]));
    expect(result.denied).toEqual(["alpha", "beta"]);

    const built = engine.build();
    expect(built.ownership.map((o) => o.target)).toEqual([
      `${CLAUDE_SETTINGS_PATH}#/skillOverrides/alpha`,
      `${CLAUDE_SETTINGS_PATH}#/skillOverrides/beta`,
    ]);
    expect(built.ownership.every((o) => o.kind === "json-pointer")).toBe(true);
    expect(built.ownership.every((o) => o.applied === "off")).toBe(true);
  });

  it("leaves unrelated skillOverrides neighbors (including the user's own off entries) untouched", async () => {
    seed(
      CLAUDE_SETTINGS_PATH,
      `${JSON.stringify(
        { telemetry: false, skillOverrides: { userOwned: "off", enabledOne: "on" } },
        null,
        2,
      )}\n`,
    );
    const engine = new ClaudeManagedWriteEngine(root);
    queueSkillDenyList(engine, inventory(["alpha", "beta"]));
    await applyActions(root, engine.build().actions);

    expect(readJson(root, CLAUDE_SETTINGS_PATH)).toEqual({
      telemetry: false,
      skillOverrides: { userOwned: "off", enabledOne: "on", alpha: "off", beta: "off" },
    });
  });

  it("captures a pre-existing per-name value and restores it on removal via planClaudeRemoval", async () => {
    seed(
      CLAUDE_SETTINGS_PATH,
      `${JSON.stringify({ skillOverrides: { alpha: "off" } }, null, 2)}\n`,
    );
    const engine = new ClaudeManagedWriteEngine(root);
    const result = queueSkillDenyList(engine, inventory(["alpha", "beta"]));
    expect(result.denied).toEqual(["alpha", "beta"]);

    const built = engine.build();
    const alphaOwnership = built.ownership.find((o) => o.target.endsWith("/alpha"));
    const betaOwnership = built.ownership.find((o) => o.target.endsWith("/beta"));
    expect(alphaOwnership?.preExisting).toEqual({ value: "off" });
    expect(betaOwnership?.preExisting).toEqual({ absent: true });

    const lock = await bindAndLock(built);
    expect(readJson(root, CLAUDE_SETTINGS_PATH)).toEqual({
      skillOverrides: { alpha: "off", beta: "off" },
    });

    const removal = planClaudeRemoval(root, lock);
    expect(removal.drift).toHaveLength(0);
    await applyActions(root, removal.actions);

    // alpha's pre-existing "off" is restored; beta (which had no prior value) is pruned.
    expect(readJson(root, CLAUDE_SETTINGS_PATH)).toEqual({ skillOverrides: { alpha: "off" } });
  });

  it("queues zero entries and produces zero writes for an empty inventory", () => {
    const engine = new ClaudeManagedWriteEngine(root);
    const result = queueSkillDenyList(engine, inventory([]));
    expect(result.denied).toEqual([]);

    const built = engine.build();
    expect(built.actions).toHaveLength(0);
    expect(built.writes).toHaveLength(0);
    expect(built.ownership).toHaveLength(0);
  });

  describe("hostile skill names are rejected before anything is queued", () => {
    const hostileNames: Array<[string, string]> = [
      ["parent traversal", "../x"],
      ["embedded slash", "a/b"],
      ["embedded tilde", "a~b"],
      ["dunder proto", "__proto__"],
      ["control character", `a${String.fromCharCode(1)}b`],
      ["empty string", ""],
    ];

    it.each(hostileNames)("rejects %s", (_label, name) => {
      const engine = new ClaudeManagedWriteEngine(root);
      expect(() => queueSkillDenyList(engine, inventory([name]))).toThrow(ClaudeHostWriteError);
    });
  });

  describe("sourceDigest is validated fail-closed", () => {
    const badDigests = ["too-short", "G".repeat(64), "a".repeat(63), "a".repeat(65), ""];

    it.each(badDigests)("rejects an invalid sourceDigest %s", (digest) => {
      const engine = new ClaudeManagedWriteEngine(root);
      expect(() => queueSkillDenyList(engine, inventory([], digest))).toThrow(ClaudeHostWriteError);
    });
  });
});

describe("skillDenyListReport", () => {
  it("classifies missing and extra entries on a mixed fixture", () => {
    seed(
      CLAUDE_SETTINGS_PATH,
      `${JSON.stringify(
        { skillOverrides: { a: "off", b: "on", stale1: "off", stale2: "off" } },
        null,
        2,
      )}\n`,
    );
    const report = skillDenyListReport(root, inventory(["a", "b", "c"]));
    expect(report.missing).toEqual(["b", "c"]);
    expect(report.extra).toEqual(["stale1", "stale2"]);
    expect(report.total).toBe(3);
    expect(report.fresh).toBe("unknown");
  });

  it('freshness is "unknown" without a locked digest', () => {
    const report = skillDenyListReport(root, inventory([]));
    expect(report.fresh).toBe("unknown");
  });

  it("freshness is true when the locked digest matches the inventory digest", () => {
    const report = skillDenyListReport(root, inventory([]), { lockedSourceDigest: DIGEST_A });
    expect(report.fresh).toBe(true);
  });

  it("freshness is false when the locked digest mismatches (stale)", () => {
    const report = skillDenyListReport(root, inventory([]), { lockedSourceDigest: DIGEST_B });
    expect(report.fresh).toBe(false);
  });

  it("returns a well-formed empty report for an empty inventory with no settings file", () => {
    const report = skillDenyListReport(root, inventory([]));
    expect(report).toEqual({ missing: [], extra: [], fresh: "unknown", total: 0 });
  });

  it("rejects hostile names in the inventory", () => {
    expect(() => skillDenyListReport(root, inventory(["../x"]))).toThrow(ClaudeHostWriteError);
    expect(() => skillDenyListReport(root, inventory(["__proto__"]))).toThrow(ClaudeHostWriteError);
  });

  it("rejects an invalid sourceDigest", () => {
    expect(() => skillDenyListReport(root, inventory([], "not-a-digest"))).toThrow(
      ClaudeHostWriteError,
    );
  });

  it("throws a typed ClaudeHostWriteError on malformed settings JSON", () => {
    seed(CLAUDE_SETTINGS_PATH, "{ not: valid json");
    expect(() => skillDenyListReport(root, inventory(["a"]))).toThrow(ClaudeHostWriteError);
  });

  it("throws a typed ClaudeHostWriteError when skillOverrides is present but not an object", () => {
    seed(CLAUDE_SETTINGS_PATH, `${JSON.stringify({ skillOverrides: ["not", "an", "object"] })}\n`);
    expect(() => skillDenyListReport(root, inventory(["a"]))).toThrow(ClaudeHostWriteError);
  });

  it("bind then report shows zero missing/extra for the same inventory (regenerate/re-verify loop)", async () => {
    const pinned = inventory(["alpha", "beta"]);
    const engine = new ClaudeManagedWriteEngine(root);
    queueSkillDenyList(engine, pinned);
    await applyActions(root, engine.build().actions);

    const report = skillDenyListReport(root, pinned, { lockedSourceDigest: DIGEST_A });
    expect(report).toEqual({ missing: [], extra: [], fresh: true, total: 2 });
  });
});
