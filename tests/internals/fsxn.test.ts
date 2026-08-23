import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FsTransaction,
  readBoundedFileDescriptor,
  readIfExists,
  readRegularFile,
  readRegularFileWithStats,
  retryTransient,
  rollbackAppliedWrites,
} from "../../src/internals/fsxn.js";

const fsEvents = vi.hoisted(() => ({
  events: [] as string[],
  openedPaths: new Map<number, string>(),
  readPathnames: [] as string[],
  afterTempWrite: undefined as ((path: string) => void) | undefined,
  afterRename: undefined as ((to: string) => void) | undefined,
  afterRead: undefined as ((path: string) => void) | undefined,
  afterRemove: undefined as ((path: string) => void) | undefined,
  afterLeaseWrite: undefined as ((path: string) => void) | undefined,
  afterClose: undefined as ((path: string) => void) | undefined,
  afterRollbackTempWrite: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    openSync: (path: string | Buffer | URL, flags: string | number, mode?: number) => {
      const fd = original.openSync(path, flags, mode);
      if (typeof path === "string") fsEvents.openedPaths.set(fd, path);
      return fd;
    },
    closeSync: (fd: number) => {
      const path = fsEvents.openedPaths.get(fd) ?? "";
      const result = original.closeSync(fd);
      fsEvents.openedPaths.delete(fd);
      fsEvents.afterClose?.(path);
      return result;
    },
    fsyncSync: (fd: number) => {
      fsEvents.events.push("fsync");
      return original.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      fsEvents.events.push(`rename:${to}`);
      const result = original.renameSync(from, to);
      fsEvents.afterRename?.(to);
      return result;
    },
    readFileSync: (path: string | number, options?: unknown) => {
      const result = original.readFileSync(path, options as never);
      if (typeof path === "string") fsEvents.readPathnames.push(path);
      fsEvents.afterRead?.(
        typeof path === "number" ? (fsEvents.openedPaths.get(path) ?? "") : path,
      );
      return result;
    },
    readSync: (...args: unknown[]) => {
      const result = (original.readSync as (...inner: unknown[]) => number)(...args);
      const fd = args[0];
      if (typeof fd === "number") fsEvents.afterRead?.(fsEvents.openedPaths.get(fd) ?? "");
      return result;
    },
    rmSync: (path: string, options?: unknown) => {
      const result = original.rmSync(path, options as never);
      fsEvents.afterRemove?.(path);
      return result;
    },
    writeFileSync: (path: string, data: string | NodeJS.ArrayBufferView, options?: unknown) => {
      const result = original.writeFileSync(path, data, options as never);
      if (path.endsWith(".aih.tmp")) fsEvents.afterTempWrite?.(path);
      if (path.endsWith(".aih.rollback.tmp")) fsEvents.afterRollbackTempWrite?.(path);
      if (/lease\.[0-9a-f]{64}\.json$/.test(path)) fsEvents.afterLeaseWrite?.(path);
      return result;
    },
  };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-fsxn-"));
});
afterEach(() => {
  fsEvents.afterTempWrite = undefined;
  fsEvents.afterRename = undefined;
  fsEvents.afterRead = undefined;
  fsEvents.afterRemove = undefined;
  fsEvents.afterLeaseWrite = undefined;
  fsEvents.afterClose = undefined;
  fsEvents.afterRollbackTempWrite = undefined;
  fsEvents.openedPaths.clear();
  fsEvents.readPathnames = [];
  rmSync(dir, { recursive: true, force: true });
});

function commitLease(owner: string, expiresAt: number): string {
  return JSON.stringify({
    expiresAt,
    format: "aih-fs-commit-lease",
    owner,
    reclaimAfter: expiresAt + 30_000,
    version: 1,
  });
}

function writeLockAnchor(lock: string): void {
  mkdirSync(lock, { recursive: true });
  writeFileSync(`${lock}/anchor.json`, '{"format":"aih-fs-commit-lock-anchor","version":1}');
}

function writeActiveLease(lock: string, owner: string, expiresAt: number): string {
  const active = join(lock, "active");
  mkdirSync(active, { recursive: true });
  const lease = join(active, `lease.${owner}.json`);
  writeFileSync(lease, commitLease(owner, expiresAt));
  return lease;
}

