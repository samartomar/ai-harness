import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AIH_SKILLS_LOCK_FILE,
  readSkillsLock,
  type SkillLockEntry,
  type SkillsLock,
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
