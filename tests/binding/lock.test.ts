import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  readBindingLockForRemoval,
  writeBindingLockAtomic,
} from "../../src/binding/lock.js";
import type { BindingDeclaration } from "../../src/binding/schema.js";
import { LEGACY_GSTACK_MIGRATION_DIAGNOSTIC } from "../../src/internals/legacy-config.js";

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

function legacyGstackLock(): unknown {
  const current = lock();
  return {
    ...current,
    declaration: {
      ...current.declaration,
      framework: { id: "gstack", host: "claude" },
    },
  };
}

function writeLegacyGstackLock(): void {
  mkdirSync(join(root, ".aih", "binding"), { recursive: true });
  writeFileSync(bindingLockPath(root), JSON.stringify(legacyGstackLock()), "utf8");
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

  it("never parses, writes, or normally reads a legacy GStack receipt", () => {
    const legacy = legacyGstackLock();
    expect(() => parseBindingLock(legacy)).toThrow(LEGACY_GSTACK_MIGRATION_DIAGNOSTIC);
    expect(() => writeBindingLockAtomic(root, legacy as BindingLock)).toThrow(
      LEGACY_GSTACK_MIGRATION_DIAGNOSTIC,
    );
    expect(existsSync(bindingLockPath(root))).toBe(false);

    writeLegacyGstackLock();
    expect(() => readBindingLock(root)).toThrow(LEGACY_GSTACK_MIGRATION_DIAGNOSTIC);
  });

  it("reads a verified legacy GStack receipt only for conservative ownership removal", () => {
    writeLegacyGstackLock();
    const read = readBindingLockForRemoval(root);
    expect(read.present).toBe(true);
    if (read.present) expect(read.lock.declaration.framework.id).toBe("gstack");

    const plan = planBindingRemoval(root);
    expect(plan.mode).toBe("apply");
  });

  it("refuses a tampered legacy receipt before producing a removal plan", () => {
    const tampered = legacyGstackLock() as Record<string, unknown>;
    tampered.unexpected = true;
    mkdirSync(join(root, ".aih", "binding"), { recursive: true });
    writeFileSync(bindingLockPath(root), JSON.stringify(tampered), "utf8");

    const userFile = join(root, ".claude", "user-notes.md");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(userFile, "keep me", "utf8");

    expect(() => readBindingLockForRemoval(root)).toThrow(LEGACY_GSTACK_MIGRATION_DIAGNOSTIC);
    expect(() => planBindingRemoval(root)).toThrow(LEGACY_GSTACK_MIGRATION_DIAGNOSTIC);
    expect(existsSync(userFile)).toBe(true);
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
