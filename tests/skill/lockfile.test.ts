import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AIH_SKILLS_LOCK_FILE,
  readSkillsLock,
  type SkillLockEntry,
  type SkillsLock,
  skillNameSchema,
  upsertSkillLockEntry,
} from "../../src/skill/lockfile.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-skills-lock-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeLock(body: string): void {
  writeFileSync(join(root, AIH_SKILLS_LOCK_FILE), body, "utf8");
}

function entry(overrides: Partial<SkillLockEntry> = {}): SkillLockEntry {
  return {
    name: "clean",
    source: `owner/repo@${"a".repeat(40)}`,
    commit: "a".repeat(40),
    verdict: "GREEN",
    scope: "repo",
    card: "ai-coding/skill-cards/clean.json",
    evidenceSha256: "0".repeat(64),
    approvedBy: "docs-platform",
    approvedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("skillNameSchema", () => {
  it("accepts plain and slash-nested names", () => {
    expect(skillNameSchema.safeParse("clean").success).toBe(true);
    expect(skillNameSchema.safeParse("group/clean").success).toBe(true);
  });

  it("rejects traversal, absolute, and drive-letter forms", () => {
    for (const name of ["../evil", "a/../b", "/abs", "C:evil", ".", ".."]) {
      expect(skillNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it("rejects backslashes — a Windows join() treats them as separators", () => {
    // A hand-edited lock name like `..\..\x` is ONE forward-slash segment (so the
    // segment checks pass) but traverses on win32; the schema is the boundary.
    for (const name of ["..\\..\\evil", "foo\\bar", "\\\\unc\\share"]) {
      expect(skillNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it("rejects control characters", () => {
    expect(skillNameSchema.safeParse("evil\u0000name").success).toBe(false);
    expect(skillNameSchema.safeParse("evil\u001fname").success).toBe(false);
    expect(skillNameSchema.safeParse("evil\u007fname").success).toBe(false);
  });
});

describe("readSkillsLock", () => {
  it("returns an empty lock when the file is absent", () => {
    expect(readSkillsLock(root)).toEqual({ schemaVersion: 1, skills: [] });
  });

  it("returns an empty lock on malformed JSON instead of throwing", () => {
    writeLock("{ broken");

    expect(readSkillsLock(root)).toEqual({ schemaVersion: 1, skills: [] });
  });

  it("returns an empty lock when skills is not an array", () => {
    writeLock(JSON.stringify({ schemaVersion: 1, skills: "nope" }));

    expect(readSkillsLock(root)).toEqual({ schemaVersion: 1, skills: [] });
  });

  it("drops malformed entries while keeping valid siblings", () => {
    writeLock(
      JSON.stringify({
        schemaVersion: 1,
        skills: [entry(), { name: "bad" }, entry({ name: "other", evidenceSha256: "not-a-sha" })],
      }),
    );

    const lock = readSkillsLock(root);

    expect(lock.skills).toHaveLength(1);
    expect(lock.skills[0]?.name).toBe("clean");
  });

  it("drops duplicate-name entries — first wins (review MEDIUM)", () => {
    // Every aih writer dedupes by name, so a duplicate means a hand-edited file.
    // Letting it through would make every downstream by-name join (inventory,
    // packs, marketplace) silently last-write-wins on the skill's provenance.
    writeLock(
      JSON.stringify({
        schemaVersion: 1,
        skills: [
          entry({ name: "dup", commit: "a".repeat(40) }),
          entry({ name: "dup", commit: "b".repeat(40) }),
          entry({ name: "unique" }),
        ],
      }),
    );

    const lock = readSkillsLock(root);

    expect(lock.skills.map((s) => s.name)).toEqual(["dup", "unique"]);
    expect(lock.skills[0]?.commit).toBe("a".repeat(40)); // the FIRST entry's pin survives
  });
});

describe("upsertSkillLockEntry", () => {
  it("appends a new entry sorted by name without mutating the input", () => {
    const lock: SkillsLock = { schemaVersion: 1, skills: [entry({ name: "zeta" })] };

    const next = upsertSkillLockEntry(lock, entry({ name: "alpha" }));

    expect(next.skills.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect(lock.skills.map((s) => s.name)).toEqual(["zeta"]);
  });

  it("replaces an existing entry by name", () => {
    const lock: SkillsLock = {
      schemaVersion: 1,
      skills: [entry({ commit: "b".repeat(40) }), entry({ name: "other" })],
    };

    const next = upsertSkillLockEntry(lock, entry({ commit: "c".repeat(40) }));

    expect(next.skills).toHaveLength(2);
    expect(next.skills.find((s) => s.name === "clean")?.commit).toBe("c".repeat(40));
    expect(next.skills.find((s) => s.name === "other")).toBeDefined();
  });
});