describe("FsTransaction", () => {
  it("preview does not touch disk", () => {
    const t = new FsTransaction();
    t.stage(join(dir, "a.txt"), "hi");
    expect(t.preview()).toHaveLength(1);
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
  });

  it("keeps an expired deadline preview mutation-free", () => {
    const target = join(dir, "expired-preview.txt");
    const t = new FsTransaction({ commitNotAfter: Date.parse("2020-01-01T00:00:00.000Z") });
    t.stage(target, "hi");

    expect(t.preview()).toHaveLength(1);
    expect(existsSync(target)).toBe(false);
  });

  it("rolls back earlier writes when its deadline expires mid-transaction", () => {
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    const first = join(dir, "first.txt");
    const second = join(dir, "second.txt");
    let sawFirstWrite = false;
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      if (existsSync(first)) sawFirstWrite = true;
      return sawFirstWrite ? start + 1 : start;
    });
    const t = new FsTransaction({ commitNotAfter: start + 1 });
    t.stage(first, "first");
    t.stage(second, "second");

    expect(() => t.commit()).toThrow("commit deadline expired");
    expect(sawFirstWrite).toBe(true);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    now.mockRestore();
  });

  it("rolls back earlier removals when its deadline expires mid-transaction", () => {
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    const first = join(dir, "first.txt");
    const second = join(dir, "second.txt");
    const firstLegacy = join(dir, ".aih", "legacy", "first.txt");
    writeFileSync(first, "first");
    writeFileSync(second, "second");
    let sawFirstRemoval = false;
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      if (existsSync(firstLegacy)) sawFirstRemoval = true;
      return sawFirstRemoval ? start + 1 : start;
    });
    const t = new FsTransaction({ commitNotAfter: start + 1 });
    t.stageRemoval(first, firstLegacy);
    t.stageRemoval(second, join(dir, ".aih", "legacy", "second.txt"));

    expect(() => t.commit()).toThrow("commit deadline expired");
    expect(sawFirstRemoval).toBe(true);
    expect(readFileSync(first, "utf8")).toBe("first");
    expect(readFileSync(second, "utf8")).toBe("second");
    now.mockRestore();
  });

  it("rejects an expired deadline before its first mutation", () => {
    const deadline = Date.parse("2030-01-01T00:00:00.000Z");
    const now = vi.spyOn(Date, "now").mockReturnValue(deadline);
    const target = join(dir, "expired.txt");
    const t = new FsTransaction({ commitNotAfter: deadline });
    t.stage(target, "blocked");

    expect(() => t.commit()).toThrow("commit deadline expired");
    expect(existsSync(target)).toBe(false);
    now.mockRestore();
  });

  it("preserves an internal deadline failure while building a commit lease", () => {
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    const deadline = start + 1;
    const lock = join(dir, ".aih", "commit.lock");
    const target = join(dir, "blocked.txt");
    let current = start;
    const now = vi.spyOn(Date, "now").mockImplementation(() => current);
    fsEvents.afterLeaseWrite = () => {
      current = deadline;
    };
    const t = new FsTransaction({
      commitLock: { path: lock, root: dir },
      commitNotAfter: deadline,
    });
    t.stage(target, "blocked", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow(/commit deadline expired/);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(lock, "active"))).toBe(false);
    now.mockRestore();
  });

  it("returns an empty transaction without touching a hostile commit lock", () => {
    const lock = join(dir, ".aih", "commit.lock");
    mkdirSync(dirname(lock), { recursive: true });
    // A regular file at the lease anchor is hostile: any lock acquisition must
    // refuse it. An empty transaction has no effects or assertions to guard.
    writeFileSync(lock, "not a canonical commit-lock anchor");
    fsEvents.events = [];
    fsEvents.readPathnames = [];
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });

    expect(t.commit()).toEqual({ backups: [], removed: [], written: [] });
    expect(fsEvents.events).toEqual([]);
    expect(fsEvents.readPathnames).not.toContain(lock);
    expect(readFileSync(lock, "utf8")).toBe("not a canonical commit-lock anchor");
  });

  it("commits normally before a future deadline", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-01-01T00:00:00.000Z"));
    const target = join(dir, "future.txt");
    const t = new FsTransaction({ commitNotAfter: Date.parse("2030-01-01T00:00:01.000Z") });
    t.stage(target, "written");

    t.commit();
    expect(readFileSync(target, "utf8")).toBe("written");
    now.mockRestore();
  });

  it("refuses a staged write through a symlinked parent beneath its guarded root", () => {
    const outside = mkdtempSync(join(tmpdir(), "aih-fsxn-outside-"));
    const linked = join(dir, "linked");
    try {
      symlinkSync(outside, linked, "dir");
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    const target = join(linked, "escape.txt");
    const t = new FsTransaction();
    t.stage(target, "blocked", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow(/parent path/);
    expect(existsSync(join(outside, "escape.txt"))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it("removes transaction-created empty parent directories after rollback", () => {
    const created = join(dir, "created", "nested");
    const blockingFile = join(dir, "blocking-file");
    writeFileSync(blockingFile, "not a directory");
    const t = new FsTransaction();
    t.stage(join(created, "first.txt"), "first", undefined, undefined, { root: dir });
    t.stage(join(blockingFile, "second.txt"), "second", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow();
    expect(existsSync(join(dir, "created"))).toBe(false);
  });

  it("preserves created directories when lease ownership is lost between rollback phases", () => {
    const lock = join(dir, ".aih", "commit.lock");
    const parent = join(dir, "created", "nested");
    const first = join(parent, "first.txt");
    const blocking = join(dir, "blocking-file");
    const successorOwner = "e".repeat(64);
    writeFileSync(blocking, "not a directory");
    fsEvents.afterRemove = (path) => {
      if (path !== first) return;
      rmSync(join(lock, "active"), { recursive: true, force: true });
      writeActiveLease(lock, successorOwner, Date.parse("2030-01-02T00:00:00.000Z"));
    };
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });
    t.stage(first, "generated", undefined, undefined, { root: dir });
    t.stage(join(blocking, "second.txt"), "blocked", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow();
    expect(existsSync(parent)).toBe(true);
    expect(readFileSync(join(lock, "active", `lease.${successorOwner}.json`), "utf8")).toBe(
      commitLease(successorOwner, Date.parse("2030-01-02T00:00:00.000Z")),
    );
  });

  it("syncs a durable record before a later staged rename", () => {
    const first = join(dir, "record.json");
    const second = join(dir, "head.json");
    fsEvents.events = [];
    const t = new FsTransaction();
    t.stage(first, "record", undefined, undefined, { durable: true });
    t.stage(second, "head");

    t.commit();

    const durableSync = fsEvents.events.indexOf("fsync");
    expect(durableSync).toBeGreaterThanOrEqual(0);
    expect(durableSync).toBeLessThan(fsEvents.events.indexOf(`rename:${second}`));
  });

  it("rechecks an expected target immediately before replacing it", () => {
    const target = join(dir, "expected.txt");
    writeFileSync(target, "planned");
    const expected = createHash("sha256").update("planned").digest("hex");
    fsEvents.afterTempWrite = () => writeFileSync(target, "operator");
    const t = new FsTransaction();
    t.stage(target, "generated", undefined, { sha256: expected }, { root: dir });

    expect(() => t.commit()).toThrow(/write target changed before commit/);
    expect(readFileSync(target, "utf8")).toBe("operator");
    fsEvents.afterTempWrite = undefined;
  });

  it("keeps only its canonical anchor after a failed transaction", () => {
    const lock = join(dir, ".aih", "commit.lock");
    const blockingFile = join(dir, "blocking-file");
    writeFileSync(blockingFile, "not a directory");
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });
    t.stage(join(blockingFile, "child.txt"), "blocked", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow();
    expect(readFileSync(join(lock, "anchor.json"), "utf8")).toBe(
      '{"format":"aih-fs-commit-lock-anchor","version":1}',
    );
    expect(existsSync(join(lock, "active"))).toBe(false);
  });

  it("refuses an unexpired canonical commit lease without touching its target", () => {
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    const lock = join(dir, ".aih", "commit.lock");
    const target = join(dir, "blocked.txt");
    writeLockAnchor(lock);
    const lease = writeActiveLease(lock, "a".repeat(64), start + 60_000);
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });
    t.stage(target, "blocked", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow(/commit lock is already held/);
    expect(readFileSync(lease, "utf8")).toBe(commitLease("a".repeat(64), start + 60_000));
    expect(existsSync(target)).toBe(false);
    now.mockRestore();
  });

  it("reclaims an expired canonical commit lease and leaves no active lease", () => {
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    const lock = join(dir, ".aih", "commit.lock");
    const target = join(dir, "reclaimed.txt");
    writeLockAnchor(lock);
    writeActiveLease(lock, "a".repeat(64), start - 30_001);
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });
    t.stage(target, "reclaimed", undefined, undefined, { root: dir });

    t.commit();
    expect(readFileSync(target, "utf8")).toBe("reclaimed");
    expect(existsSync(join(lock, "active"))).toBe(false);
    expect(readdirSync(lock).sort()).toEqual(["anchor.json", "staging"]);
    now.mockRestore();
  });

  it("reads lock marker and lease facts from descriptors rather than raced path reads", () => {
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    const lock = join(dir, ".aih", "commit.lock");
    const target = join(dir, "descriptor-locked.txt");
    writeLockAnchor(lock);
    const staleLease = writeActiveLease(lock, "a".repeat(64), start - 30_001);
    const marker = join(lock, "anchor.json");
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });
    t.stage(target, "reclaimed", undefined, undefined, { root: dir });

    fsEvents.readPathnames = [];
    t.commit();

    expect(fsEvents.readPathnames).not.toContain(marker);
    expect(fsEvents.readPathnames).not.toContain(staleLease);
    now.mockRestore();
  });

  it("fails closed for a malformed commit lease without deleting it", () => {
    const lock = join(dir, ".aih", "commit.lock");
    const target = join(dir, "blocked.txt");
    writeLockAnchor(lock);
    mkdirSync(join(lock, "active"));
    writeFileSync(join(lock, "active", "foreign"), "foreign");
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });
    t.stage(target, "blocked", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow(/commit lock is already held/);
    expect(readFileSync(join(lock, "active", "foreign"), "utf8")).toBe("foreign");
    expect(existsSync(target)).toBe(false);
  });

  it("fails closed for a missing, linked, or symlinked canonical anchor", () => {
    const target = join(dir, "blocked.txt");
    const lock = join(dir, ".aih", "commit.lock");
    mkdirSync(lock, { recursive: true });
    const missing = new FsTransaction({ commitLock: { path: lock, root: dir } });
    missing.stage(target, "blocked", undefined, undefined, { root: dir });
    expect(() => missing.commit()).toThrow(/commit lock could not be verified/);

    writeFileSync(join(lock, "anchor.json"), '{"format":"aih-fs-commit-lock-anchor","version":1}');
    linkSync(join(lock, "anchor.json"), join(dir, "anchor-link"));
    const linked = new FsTransaction({ commitLock: { path: lock, root: dir } });
    linked.stage(target, "blocked", undefined, undefined, { root: dir });
    expect(() => linked.commit()).toThrow(/commit lock could not be verified/);
    expect(existsSync(target)).toBe(false);

    const symlinked = join(dir, ".aih", "symlink.lock");
    try {
      symlinkSync(lock, symlinked, "dir");
    } catch {
      return;
    }
    const linkedPath = new FsTransaction({ commitLock: { path: symlinked, root: dir } });
    linkedPath.stage(target, "blocked", undefined, undefined, { root: dir });
    expect(() => linkedPath.commit()).toThrow(/commit lock could not be verified/);
  });

  it("recovers only an expired, empty owner-named staging candidate", () => {
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    const lock = join(dir, ".aih", "commit.lock");
    const target = join(dir, "recovered.txt");
    writeLockAnchor(lock);
    const owner = "c".repeat(64);
    mkdirSync(join(lock, "staging", `${start - 30_001}.${start - 1}.${owner}`), {
      recursive: true,
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });
    t.stage(target, "recovered", undefined, undefined, { root: dir });

    t.commit();
    expect(readFileSync(target, "utf8")).toBe("recovered");
    expect(readdirSync(join(lock, "staging"))).toEqual([]);
    now.mockRestore();
  });

  it("recovers an empty active directory left after owner-lease cleanup interruption", () => {
    const lock = join(dir, ".aih", "commit.lock");
    const target = join(dir, "recovered.txt");
    writeLockAnchor(lock);
    const staleLease = writeActiveLease(
      lock,
      "d".repeat(64),
      Date.parse("2030-01-02T00:00:00.000Z"),
    );
    rmSync(staleLease);
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });
    t.stage(target, "recovered", undefined, undefined, { root: dir });

    t.commit();
    expect(readFileSync(target, "utf8")).toBe("recovered");
    expect(existsSync(join(lock, "active"))).toBe(false);
  });

  it("fails closed for foreign active or staging entries", () => {
    const lock = join(dir, ".aih", "commit.lock");
    const target = join(dir, "blocked.txt");
    writeLockAnchor(lock);
    mkdirSync(join(lock, "staging", "foreign"), { recursive: true });
    const staging = new FsTransaction({ commitLock: { path: lock, root: dir } });
    staging.stage(target, "blocked", undefined, undefined, { root: dir });
    expect(() => staging.commit()).toThrow(/commit lock is already held/);
    expect(existsSync(target)).toBe(false);

    const foreignLock = join(dir, ".aih", "foreign.lock");
    writeLockAnchor(foreignLock);
    writeFileSync(join(foreignLock, "foreign"), "foreign");
    const foreign = new FsTransaction({ commitLock: { path: foreignLock, root: dir } });
    foreign.stage(target, "blocked", undefined, undefined, { root: dir });
    expect(() => foreign.commit()).toThrow(/commit lock could not be verified/);
  });

  it("fails closed for a multi-linked canonical commit lease", () => {
    const lock = join(dir, ".aih", "commit.lock");
    const target = join(dir, "blocked.txt");
    writeLockAnchor(lock);
    const lease = writeActiveLease(lock, "a".repeat(64), Date.parse("2030-01-02T00:00:00.000Z"));
    linkSync(lease, join(dir, "other-link"));
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });
    t.stage(target, "blocked", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow(/commit lock is already held/);
    expect(existsSync(target)).toBe(false);
  });

  it("rejects a canonical-looking lease with an unbounded recovery grace", () => {
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    const lock = join(dir, ".aih", "commit.lock");
    const target = join(dir, "blocked.txt");
    const owner = "a".repeat(64);
    writeLockAnchor(lock);
    const lease = writeActiveLease(lock, owner, start - 1);
    writeFileSync(
      lease,
      JSON.stringify({
        expiresAt: start - 1,
        format: "aih-fs-commit-lease",
        owner,
        reclaimAfter: start + 365 * 24 * 60 * 60 * 1_000,
        version: 1,
      }),
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });
    t.stage(target, "blocked", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow(/commit lock is already held/);
    expect(existsSync(target)).toBe(false);
    now.mockRestore();
  });

  it("stops and rolls back before its commit lease becomes reclaimable", () => {
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    const first = join(dir, "first.txt");
    const second = join(dir, "second.txt");
    let sawFirst = false;
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      if (existsSync(first)) sawFirst = true;
      return sawFirst ? start + 2 : start;
    });
    const t = new FsTransaction({
      commitLock: { path: join(dir, ".aih", "commit.lock"), root: dir, leaseMs: 1 },
    });
    t.stage(first, "first", undefined, undefined, { root: dir });
    t.stage(second, "second", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow(/commit lock lease expired/);
    expect(sawFirst).toBe(true);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    now.mockRestore();
  });

  it("never removes a successor lease substituted before cleanup", () => {
    const lock = join(dir, ".aih", "commit.lock");
    const target = join(dir, "generated.txt");
    const successorOwner = "b".repeat(64);
    fsEvents.afterRename = (to) => {
      if (to !== target) return;
      rmSync(join(lock, "active"), { recursive: true, force: true });
      writeActiveLease(lock, successorOwner, Date.parse("2030-01-02T00:00:00.000Z"));
    };
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });
    t.stage(target, "generated", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow(/preserved concurrent changes.*commit lock lease lost/);
    expect(readFileSync(target, "utf8")).toBe("generated");
    expect(readFileSync(join(lock, "active", `lease.${successorOwner}.json`), "utf8")).toBe(
      commitLease(successorOwner, Date.parse("2030-01-02T00:00:00.000Z")),
    );
  });

  it("detects an identical-byte active lease replacement by inode and preserves the target", () => {
    const lock = join(dir, ".aih", "commit.lock");
    const target = join(dir, "generated.txt");
    let replacement:
      | {
          after: { dev: bigint; ino: bigint };
          before: { dev: bigint; ino: bigint };
          path: string;
          text: string;
        }
      | undefined;
    fsEvents.afterRename = (to) => {
      if (to !== target) return;
      const active = join(lock, "active");
      const name = readdirSync(active).find((entry) => entry.startsWith("lease."));
      if (name === undefined) throw new Error("expected active lease");
      const path = join(active, name);
      const text = readFileSync(path, "utf8");
      const before = lstatSync(path, { bigint: true });
      const stagedReplacement = `${path}.replacement`;
      writeFileSync(stagedReplacement, text);
      const staged = lstatSync(stagedReplacement, { bigint: true });
      if (staged.dev === before.dev && staged.ino === before.ino)
        throw new Error("expected a distinct staged replacement inode");
      rmSync(path);
      renameSync(stagedReplacement, path);
      const after = lstatSync(path, { bigint: true });
      replacement = {
        after: { dev: after.dev, ino: after.ino },
        before: { dev: before.dev, ino: before.ino },
        path,
        text,
      };
    };
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });
    t.stage(target, "generated", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow(/preserved concurrent changes.*commit lock lease lost/);
    expect(readFileSync(target, "utf8")).toBe("generated");
    expect(replacement).toBeDefined();
    expect(readFileSync(replacement?.path as string, "utf8")).toBe(replacement?.text);
    expect(replacement?.after).not.toEqual(replacement?.before);
  });

  it("allows exactly one concurrent contender to acquire the active claim", () => {
    const lock = join(dir, ".aih", "commit.lock");
    const firstTarget = join(dir, "first.txt");
    const secondTarget = join(dir, "second.txt");
    const first = new FsTransaction({ commitLock: { path: lock, root: dir } });
    const second = new FsTransaction({ commitLock: { path: lock, root: dir } });
    first.stage(firstTarget, "first", undefined, undefined, { root: dir });
    second.stage(secondTarget, "second", undefined, undefined, { root: dir });
    let secondAttempted = false;
    fsEvents.afterRename = (to) => {
      if (to !== join(lock, "active") || secondAttempted) return;
      secondAttempted = true;
      expect(() => second.commit()).toThrow(/commit lock is already held/);
    };

    first.commit();
    expect(secondAttempted).toBe(true);
    expect(readFileSync(firstTarget, "utf8")).toBe("first");
    expect(existsSync(secondTarget)).toBe(false);
    expect(existsSync(join(lock, "active"))).toBe(false);
  });

  it("does not reclaim an expired lease replaced after inspection", () => {
    const start = Date.parse("2030-01-01T00:00:00.000Z");
    const lock = join(dir, ".aih", "commit.lock");
    const target = join(dir, "blocked.txt");
    const successorOwner = "b".repeat(64);
    writeLockAnchor(lock);
    const stale = writeActiveLease(lock, "a".repeat(64), start - 30_001);
    fsEvents.afterRead = (path) => {
      if (path !== stale) return;
      rmSync(join(lock, "active"), { recursive: true, force: true });
      writeActiveLease(lock, successorOwner, start + 60_000);
    };
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });
    t.stage(target, "blocked", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow(/commit lock is already held/);
    expect(readFileSync(join(lock, "active", `lease.${successorOwner}.json`), "utf8")).toBe(
      commitLease(successorOwner, start + 60_000),
    );
    expect(existsSync(target)).toBe(false);
    now.mockRestore();
  });

  it("does not delete an outside victim when a created write parent is replaced before rollback", () => {
    const parent = join(dir, "created");
    const target = join(parent, "generated.txt");
    const outside = mkdtempSync(join(tmpdir(), "aih-fsxn-outside-"));
    const victim = join(outside, "generated.txt");
    const blockingFile = join(dir, "blocking-file");
    writeFileSync(victim, "generated");
    writeFileSync(blockingFile, "not a directory");
    const second = join(dir, "second.txt");
    fsEvents.afterTempWrite = (tmpPath) => {
      if (tmpPath !== `${second}.aih.tmp`) return;
      rmSync(target);
      rmdirSync(parent);
      symlinkSync(outside, parent, "dir");
    };
    const t = new FsTransaction();
    t.stage(target, "generated", undefined, undefined, { root: dir });
    t.stage(second, "second", undefined, undefined, { root: dir });
    t.stage(join(blockingFile, "child.txt"), "blocked", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow();
    expect(readFileSync(victim, "utf8")).toBe("generated");
    rmSync(outside, { recursive: true, force: true });
  });

  it("does not restore through an outside parent swapped before overwrite rollback", () => {
    const parent = join(dir, "managed");
    const target = join(parent, "config.txt");
    const outside = mkdtempSync(join(tmpdir(), "aih-fsxn-outside-"));
    const victim = join(outside, "config.txt");
    const blockingFile = join(dir, "blocking-file");
    mkdirSync(parent);
    writeFileSync(target, "original");
    writeFileSync(victim, "generated");
    writeFileSync(join(outside, "config.txt.aih.bak"), "attacker backup");
    writeFileSync(blockingFile, "not a directory");
    const second = join(dir, "second.txt");
    fsEvents.afterTempWrite = (tmpPath) => {
      if (tmpPath !== `${second}.aih.tmp`) return;
      rmSync(target);
      rmSync(`${target}.aih.bak`);
      rmdirSync(parent);
      symlinkSync(outside, parent, "dir");
    };
    const t = new FsTransaction();
    t.stage(target, "generated", undefined, undefined, { root: dir });
    t.stage(second, "second", undefined, undefined, { root: dir });
    t.stage(join(blockingFile, "child.txt"), "blocked", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow();
    expect(readFileSync(victim, "utf8")).toBe("generated");
    rmSync(outside, { recursive: true, force: true });
  });

  it("accounts for a write that is followed by a parent replacement before post-rename checks", () => {
    const parent = join(dir, "managed");
    const target = join(parent, "config.txt");
    const outside = mkdtempSync(join(tmpdir(), "aih-fsxn-outside-"));
    const probe = join(dir, "directory-link-probe");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      symlinkSync(outside, probe, linkType);
      rmSync(probe);
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    fsEvents.afterRename = (to) => {
      if (to !== target) return;
      renameSync(parent, `${parent}.old`);
      symlinkSync(outside, parent, linkType);
    };
    const t = new FsTransaction();
    t.stage(target, "generated", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow(/preserved concurrent changes/);
    rmSync(outside, { recursive: true, force: true });
  });

  it("accounts for a removal that is followed by a destination-parent replacement", () => {
    const source = join(dir, "owned.txt");
    const legacy = join(dir, ".aih", "legacy", "owned.txt");
    const legacyParent = join(dir, ".aih", "legacy");
    const outside = mkdtempSync(join(tmpdir(), "aih-fsxn-outside-"));
    const probe = join(dir, "directory-link-probe");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      symlinkSync(outside, probe, linkType);
      rmSync(probe);
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    writeFileSync(source, "owned");
    fsEvents.afterRename = (to) => {
      if (to !== legacy) return;
      renameSync(legacyParent, `${legacyParent}.old`);
      symlinkSync(outside, legacyParent, linkType);
    };
    const t = new FsTransaction();
    t.stageRemoval(source, legacy, { root: dir });

    expect(() => t.commit()).toThrow(/preserved concurrent changes/);
    rmSync(outside, { recursive: true, force: true });
  });

  it("does not restore an overwrite through a leaf symlink swapped after its generated bytes were read", () => {
    const parent = join(dir, "managed");
    const target = join(parent, "config.txt");
    const backup = `${target}.aih.bak`;
    const outside = mkdtempSync(join(tmpdir(), "aih-fsxn-outside-"));
    const victim = join(outside, "victim.txt");
    mkdirSync(parent);
    writeFileSync(target, "generated");
    writeFileSync(backup, "original");
    writeFileSync(victim, "victim");
    const stats = lstatSync(parent, { bigint: true });
    const probe = join(parent, "file-link-probe");
    try {
      symlinkSync(victim, probe, "file");
      rmSync(probe);
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    fsEvents.afterRead = (path) => {
      if (path !== target) return;
      rmSync(target);
      symlinkSync(victim, target, "file");
    };

    const preserved = rollbackAppliedWrites([
      {
        path: target,
        contents: "generated",
        backup,
        created: false,
        parentGuard: { directories: [{ path: parent, dev: stats.dev, ino: stats.ino }] },
      },
    ]);

    expect(preserved).toEqual([target]);
    expect(readFileSync(victim, "utf8")).toBe("victim");
    rmSync(outside, { recursive: true, force: true });
  });

  it("does not clean a rollback temp through a parent swapped after its exclusive create", () => {
    const parent = join(dir, "managed");
    const target = join(parent, "config.txt");
    const backup = `${target}.aih.bak`;
    const rollbackTemp = `${target}.aih.rollback.tmp`;
    const outside = mkdtempSync(join(tmpdir(), "aih-fsxn-outside-"));
    const outsideTemp = join(outside, "config.txt.aih.rollback.tmp");
    const probe = join(dir, "symlink-probe");
    try {
      symlinkSync(outside, probe, "dir");
      rmSync(probe);
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    mkdirSync(parent);
    writeFileSync(target, "generated");
    writeFileSync(backup, "original");
    writeFileSync(outsideTemp, "outside victim");
    const stats = lstatSync(parent, { bigint: true });
    fsEvents.afterRollbackTempWrite = (path) => {
      if (path !== rollbackTemp) return;
      renameSync(parent, `${parent}.old`);
      symlinkSync(outside, parent, "dir");
    };

    const preserved = rollbackAppliedWrites([
      {
        path: target,
        contents: "generated",
        backup,
        created: false,
        parentGuard: { directories: [{ path: parent, dev: stats.dev, ino: stats.ino }] },
      },
    ]);

    expect(preserved).toEqual([target]);
    expect(readFileSync(outsideTemp, "utf8")).toBe("outside victim");
    rmSync(outside, { recursive: true, force: true });
  });

  it("commit writes new files and backs up existing ones", () => {
    const p = join(dir, "f.txt");
    writeFileSync(p, "old");
    const t = new FsTransaction();
    t.stage(p, "new");
    const res = t.commit();
    expect(readFileSync(p, "utf8")).toBe("new");
    expect(res.backups).toHaveLength(1);
    expect(readFileSync(`${p}.aih.bak`, "utf8")).toBe("old");
  });

  it("rolls back every applied write when one fails", () => {
    const good = join(dir, "good.txt");
    const fileAsDir = join(dir, "afile");
    writeFileSync(fileAsDir, "");
    const t = new FsTransaction();
    t.stage(good, "x");
    // parent path is a file → mkdir fails → whole txn rolls back
    t.stage(join(fileAsDir, "child.txt"), "y");
    expect(() => t.commit()).toThrow();
    expect(existsSync(good)).toBe(false);
  });

  it("preserves an operator edit made before a later failure triggers rollback", () => {
    const target = join(dir, "managed.txt");
    const backup = `${target}.aih.bak`;
    writeFileSync(target, "operator edit\n");
    writeFileSync(backup, "before\n");

    const preserved = rollbackAppliedWrites([
      { path: target, contents: "generated\n", backup, created: false },
    ]);

    expect(preserved).toEqual([target]);
    expect(readFileSync(target, "utf8")).toBe("operator edit\n");
    expect(readFileSync(backup, "utf8")).toBe("before\n");
  });

  it("dedupes repeated writes to one target so rollback restores the ORIGINAL", () => {
    const p = join(dir, "f.txt");
    writeFileSync(p, "original");
    const t = new FsTransaction();
    t.stage(p, "first");
    t.stage(p, "second"); // same target staged twice
    const res = t.commit();
    expect(readFileSync(p, "utf8")).toBe("second"); // last write wins
    expect(res.backups).toHaveLength(1); // one backup, not two
    // The backup is the pre-transaction original — not the intermediate "first".
    expect(readFileSync(`${p}.aih.bak`, "utf8")).toBe("original");
  });

  it("refuses to write THROUGH a symlink (redirect-out protection)", () => {
    const real = join(dir, "real.txt");
    const link = join(dir, "link.txt");
    writeFileSync(real, "original");
    try {
      symlinkSync(real, link);
    } catch {
      return; // symlink creation not permitted on this host (e.g. Windows) — skip
    }
    const t = new FsTransaction();
    t.stage(link, "malicious");
    expect(() => t.commit()).toThrow(/symlink/);
    expect(readFileSync(real, "utf8")).toBe("original"); // link target left untouched
  });

  it("refuses to write when a symlink is planted at the .aih.bak scratch path", () => {
    const real = join(dir, "f.txt");
    const outside = join(dir, "victim.txt");
    writeFileSync(real, "original");
    writeFileSync(outside, "victim");
    try {
      symlinkSync(outside, `${real}.aih.bak`); // attacker pre-places the backup as a link
    } catch {
      return; // symlink not permitted on this host — skip
    }
    const t = new FsTransaction();
    t.stage(real, "new");
    expect(() => t.commit()).toThrow(/symlink/);
    expect(readFileSync(outside, "utf8")).toBe("victim"); // copy never followed the link
  });

  it("refuses to write when a symlink is planted at the .aih.tmp scratch path", () => {
    const target = join(dir, "g.txt"); // does not exist yet
    const outside = join(dir, "victim2.txt");
    writeFileSync(outside, "victim");
    try {
      symlinkSync(outside, `${target}.aih.tmp`);
    } catch {
      return;
    }
    const t = new FsTransaction();
    t.stage(target, "new");
    expect(() => t.commit()).toThrow(/symlink/);
    expect(readFileSync(outside, "utf8")).toBe("victim"); // write never followed the link
  });

  it("clears a STALE regular .aih.tmp leftover and still commits", () => {
    const target = join(dir, "h.txt");
    writeFileSync(`${target}.aih.tmp`, "stale leftover from an aborted run");
    const t = new FsTransaction();
    t.stage(target, "fresh");
    t.commit();
    expect(readFileSync(target, "utf8")).toBe("fresh");
  });

  it("consumes a scratch file only when its exact staged bytes still match", () => {
    const target = join(dir, "record.json");
    const contents = '{"record":"expected"}';
    writeFileSync(`${target}.aih.tmp`, '{"record":"substituted"}');
    const t = new FsTransaction();
    t.stage(
      target,
      contents,
      undefined,
      { absent: true },
      {
        root: dir,
        expectScratch: { sha256: createHash("sha256").update(contents).digest("hex") },
      },
    );

    expect(() => t.commit()).toThrow(/write scratch changed before commit/);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(`${target}.aih.tmp`, "utf8")).toBe('{"record":"substituted"}');
  });

  it("does not consume a scratch file when the staged write requires absence", () => {
    const target = join(dir, "record.json");
    writeFileSync(`${target}.aih.tmp`, "unexpected");
    const t = new FsTransaction();
    t.stage(
      target,
      "record",
      undefined,
      { absent: true },
      {
        root: dir,
        expectScratch: { absent: true },
      },
    );

    expect(() => t.commit()).toThrow(/write scratch changed before commit/);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(`${target}.aih.tmp`, "utf8")).toBe("unexpected");
  });

  it("preflights a later scratch expectation before earlier staged writes", () => {
    const earlier = join(dir, "claim.json");
    const target = join(dir, "record.json");
    const contents = '{"record":"expected"}';
    writeFileSync(`${target}.aih.tmp`, '{"record":"substituted"}');
    fsEvents.events = [];
    const t = new FsTransaction();
    t.stage(earlier, '{"claim":"new"}', undefined, { absent: true }, { root: dir });
    t.stage(
      target,
      contents,
      undefined,
      { absent: true },
      {
        root: dir,
        expectScratch: { sha256: createHash("sha256").update(contents).digest("hex") },
      },
    );

    expect(() => t.commit()).toThrow(/write scratch changed before commit/);
    expect(fsEvents.events).not.toContain(`rename:${earlier}`);
    expect(existsSync(earlier)).toBe(false);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(`${target}.aih.tmp`, "utf8")).toBe('{"record":"substituted"}');
  });

  it("rechecks exact scratch bytes immediately before consuming them", () => {
    const target = join(dir, "record.json");
    const contents = '{"record":"expected"}';
    const scratch = `${target}.aih.tmp`;
    writeFileSync(scratch, contents);
    let swapped = false;
    fsEvents.afterRead = (path) => {
      if (swapped || path !== scratch) return;
      swapped = true;
      fsEvents.afterClose = (closed) => {
        if (closed !== scratch) return;
        fsEvents.afterClose = undefined;
        const replacement = `${scratch}.replacement`;
        writeFileSync(replacement, '{"record":"substituted"}');
        renameSync(replacement, scratch);
      };
    };
    const t = new FsTransaction();
    t.stage(
      target,
      contents,
      undefined,
      { absent: true },
      {
        root: dir,
        expectScratch: { sha256: createHash("sha256").update(contents).digest("hex") },
      },
    );

    expect(() => t.commit()).toThrow(/write scratch changed before commit/);
    expect(swapped).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(scratch, "utf8")).toBe('{"record":"substituted"}');
  });

  it("readIfExists returns undefined for a missing file", () => {
    expect(readIfExists(join(dir, "nope"))).toBeUndefined();
  });
});

