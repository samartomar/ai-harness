import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BindingLock,
  BindingLockError,
  BindingLockSchema,
  bindingLockPath,
  parseBindingLock,
  planBindingRemoval,
  readBindingLock,
  writeBindingLockAtomic,
} from "../../src/binding/lock.js";
import type { BindingDeclaration } from "../../src/binding/schema.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function declaration(): BindingDeclaration {
  return {
    schemaVersion: 1,
    framework: { id: "ecc", mode: "lean", host: "claude" },
    source: {
      kind: "git",
      repository: "affaan-m/ECC",
      commitSha: "c".repeat(40),
      treeDigest: SHA_A,
    },
  };
}

function lock(overrides: Partial<BindingLock> = {}): BindingLock {
  return {
    schemaVersion: 1,
    declaration: declaration(),
    writes: [{ path: ".claude/skills/ecc/SKILL.md", mechanism: "file", contentDigest: SHA_B }],
    scannedDigest: SHA_A,
    loadedDigest: SHA_A,
    match: true,
    ownership: [
      {
        kind: "json-pointer",
        target: "/mcpServers/ecc",
        preExisting: { absent: true },
        applied: { command: "ecc-mcp" },
        postApplyDigest: SHA_B,
      },
      {
        kind: "file",
        target: ".claude/skills/ecc/SKILL.md",
        preExisting: { value: "old" },
        applied: SHA_B,
        postApplyDigest: SHA_B,
      },
    ],
    ...overrides,
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-binding-lock-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("binding lock schema", () => {
  it("round-trips parse -> serialize -> parse", () => {
    const first = parseBindingLock(lock());
    const second = parseBindingLock(JSON.parse(JSON.stringify(first)));
    expect(second).toEqual(first);
  });

  it("accepts match:false when scanned and loaded digests differ", () => {
    const drifted = lock({ scannedDigest: SHA_A, loadedDigest: SHA_B, match: false });
    expect(BindingLockSchema.safeParse(drifted).success).toBe(true);
  });

  it("rejects match:true when scanned and loaded digests differ (fail closed on drift)", () => {
    const inconsistent = { ...lock(), scannedDigest: SHA_A, loadedDigest: SHA_B, match: true };
    expect(BindingLockSchema.safeParse(inconsistent).success).toBe(false);
  });

  it("rejects match:false when the digests are equal", () => {
    const inconsistent = { ...lock(), scannedDigest: SHA_A, loadedDigest: SHA_A, match: false };
    expect(BindingLockSchema.safeParse(inconsistent).success).toBe(false);
  });

  it("rejects unknown keys (strict machine-state record)", () => {
    expect(BindingLockSchema.safeParse({ ...lock(), extra: true }).success).toBe(false);
  });

  it("rejects an unsafe write path", () => {
    const bad = lock({ writes: [{ path: "../escape", mechanism: "file", contentDigest: SHA_B }] });
    expect(BindingLockSchema.safeParse(bad).success).toBe(false);
  });
});

describe("binding lock read/write", () => {
  it("writes the lock to repo-local .aih/binding/lock.json", () => {
    writeBindingLockAtomic(root, lock());
    expect(bindingLockPath(root)).toBe(join(root, ".aih", "binding", "lock.json"));
    expect(existsSync(bindingLockPath(root))).toBe(true);
  });

  it("reads back an identical lock", () => {
    writeBindingLockAtomic(root, lock());
    const read = readBindingLock(root);
    expect(read.present).toBe(true);
    if (read.present) expect(read.lock).toEqual(lock());
  });

  it("reports absence when no lock exists", () => {
    expect(readBindingLock(root)).toEqual({ present: false });
  });

  it("overwrites atomically (last write wins)", () => {
    writeBindingLockAtomic(root, lock());
    writeBindingLockAtomic(root, lock({ scannedDigest: SHA_B, loadedDigest: SHA_B }));
    const read = readBindingLock(root);
    expect(read.present && read.lock.scannedDigest).toBe(SHA_B);
  });

  it("uses owner-only permissions for the machine-state lock", () => {
    writeBindingLockAtomic(root, lock());
    if (process.platform !== "win32") {
      expect(lstatSync(bindingLockPath(root)).mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed on corrupt lock JSON", () => {
    writeBindingLockAtomic(root, lock());
    writeFileSync(bindingLockPath(root), "{ not json");
    expect(() => readBindingLock(root)).toThrow(BindingLockError);
  });

  it("fails closed on a schema-invalid lock", () => {
    writeBindingLockAtomic(root, lock());
    writeFileSync(bindingLockPath(root), JSON.stringify({ schemaVersion: 1 }));
    expect(() => readBindingLock(root)).toThrow(BindingLockError);
  });
});

describe("planBindingRemoval (fail-closed missing-lock rule)", () => {
  it("degrades to drift-report-only when the lock is missing (never guess-delete)", () => {
    const plan = planBindingRemoval(root);
    expect(plan.mode).toBe("drift-report-only");
  });

  it("plans an apply removal when a lock is present", () => {
    writeBindingLockAtomic(root, lock());
    const plan = planBindingRemoval(root);
    expect(plan.mode).toBe("apply");
    if (plan.mode === "apply") expect(plan.lock).toEqual(lock());
  });

  it("propagates the fail-closed error for a corrupt lock (does not guess-delete)", () => {
    writeBindingLockAtomic(root, lock());
    writeFileSync(bindingLockPath(root), "{ corrupt");
    expect(() => planBindingRemoval(root)).toThrow(BindingLockError);
  });
});
