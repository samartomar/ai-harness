import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_TRUST_LOCK_BYTES, readTrustLockExact, TRUST_LOCK_FILE } from "../../src/trust/lock.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-trust-lock-exact-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readTrustLockExact", () => {
  it("returns copied exact bytes and a digest for strict valid state", () => {
    const source = {
      id: "owner-repo",
      kind: "github",
      source: "Owner/Repo",
      ref: "main",
      pinnedSha: "a".repeat(40),
      promotedAt: "2026-08-10T00:00:00.000Z",
      promotedSkills: ["clean"],
      analyzersRun: ["aih-native"],
      artifactHashes: [{ path: "skills/clean/SKILL.md", sha256: "b".repeat(64) }],
      findings: [],
    };
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, sources: [source] }));
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(join(root, TRUST_LOCK_FILE), bytes);

    const read = readTrustLockExact(root);
    expect(read.state).toBe("valid");
    if (read.state !== "valid") throw new Error("expected valid lock");
    expect(read.sourceBytes.equals(bytes)).toBe(true);
    expect(read.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    read.sourceBytes[0] = 0;
    const second = readTrustLockExact(root);
    expect(second.state === "valid" && second.sourceBytes.equals(bytes)).toBe(true);
  });

  it("distinguishes absent state and rejects unknown or malformed fields", () => {
    expect(readTrustLockExact(root)).toEqual({ state: "absent" });
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(
      join(root, TRUST_LOCK_FILE),
      JSON.stringify({ schemaVersion: 1, sources: [], unexpected: true }),
    );
    expect(readTrustLockExact(root)).toEqual({ state: "malformed" });
  });

  it("rejects invalid UTF-8, folded duplicate identities, artifacts, and oversized bytes", () => {
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(join(root, TRUST_LOCK_FILE), Buffer.from([0xff]));
    expect(readTrustLockExact(root)).toEqual({ state: "malformed" });

    const source = (id: string, path: string) => ({
      id,
      kind: "github",
      source: "Owner/Repo",
      ref: "main",
      pinnedSha: "a".repeat(40),
      promotedAt: "2026-08-10T00:00:00.000Z",
      promotedSkills: ["clean"],
      analyzersRun: ["aih-native"],
      artifactHashes: [
        { path: "skills/clean/SKILL.md", sha256: "b".repeat(64) },
        { path, sha256: "c".repeat(64) },
      ],
      findings: [],
    });
    writeFileSync(
      join(root, TRUST_LOCK_FILE),
      JSON.stringify({
        schemaVersion: 1,
        sources: [source("Owner-Repo", "SKILLS/CLEAN/skill.md"), source("owner-repo", "other")],
      }),
    );
    expect(readTrustLockExact(root)).toEqual({ state: "malformed" });

    writeFileSync(join(root, TRUST_LOCK_FILE), Buffer.alloc(MAX_TRUST_LOCK_BYTES + 1, 0x20));
    expect(readTrustLockExact(root)).toEqual({ state: "malformed" });
  });

  it("rejects an in-root symlink parent and a hard-linked authority file", () => {
    const actual = join(root, "actual-aih");
    mkdirSync(actual);
    writeFileSync(
      join(actual, "trust-lock.json"),
      JSON.stringify({ schemaVersion: 1, sources: [] }),
    );
    symlinkSync(actual, join(root, ".aih"), "dir");
    expect(readTrustLockExact(root)).toEqual({ state: "malformed" });

    rmSync(join(root, ".aih"));
    mkdirSync(join(root, ".aih"));
    writeFileSync(join(root, TRUST_LOCK_FILE), JSON.stringify({ schemaVersion: 1, sources: [] }));
    linkSync(join(root, TRUST_LOCK_FILE), join(root, "trust-copy.json"));
    expect(readTrustLockExact(root)).toEqual({ state: "malformed" });
  });

  it("rejects a trust-lock parent swapped after descriptor open", () => {
    mkdirSync(join(root, ".aih"));
    writeFileSync(join(root, TRUST_LOCK_FILE), JSON.stringify({ schemaVersion: 1, sources: [] }));
    expect(
      readTrustLockExact(root, {
        afterOpen() {
          renameSync(join(root, ".aih"), join(root, "old-aih"));
          mkdirSync(join(root, ".aih"));
          writeFileSync(
            join(root, TRUST_LOCK_FILE),
            JSON.stringify({ schemaVersion: 1, sources: [] }),
          );
        },
      }),
    ).toEqual({ state: "malformed" });
  });

  it("rejects a trust-lock replaced between inspect and open", () => {
    mkdirSync(join(root, ".aih"));
    writeFileSync(join(root, TRUST_LOCK_FILE), JSON.stringify({ schemaVersion: 1, sources: [] }));
    expect(
      readTrustLockExact(root, {
        afterInspect() {
          renameSync(join(root, TRUST_LOCK_FILE), join(root, ".aih", "inspected-lock.json"));
          writeFileSync(
            join(root, TRUST_LOCK_FILE),
            JSON.stringify({ schemaVersion: 1, sources: [] }),
          );
        },
      }),
    ).toEqual({ state: "malformed" });
  });
});