const PROPERTY_RUNS = 75;
const PROPERTY_SEED = 818;
const PROPERTY_PATHS = ["alpha.txt", "bravo.txt", "charlie.txt"] as const;
const PROPERTY_CONTENT_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789 \\n".split("");

type PropertyWrite = { kind: "write"; pathIndex: number; contents: string };
type PropertyRemoval = { kind: "remove"; pathIndex: number; destination: number };
type PropertyAssertion = { kind: "assert"; pathIndex: number };
type PropertyOperation = PropertyWrite | PropertyRemoval | PropertyAssertion;

const propertyContentsArb = fc
  .array(fc.constantFrom(...PROPERTY_CONTENT_CHARS), { maxLength: 24 })
  .map((chars) => chars.join(""));

const propertyOperationArb: fc.Arbitrary<PropertyOperation> = fc.oneof(
  fc.record({
    kind: fc.constant("write" as const),
    pathIndex: fc.integer({ min: 0, max: PROPERTY_PATHS.length - 1 }),
    contents: propertyContentsArb,
  }),
  fc.record({
    kind: fc.constant("remove" as const),
    pathIndex: fc.integer({ min: 0, max: PROPERTY_PATHS.length - 1 }),
    destination: fc.integer({ min: 0, max: 2 }),
  }),
  fc.record({
    kind: fc.constant("assert" as const),
    pathIndex: fc.integer({ min: 0, max: PROPERTY_PATHS.length - 1 }),
  }),
);

