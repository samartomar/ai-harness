import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  afterTempWrite: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    fsyncSync: (fd: number) => {
      fsEvents.events.push("fsync");
      return original.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      fsEvents.events.push(`rename:${to}`);
      return original.renameSync(from, to);
    },
    writeFileSync: (path: string, data: string | NodeJS.ArrayBufferView, options?: unknown) => {
      const result = original.writeFileSync(path, data, options as never);
      if (path.endsWith(".aih.tmp")) fsEvents.afterTempWrite?.(path);
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
  rmSync(dir, { recursive: true, force: true });
});

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

  it("removes its lock and lock parent after a failed transaction", () => {
    const lock = join(dir, ".aih", "commit.lock");
    const blockingFile = join(dir, "blocking-file");
    writeFileSync(blockingFile, "not a directory");
    const t = new FsTransaction({ commitLock: { path: lock, root: dir } });
    t.stage(join(blockingFile, "child.txt"), "blocked", undefined, undefined, { root: dir });

    expect(() => t.commit()).toThrow();
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(join(dir, ".aih"))).toBe(false);
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
