import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FsTransaction,
  readIfExists,
  readRegularFile,
  retryTransient,
} from "../../src/internals/fsxn.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-fsxn-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FsTransaction", () => {
  it("preview does not touch disk", () => {
    const t = new FsTransaction();
    t.stage(join(dir, "a.txt"), "hi");
    expect(t.preview()).toHaveLength(1);
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
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

  it("returns undefined for a missing path", () => {
    expect(readRegularFile(join(dir, "absent.json"))).toBeUndefined();
  });

  it("returns undefined for a directory", () => {
    mkdirSync(join(dir, "sub"));
    expect(readRegularFile(join(dir, "sub"))).toBeUndefined();
  });

  it("refuses a symlink instead of following it (POSIX O_NOFOLLOW)", () => {
    writeFileSync(join(dir, "target.json"), "secret\n", "utf8");
    try {
      symlinkSync(join(dir, "target.json"), join(dir, "link.json"));
    } catch {
      return; // symlink creation needs privileges on Windows — skip
    }
    // Windows has no O_NOFOLLOW at runtime; there the guarantee is the
    // single-descriptor check-then-read, exercised by the cases above.
    if (process.platform !== "win32") {
      expect(readRegularFile(join(dir, "link.json"))).toBeUndefined();
    }
  });
});