function sha256(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function lastByPath<T extends { pathIndex: number }>(operations: readonly T[]): Map<number, T> {
  const byPath = new Map<number, T>();
  for (const operation of operations) byPath.set(operation.pathIndex, operation);
  return byPath;
}

describe("FsTransaction — bounded property model", () => {
  it("keeps preview inert and commits every non-conflicting staged sequence as modeled", () => {
    fc.assert(
      fc.property(fc.array(propertyOperationArb, { maxLength: 12 }), (operations) => {
        const caseDir = mkdtempSync(join(dir, "property-case-"));
        const paths = PROPERTY_PATHS.map((name) => join(caseDir, name));
        const initial = paths.map((_, index) => `initial-${index}\\n`);
        for (const [index, path] of paths.entries()) writeFileSync(path, initial[index] as string);

        const transaction = new FsTransaction();
        for (const operation of operations) {
          const path = paths[operation.pathIndex] as string;
          if (operation.kind === "write") {
            transaction.stage(path, operation.contents);
          } else if (operation.kind === "remove") {
            transaction.stageRemoval(
              path,
              join(
                caseDir,
                ".aih",
                "legacy",
                `${PROPERTY_PATHS[operation.pathIndex]}-${operation.destination}`,
              ),
            );
          } else {
            transaction.stageAssertion(
              path,
              sha256(initial[operation.pathIndex] as string),
              "property pin",
            );
          }
        }

        const writes = operations.filter(
          (operation): operation is PropertyWrite => operation.kind === "write",
        );
        const removals = operations.filter(
          (operation): operation is PropertyRemoval => operation.kind === "remove",
        );
        const assertions = operations.filter(
          (operation): operation is PropertyAssertion => operation.kind === "assert",
        );
        const finalWrites = lastByPath(writes);
        const finalRemovals = lastByPath(removals);
        const finalAssertions = lastByPath(assertions);

        expect(transaction.preview().map(({ path, contents }) => ({ path, contents }))).toEqual(
          writes.map(({ pathIndex, contents }) => ({ path: paths[pathIndex], contents })),
        );
        for (const [index, path] of paths.entries()) {
          expect(readFileSync(path, "utf8")).toBe(initial[index]);
        }

        const mutatesAssertionPath = [...finalAssertions.keys()].some(
          (pathIndex) => finalWrites.has(pathIndex) || finalRemovals.has(pathIndex),
        );
        const writesAndRemovesSamePath = [...finalWrites.keys()].some((pathIndex) =>
          finalRemovals.has(pathIndex),
        );
        if (mutatesAssertionPath || writesAndRemovesSamePath) {
          expect(() => transaction.commit()).toThrow();
          for (const [index, path] of paths.entries()) {
            expect(readFileSync(path, "utf8")).toBe(initial[index]);
          }
          return;
        }

        const result = transaction.commit();
        expect(result.written).toEqual(
          [...finalWrites.values()].map(({ pathIndex }) => paths[pathIndex]),
        );
        expect(result.backups).toEqual(
          [...finalWrites.values()].map(({ pathIndex }) => `${paths[pathIndex]}.aih.bak`),
        );
        expect(result.removed).toEqual(
          [...finalRemovals.values()].map(({ pathIndex, destination }) => ({
            path: paths[pathIndex],
            legacyPath: join(
              caseDir,
              ".aih",
              "legacy",
              `${PROPERTY_PATHS[pathIndex]}-${destination}`,
            ),
          })),
        );
        for (const [pathIndex, write] of finalWrites) {
          const path = paths[pathIndex] as string;
          expect(readFileSync(path, "utf8")).toBe(write.contents);
          expect(readFileSync(`${path}.aih.bak`, "utf8")).toBe(initial[pathIndex]);
        }
        for (const [pathIndex, removal] of finalRemovals) {
          const path = paths[pathIndex] as string;
          const legacyPath = join(
            caseDir,
            ".aih",
            "legacy",
            `${PROPERTY_PATHS[pathIndex]}-${removal.destination}`,
          );
          expect(existsSync(path)).toBe(false);
          expect(readFileSync(legacyPath, "utf8")).toBe(initial[pathIndex]);
        }
      }),
      { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
    );
  });

  it("rolls back injected write failures to their pre-transaction state", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pathIndex: fc.integer({ min: 0, max: PROPERTY_PATHS.length - 1 }),
            revision: fc.integer({ min: 0, max: 999 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (writes) => {
          const caseDir = mkdtempSync(join(dir, "property-case-"));
          const paths = PROPERTY_PATHS.map((name) => join(caseDir, name));
          const initial = paths.map((_, index) => `initial-${index}\\n`);
          for (const [index, path] of paths.entries())
            writeFileSync(path, initial[index] as string);

          const failureParent = join(caseDir, "failure-parent");
          writeFileSync(failureParent, "not a directory");
          const transaction = new FsTransaction();
          for (const write of writes) {
            transaction.stage(paths[write.pathIndex] as string, `generated-${write.revision}\\n`);
          }
          transaction.stage(join(failureParent, "child.txt"), "must not be written");

          expect(() => transaction.commit()).toThrow();
          for (const [index, path] of paths.entries()) {
            expect(readFileSync(path, "utf8")).toBe(initial[index]);
            expect(existsSync(`${path}.aih.bak`)).toBe(false);
          }
        },
      ),
      { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
    );
  });

  it("preserves operator-mutated files while rolling back generated writes", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ existed: fc.boolean(), operatorMutated: fc.boolean() }), {
          minLength: 1,
          maxLength: 4,
        }),
        (scenarios) => {
          const caseDir = mkdtempSync(join(dir, "property-case-"));
          const applied = scenarios.map((scenario, index) => {
            const path = join(caseDir, `rollback-${index}.txt`);
            const initial = `before-${index}\\n`;
            const generated = `generated-${index}\\n`;
            const operator = `operator-${index}\\n`;
            const backup = `${path}.aih.bak`;
            if (scenario.existed) {
              writeFileSync(path, initial);
              writeFileSync(backup, initial);
            }
            writeFileSync(path, generated);
            if (scenario.operatorMutated) writeFileSync(path, operator);
            return { path, initial, generated, operator, backup, ...scenario };
          });

          const preserved = rollbackAppliedWrites(
            applied.map(({ path, generated, backup, existed }) => ({
              path,
              contents: generated,
              backup: existed ? backup : undefined,
              created: !existed,
            })),
          );

          expect([...preserved].sort()).toEqual(
            applied
              .filter(({ operatorMutated }) => operatorMutated)
              .map(({ path }) => path)
              .sort(),
          );
          for (const scenario of applied) {
            if (scenario.operatorMutated) {
              expect(readFileSync(scenario.path, "utf8")).toBe(scenario.operator);
              if (scenario.existed)
                expect(readFileSync(scenario.backup, "utf8")).toBe(scenario.initial);
            } else if (scenario.existed) {
              expect(readFileSync(scenario.path, "utf8")).toBe(scenario.initial);
              expect(existsSync(scenario.backup)).toBe(false);
            } else {
              expect(existsSync(scenario.path)).toBe(false);
            }
          }
        },
      ),
      { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
    );
  });
});

