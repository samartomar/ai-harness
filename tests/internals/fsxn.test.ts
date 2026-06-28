import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsTransaction, readIfExists, retryTransient } from "../../src/internals/fsxn.js";

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