/** A NodeJS errno error carrying a syscall `code` (what fs throws on a lock). */
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe("retryTransient", () => {
  it("retries a transient Windows lock code, then returns the value", () => {
    let calls = 0;
    const out = retryTransient(() => {
      calls += 1;
      if (calls < 3) throw errno("EBUSY"); // AV/indexer holds the handle, briefly
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(3); // failed twice, succeeded on the third
  });

  it("re-throws a non-transient error on the first attempt (never masks a real failure)", () => {
    let calls = 0;
    expect(() =>
      retryTransient(() => {
        calls += 1;
        throw errno("EEXIST"); // exclusive-create collision — not a transient lock
      }),
    ).toThrow("EEXIST");
    expect(calls).toBe(1); // no retry
  });

  it("gives up after the bounded retry budget and throws the transient error", () => {
    let calls = 0;
    expect(() =>
      retryTransient(() => {
        calls += 1;
        throw errno("EACCES");
      }),
    ).toThrow("EACCES");
    expect(calls).toBe(10); // MAX_LOCK_RETRIES — bounded, never an infinite loop
  });
});

describe("FsTransaction — removals (aih prune)", () => {
  const put = (name: string, body = "x"): string => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  it("commit MOVES the file to its legacy path and reports it", () => {
    const src = put("codex.md", "# codex\n");
    const legacy = join(dir, ".aih", "legacy", "codex.md");
    const t = new FsTransaction();
    t.stageRemoval(src, legacy);
    const res = t.commit();
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(legacy, "utf8")).toBe("# codex\n");
    expect(res.removed).toEqual([{ path: src, legacyPath: legacy }]);
  });

  it("is a no-op when the source is already gone (idempotent)", () => {
    const t = new FsTransaction();
    t.stageRemoval(join(dir, "missing.md"), join(dir, ".aih", "legacy", "missing.md"));
    const res = t.commit();
    expect(res.removed).toEqual([]);
  });

  it("never overwrites an occupied legacy dest — a second rescue lands at .N", () => {
    const legacy = join(dir, ".aih", "legacy", "codex.md");
    // First rescue: codex.md V1 → legacy.
    const t1 = new FsTransaction();
    t1.stageRemoval(put("codex.md", "V1"), legacy);
    t1.commit();
    expect(readFileSync(legacy, "utf8")).toBe("V1");
    // codex.md is repopulated (re-bootstrapped) and pruned again: V1 must survive.
    const t2 = new FsTransaction();
    t2.stageRemoval(put("codex.md", "V2"), legacy);
    const res = t2.commit();
    expect(readFileSync(legacy, "utf8")).toBe("V1"); // first rescue preserved
    expect(readFileSync(`${legacy}.1`, "utf8")).toBe("V2"); // second lands beside it
    expect(res.removed[0]?.legacyPath).toBe(`${legacy}.1`);
  });

  it("refuses a transaction that both writes and removes the same path", () => {
    const p = put("x.md", "hi");
    const t = new FsTransaction();
    t.stage(p, "new content");
    t.stageRemoval(p, join(dir, ".aih", "legacy", "x.md"));
    expect(() => t.commit()).toThrow(/both writes and removes/);
    // Fail-closed: nothing happened.
    expect(readFileSync(p, "utf8")).toBe("hi");
  });

  it("rolls an applied removal BACK when a later removal fails", () => {
    const a = put("a.md", "AAA");
    const bLink = join(dir, "b.md");
    try {
      symlinkSync(join(dir, "a.md"), bLink); // a symlink source → commit refuses it
    } catch {
      return; // symlink creation not permitted (e.g. Windows) — skip
    }
    const legacyA = join(dir, ".aih", "legacy", "a.md");
    const legacyB = join(dir, ".aih", "legacy", "b.md");
    const t = new FsTransaction();
    t.stageRemoval(a, legacyA); // succeeds first
    t.stageRemoval(bLink, legacyB); // symlink → throws → rollback
    expect(() => t.commit()).toThrow(/symlink/);
    // A was restored to its original location, not stranded in legacy.
    expect(readFileSync(a, "utf8")).toBe("AAA");
    expect(existsSync(legacyA)).toBe(false);
  });

  it("restores a removal target when its apply-time content pin no longer matches", () => {
    const source = put("owned.md", "operator changed bytes\n");
    const legacy = join(dir, ".aih", "legacy", "owned.md");
    const transaction = new FsTransaction();
    transaction.stageRemoval(source, legacy, {
      expect: {
        sha256: createHash("sha256").update("planned owned bytes\n", "utf8").digest("hex"),
      },
    });

    expect(() => transaction.commit()).toThrow(/changed before commit/);
    expect(readFileSync(source, "utf8")).toBe("operator changed bytes\n");
    expect(existsSync(legacy)).toBe(false);
  });

  it("rolls back staged writes when an asserted authority file changed", () => {
    const authority = put("ownership.json", "changed authority\n");
    const generated = join(dir, "generated.md");
    const transaction = new FsTransaction();
    transaction.stage(generated, "generated bytes\n");
    transaction.stageAssertion(
      authority,
      createHash("sha256").update("planned authority\n", "utf8").digest("hex"),
      "ownership receipt",
    );

    expect(() => transaction.commit()).toThrow(/ownership receipt changed before commit/);
    expect(existsSync(generated)).toBe(false);
    expect(readFileSync(authority, "utf8")).toBe("changed authority\n");
  });

  it("rejects a transaction that both asserts and mutates the same authority path", () => {
    const authority = put("ownership.json", "owned bytes\n");
    const transaction = new FsTransaction();
    transaction.stage(authority, "replacement bytes\n");
    transaction.stageAssertion(
      authority,
      createHash("sha256").update("owned bytes\n", "utf8").digest("hex"),
      "ownership receipt",
    );

    expect(() => transaction.commit()).toThrow(/both asserts and mutates.*ownership\.json/i);
    expect(readFileSync(authority, "utf8")).toBe("owned bytes\n");
  });
});

describe("FsTransaction — hard-delete removals (backupSibling)", () => {
  const put = (name: string, body = "x"): string => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  it("renames the file to the .aih.bak destination", () => {
    const src = put("codex.md", "# codex\n");
    const bak = `${src}.aih.bak`;
    const t = new FsTransaction();
    t.stageRemoval(src, bak, { backupSibling: true });
    const res = t.commit();
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(bak, "utf8")).toBe("# codex\n");
    expect(res.removed).toEqual([{ path: src, legacyPath: bak }]);
  });

  it("never destroys an occupied .aih.bak — a second hard-delete lands at .1.aih.bak", () => {
    // An existing .aih.bak may be the ONLY copy of never-committed content (a prior
    // write backup or rescue) — hard-delete must not rmSync it (safety-review high).
    const bak = join(dir, "codex.md.aih.bak");
    const t1 = new FsTransaction();
    t1.stageRemoval(put("codex.md", "V1"), bak, { backupSibling: true });
    t1.commit();
    const t2 = new FsTransaction();
    t2.stageRemoval(put("codex.md", "V2"), bak, { backupSibling: true });
    const res = t2.commit();
    expect(readFileSync(bak, "utf8")).toBe("V1"); // first backup preserved
    // Second lands at a sibling that STILL matches the gitignored *.aih.bak glob.
    expect(readFileSync(join(dir, "codex.md.1.aih.bak"), "utf8")).toBe("V2");
    expect(res.removed[0]?.legacyPath).toBe(join(dir, "codex.md.1.aih.bak"));
  });

  it("still refuses a symlink planted at the backup destination", () => {
    const src = put("codex.md", "# codex\n");
    const bak = `${src}.aih.bak`;
    try {
      symlinkSync(join(dir, "elsewhere.md"), bak);
    } catch {
      return; // symlink creation not permitted on this host — skip
    }
    const t = new FsTransaction();
    t.stageRemoval(src, bak, { backupSibling: true });
    expect(() => t.commit()).toThrow(/symlink/);
    expect(readFileSync(src, "utf8")).toBe("# codex\n"); // untouched
  });
});

describe("readRegularFile — the fd-guarded read for scan-discovered paths", () => {
  it("returns the exact bytes of a regular file", () => {
    writeFileSync(join(dir, "a.json"), '{"ok":true}\n', "utf8");
    expect(readRegularFile(join(dir, "a.json"))?.toString("utf8")).toBe('{"ok":true}\n');
  });

  it("returns bytes and descriptor stats from one opened regular file", () => {
    writeFileSync(join(dir, "stats.json"), '{"stats":true}\n', "utf8");
    const file = readRegularFileWithStats(join(dir, "stats.json"));
    expect(file?.contents.toString("utf8")).toBe('{"stats":true}\n');
    expect(file?.stats.isFile()).toBe(true);
    expect(file?.identity).toMatchObject({
      dev: expect.any(BigInt),
      ino: expect.any(BigInt),
      nlink: 1n,
    });
  });

  it("refuses an oversized regular file before reading from the opened descriptor", () => {
    writeFileSync(join(dir, "large.txt"), "oversized", "utf8");
    expect(
      readRegularFileWithStats(join(dir, "large.txt"), { maxBytes: "small".length }),
    ).toBeUndefined();
  });

  it("enforces the byte cap while reading an already-open descriptor", () => {
    const path = join(dir, "grown-after-stat.txt");
    writeFileSync(path, "small-then-concurrently-grown", "utf8");
    const fd = openSync(path, "r");
    try {
      expect(readBoundedFileDescriptor(fd, "small".length)).toBeUndefined();
    } finally {
      closeSync(fd);
    }
  });

  it("keeps the no-O_NOFOLLOW identity fallback on exact BigInt stats", () => {
    const source = readFileSync(join(process.cwd(), "src", "internals", "fsxn.ts"), "utf8");
    expect(source).toContain("fstatSync(fd, { bigint: true })");
    expect(source).toContain("lstatSync(path, { bigint: true })");
    expect(source).toContain("a.ino === 0n");
  });

  it("returns undefined for a missing path", () => {
    expect(readRegularFile(join(dir, "absent.json"))).toBeUndefined();
  });

  it("returns undefined for a directory", () => {
    mkdirSync(join(dir, "sub"));
    expect(readRegularFile(join(dir, "sub"))).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "refuses a FIFO promptly in a bounded child process",
    () => {
      const fifo = join(dir, "managed-settings.json");
      const child = join(dir, "read-fifo.mjs");
      execFileSync("mkfifo", [fifo]);
      writeFileSync(
        child,
        [
          "const { readRegularFile, readRegularFileWithStats } = await import(process.argv[2]);",
          "const fifo = process.argv[3];",
          "if (readRegularFile(fifo) !== undefined) process.exit(2);",
          "if (readRegularFileWithStats(fifo) !== undefined) process.exit(3);",
        ].join("\n"),
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          child,
          pathToFileURL(join(process.cwd(), "src", "internals", "fsxn.ts")).href,
          fifo,
        ],
        { encoding: "utf8", timeout: 3_000 },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    },
    10_000,
  );

  it("refuses a symlink instead of following it", () => {
    writeFileSync(join(dir, "target.json"), "secret\n", "utf8");
    try {
      symlinkSync(join(dir, "target.json"), join(dir, "link.json"));
    } catch {
      return; // symlink creation needs privileges on Windows — skip
    }
    expect(readRegularFile(join(dir, "link.json"))).toBeUndefined();
  });
});
