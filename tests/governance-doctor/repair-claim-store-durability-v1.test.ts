import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireGovernanceDoctorRepairClaimV1,
  GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_LIMITS,
} from "../../src/governance-doctor/repair-claim-store-v1.js";
import {
  canonicalGovernanceDoctorRepairClaimV1Bytes,
  createGovernanceDoctorRepairClaimV1,
  governanceDoctorRepairClaimFileNameV1,
  governanceDoctorRepairClaimScopeSha256V1,
} from "../../src/governance-doctor/repair-claim-v1.js";
import type { GovernanceDoctorRepairPlanV1 } from "../../src/governance-doctor/repair-plan-v1.js";
import {
  REPAIR_FIXTURE_ATTEMPTED_AT,
  type RepairFixtureEffect,
  type RepairFixtureHome,
  repairFixtureClaimStoreDirectory,
  repairFixtureConsent,
  repairFixtureIsolatedHome,
  repairFixturePlan,
} from "./repair-execution-fixture-v1.js";

/**
 * Deterministic filesystem interposition for the durable claim commit.
 *
 * A torn write, a kernel that consumes nothing, a flush that never reaches the
 * platter, a hostile directory that never ends, and a second process substituting
 * the store between one syscall and the next cannot be scheduled from a test, so
 * each is expressed as a seam instead: the write can be made to return short, to
 * return no progress, to over-report, or to fail part way; a directory flush can be
 * refused by path; the store's enumeration can be handed an endless directory; and
 * hooks can run immediately after the store is enumerated, immediately before the
 * exclusive create, immediately after the created record is closed, and immediately
 * after it is read back.
 *
 * Two rules are checked at every one of those points. However the commit fails, the
 * record it created stays -- so the Plan stays spent and the next attempt refuses
 * rather than replaying. And a name or an object this transaction did not create is
 * never written over, never removed, and never reported as committed.
 *
 * ## The bounded proof
 *
 * Node exposes no way to open a directory and then create a name inside that open
 * handle, so the gap between proving the store and creating the record in it is a
 * path lookup this module cannot close. What is proved here is therefore bounded
 * and deliberately not called atomicity: the store's canonical path and its
 * `dev`+`ino` identity are re-proved immediately before the exclusive create and
 * again after the flushes and the read-back, so a substitution that spans either
 * boundary is refused. A substitution that lands and is reverted entirely inside
 * one syscall is outside what these APIs can observe, and is not claimed.
 */
const interposition = vi.hoisted(() => ({
  afterClaimCreate: null as null | (() => void),
  afterClaimReadback: null as null | (() => void),
  afterStoreEnumeration: null as null | (() => void),
  beforeExclusiveCreate: null as null | (() => void),
  beforeRecordRead: null as null | (() => void),
  directoryClosed: false,
  directoryReads: 0,
  failDirectorySyncFor: null as null | string,
  failFileSync: false,
  hostileDirectory: false,
  noProgressWrite: false,
  overReportWrite: false,
  shortWrite: false,
  throwAfterPartialWrite: false,
  trace: [] as string[],
  writes: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const open = new Map<number, string>();
  const fire = (
    name: "afterClaimCreate" | "afterClaimReadback" | "afterStoreEnumeration",
  ): void => {
    const hook = interposition[name];
    if (hook === null) return;
    interposition[name] = null;
    hook();
  };
  const interposed = {
    ...actual,
    closeSync: (fd: number): void => {
      const role = open.get(fd);
      open.delete(fd);
      actual.closeSync(fd);
      // The created record is closed before its directory entry is flushed, and the
      // read-back handle is closed before the run returns. Both are substitution
      // boundaries the commit has to survive.
      if (role === "exclusive") fire("afterClaimCreate");
      else if (role === "readback") fire("afterClaimReadback");
    },
    // A directory handle and a file handle are refused independently: only one of
    // them is the flush that makes the bytes themselves durable.
    fsyncSync: (fd: number): void => {
      if (actual.fstatSync(fd).isDirectory()) {
        const path = open.get(fd);
        if (path !== undefined) interposition.trace.push(`fsyncdir:${path}`);
        if (interposition.failDirectorySyncFor === path)
          throw Object.assign(new Error("interposed flush failure"), { code: "EIO" });
      } else if (interposition.failFileSync)
        throw Object.assign(new Error("interposed flush failure"), { code: "EIO" });
      actual.fsyncSync(fd);
    },
    mkdirSync: ((path: string, options?: unknown): string | undefined => {
      interposition.trace.push(`mkdir:${path}`);
      return (actual.mkdirSync as (p: string, o?: unknown) => string | undefined)(path, options);
    }) as typeof actual.mkdirSync,
    opendirSync: ((path: string, options?: unknown): unknown => {
      if (interposition.hostileDirectory)
        // A directory that never ends. Materializing it would be the defect; the
        // store has to stop reading at its own ceiling and close the handle.
        return {
          closeSync: (): void => {
            interposition.directoryClosed = true;
            fire("afterStoreEnumeration");
          },
          readSync: (): unknown => {
            interposition.directoryReads += 1;
            return { isFile: () => true, name: `${interposition.directoryReads}.json` };
          },
        };
      const handle = (actual.opendirSync as (p: string, o?: unknown) => { closeSync: () => void })(
        path,
        options,
      );
      return {
        ...handle,
        closeSync: (): void => {
          handle.closeSync();
          fire("afterStoreEnumeration");
        },
        readSync: () => (handle as unknown as { readSync: () => unknown }).readSync(),
      };
    }) as typeof actual.opendirSync,
    openSync: (path: string, flags: number, mode?: number): number => {
      const exclusive = (flags & actual.constants.O_EXCL) !== 0;
      if (exclusive) {
        const hook = interposition.beforeExclusiveCreate;
        interposition.beforeExclusiveCreate = null;
        if (hook !== null) hook();
      }
      // The window the record read path has to survive: the caller's `lstat`
      // has already proved one object, and this is the open that must still be
      // reading that same object.
      if (!exclusive && path.endsWith(".json")) {
        const hook = interposition.beforeRecordRead;
        interposition.beforeRecordRead = null;
        if (hook !== null) hook();
      }
      const fd = actual.openSync(path, flags, mode);
      open.set(fd, exclusive ? "exclusive" : path.endsWith(".json") ? "readback" : path);
      return fd;
    },
    writeSync: (fd: number, buffer: Buffer, offset: number, length: number): number => {
      interposition.writes += 1;
      const first = interposition.writes === 1;
      const partial = Math.max(1, Math.floor(length / 2));
      if (first && interposition.throwAfterPartialWrite) {
        actual.writeSync(fd, buffer, offset, partial);
        throw Object.assign(new Error("interposed write failure"), { code: "EIO" });
      }
      // A kernel that consumes nothing must never be retried forever, and one that
      // reports more than it was handed must never be believed.
      if (interposition.noProgressWrite) return 0;
      if (interposition.overReportWrite) return length + 1;
      // A kernel is always free to consume less than it was handed; the commit has
      // to drive the write to completion rather than publish a truncated record.
      return actual.writeSync(
        fd,
        buffer,
        offset,
        first && interposition.shortWrite ? partial : length,
      );
    },
  };
  return { ...interposed, default: interposed };
});

/**
 * The claim store resolves its own location from the OS account, never from
 * `HOME` or `USERPROFILE`, and exposes no caller input and no test setter for it.
 * The only seam a suite may use is therefore the platform module itself.
 */
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { repairFixtureOsModuleV1 } = await import("./repair-account-home-v1.js");
  return repairFixtureOsModuleV1(actual);
});

let root: string;
let home: RepairFixtureHome;

const NOT_COMMITTED = /^GOVERNANCE_DOCTOR_REPAIR_V1: repair claim did not commit$/;
const ALREADY = /^GOVERNANCE_DOCTOR_REPAIR_V1: repair plan was already claimed$/;
const UNREADABLE =
  /^GOVERNANCE_DOCTOR_REPAIR_V1: repair claim store holds a record this authority cannot read$/;
const UNAVAILABLE = /^GOVERNANCE_DOCTOR_REPAIR_V1: repair claim store is not available$/;
const OVER_CAPACITY =
  /^GOVERNANCE_DOCTOR_REPAIR_V1: repair claim store exceeds its bounded record count$/;

const EFFECTS: readonly RepairFixtureEffect[] = [
  { arguments: { path: "canon" }, effectId: "ensure-canon", templateId: "ensure-canon-directory" },
];

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_ATTEMPTED_AT);
  interposition.afterClaimCreate = null;
  interposition.afterClaimReadback = null;
  interposition.afterStoreEnumeration = null;
  interposition.beforeExclusiveCreate = null;
  interposition.directoryClosed = false;
  interposition.directoryReads = 0;
  interposition.failDirectorySyncFor = null;
  interposition.failFileSync = false;
  interposition.hostileDirectory = false;
  interposition.noProgressWrite = false;
  interposition.overReportWrite = false;
  interposition.shortWrite = false;
  interposition.throwAfterPartialWrite = false;
  interposition.trace = [];
  interposition.writes = 0;
  home = repairFixtureIsolatedHome();
  root = mkdtempSync(join(realpathSync.native(tmpdir()), "aih-repair-durable-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  home.release();
  rmSync(root, { force: true, recursive: true });
});

async function plan(): Promise<GovernanceDoctorRepairPlanV1> {
  return repairFixturePlan({ effects: EFFECTS, root, scopePaths: ["canon"] });
}

function acquire(built: GovernanceDoctorRepairPlanV1) {
  return acquireGovernanceDoctorRepairClaimV1({
    consent: repairFixtureConsent(built),
    plan: built,
    rootRealPath: realpathSync.native(root),
  });
}

function store(): string {
  return repairFixtureClaimStoreDirectory(home.path);
}

/** Somewhere inside the fixture home to move the proved store aside to. */
function aside(): string {
  return join(home.path, "aside");
}

/**
 * The exact name the pending acquisition will create, derived the same way the
 * store derives it: from the claim identity and nothing else.
 */
function claimPath(built: GovernanceDoctorRepairPlanV1): string {
  return join(store(), governanceDoctorRepairClaimFileNameV1(pristine(built).claimSha256));
}

/** The single record the store holds, or a failure if it holds anything else. */
function soleRecord(): Buffer {
  const names = readdirSync(store());
  expect(names).toHaveLength(1);
  return readFileSync(join(store(), names[0] as string));
}

describe("durable claim commit under filesystem interposition", () => {
  it("drives a short write to completion instead of publishing a truncated record", async () => {
    interposition.shortWrite = true;
    const built = await plan();
    const claim = acquire(built);

    expect(interposition.writes).toBeGreaterThan(1);
    expect(soleRecord().equals(canonicalGovernanceDoctorRepairClaimV1Bytes(claim))).toBe(true);
  });

  it("refuses a torn write and still leaves the plan spent", async () => {
    interposition.throwAfterPartialWrite = true;
    const built = await plan();

    expect(() => acquire(built)).toThrow(NOT_COMMITTED);
    // The record was created before the write, so it is still there -- truncated.
    const torn = soleRecord();
    expect(torn.length).toBeGreaterThan(0);
    expect(torn.equals(canonicalGovernanceDoctorRepairClaimV1Bytes(pristine(built)))).toBe(false);

    // And the truncation is never read as absence. An interruption spends the Plan.
    interposition.throwAfterPartialWrite = false;
    expect(() => acquire(built)).toThrow(UNREADABLE);
    expect(soleRecord().equals(torn)).toBe(true);
  });

  /**
   * Resolved -- the reviewed no-progress defect. A `writeSync` that consumes
   * nothing used to spin the commit loop forever, which is the one outcome worse
   * than refusing: the run neither commits nor returns.
   */
  it("refuses a write that makes no progress rather than looping on it", async () => {
    interposition.noProgressWrite = true;
    const built = await plan();

    expect(() => acquire(built)).toThrow(NOT_COMMITTED);
    // The exclusive create already happened, so the empty record stays and spends
    // the Plan exactly as a torn one does.
    expect(soleRecord()).toHaveLength(0);

    interposition.noProgressWrite = false;
    expect(() => acquire(built)).toThrow(UNREADABLE);
    expect(soleRecord()).toHaveLength(0);
  });

  it("refuses a write that reports more progress than it was handed", async () => {
    interposition.overReportWrite = true;
    const built = await plan();

    expect(() => acquire(built)).toThrow(NOT_COMMITTED);
    expect(soleRecord()).toHaveLength(0);

    interposition.overReportWrite = false;
    expect(() => acquire(built)).toThrow(UNREADABLE);
  });

  it("refuses a record whose bytes were never flushed, and never retries it", async () => {
    interposition.failFileSync = true;
    const built = await plan();

    expect(() => acquire(built)).toThrow(NOT_COMMITTED);
    const written = soleRecord();

    interposition.failFileSync = false;
    expect(() => acquire(built)).toThrow(ALREADY);
    expect(soleRecord().equals(written)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a directory entry that was never flushed, and never retries it",
    async () => {
      const built = await plan();
      // The store directory itself already exists by the time the record is
      // created, so only the record's own entry flush is refused here.
      interposition.failDirectorySyncFor = store();

      expect(() => acquire(built)).toThrow(NOT_COMMITTED);
      const written = soleRecord();

      interposition.failDirectorySyncFor = null;
      expect(() => acquire(built)).toThrow(ALREADY);
      expect(soleRecord().equals(written)).toBe(true);
    },
  );

  /**
   * Resolved -- the reviewed first-use durability defect. Creating the three
   * controlled segments made the store reachable but not durable: flushing the
   * record and the store directory says nothing about the entries that name the
   * store's own ancestry, so a power loss on first use could lose the whole store
   * -- and a lost store reads as "never claimed".
   *
   * Every newly created segment is now followed immediately by a flush of the
   * already-proved parent directory that names it, before the next segment is
   * touched. Windows exposes no directory handle, so this ordering is asserted on
   * POSIX only; that gap is the store's recorded platform limitation.
   */
  it.skipIf(process.platform === "win32")(
    "flushes the naming parent directory after each controlled segment it creates",
    async () => {
      const built = await plan();
      const aih = join(home.path, ".aih");
      const doctor = join(aih, "governance-doctor");
      acquire(built);

      expect(interposition.trace.slice(0, 6)).toEqual([
        `mkdir:${aih}`,
        `fsyncdir:${home.path}`,
        `mkdir:${doctor}`,
        `fsyncdir:${aih}`,
        `mkdir:${store()}`,
        `fsyncdir:${doctor}`,
      ]);
      // And the record's own entry is flushed once, after the store already exists.
      expect(interposition.trace.filter((step) => step === `fsyncdir:${store()}`)).toHaveLength(1);
      expect(interposition.trace.indexOf(`fsyncdir:${store()}`)).toBeGreaterThan(5);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses first use when a created segment's parent entry cannot be flushed",
    async () => {
      const built = await plan();
      interposition.failDirectorySyncFor = home.path;

      expect(() => acquire(built)).toThrow(UNAVAILABLE);
      // The run stopped at the first unflushed ancestry entry: no deeper segment, no
      // store, no record, and therefore no route to an effect.
      expect(existsSync(join(home.path, ".aih", "governance-doctor"))).toBe(false);
      expect(existsSync(store())).toBe(false);
    },
  );

  /**
   * Resolved -- the reviewed unbounded-enumeration defect. Reading a hostile
   * directory into an array before checking the ceiling is the ceiling failing
   * open: the array is built first and the refusal arrives after the memory does.
   */
  it("stops enumerating a hostile store at its ceiling and closes the handle", async () => {
    const built = await plan();
    // Let the store's own segments be created first, then hand the enumeration a
    // directory that never ends.
    mkdirSync(store(), { recursive: true });
    interposition.hostileDirectory = true;

    expect(() => acquire(built)).toThrow(OVER_CAPACITY);
    expect(interposition.directoryReads).toBe(
      GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_LIMITS.maxStoreRecords,
    );
    expect(interposition.directoryClosed).toBe(true);
  });

  it("lets exactly one writer win the name and never writes over the winner", async () => {
    const built = await plan();
    const foreign = Buffer.from("a record this transaction did not create", "utf8");
    // Between the absence check and the exclusive create, someone else takes the
    // name. The create is the lock, so losing it is indistinguishable from finding
    // the record already there -- and there is nothing to steal back.
    interposition.beforeExclusiveCreate = () => {
      expect(readdirSync(store())).toEqual([]);
      writeFileSync(claimPath(built), foreign);
    };

    expect(() => acquire(built)).toThrow(ALREADY);
    expect(soleRecord().equals(foreign)).toBe(true);
    // The loser left nothing behind: no scratch, no tombstone, no second name.
    expect(readdirSync(store())).toHaveLength(1);
  });

  /**
   * Resolved -- the reviewed parent-race defect. The controlled segments were
   * proved once and then addressed by path for the rest of the run, so a store
   * substituted after that proof was written into as if it were the proved one.
   */
  it("refuses a store substituted after it was proved and before the create", async () => {
    const built = await plan();
    let created = false;
    interposition.beforeExclusiveCreate = () => {
      created = true;
    };
    interposition.afterStoreEnumeration = () => {
      renameSync(store(), aside());
      mkdirSync(store(), { recursive: false });
      writeFileSync(join(store(), "foreign.txt"), "not this authority");
    };

    expect(() => acquire(built)).toThrow(UNAVAILABLE);
    expect(created).toBe(false);
    // The foreign directory is preserved exactly, and nothing was created in it.
    expect(readdirSync(store())).toEqual(["foreign.txt"]);
    expect(readFileSync(join(store(), "foreign.txt"), "utf8")).toBe("not this authority");
    expect(readdirSync(aside())).toEqual([]);
  });

  /**
   * The record read path proves the object it opened is the object the caller's
   * own `lstat` proved, and refuses a different inode swapped in behind the name
   * even when that inode holds a byte-identical, correctly-digested record.
   *
   * This is the whole bound where the platform defines no `O_NOFOLLOW`: without
   * the identity comparison the substituted target reads as a valid claim, and
   * the run reports `already claimed` about a record it never wrote. The refusal
   * has to be `unreadable` -- the one label that says the store holds something
   * this authority will not vouch for.
   */
  it("refuses a record whose inode changed between the proof and the open", async () => {
    const built = await plan();
    acquire(built);
    const name = readdirSync(store())[0] as string;
    const record = join(store(), name);
    const authentic = readFileSync(record);

    interposition.beforeRecordRead = () => {
      // Byte-identical content, different inode: only the identity comparison
      // can tell these apart. The replacement is built while the original still
      // occupies its name and then renamed over it, so the new file can never
      // be handed the freed inode -- removing first and rewriting lets a
      // filesystem that recycles inodes reproduce the original identity and
      // quietly turn this into a no-op.
      const replacement = `${record}.replacement`;
      writeFileSync(replacement, authentic);
      renameSync(replacement, record);
    };
    expect(() => acquire(built)).toThrow(UNREADABLE);
    // The substituted bytes are left exactly as they were found.
    expect(readFileSync(record).equals(authentic)).toBe(true);
  });

  /**
   * A home carried away and rebuilt *fresh* mid-run is refused on both platform
   * families -- a regression guard, not a new rule.
   *
   * This is the shape the store's own identity proof catches on every host: the
   * replacement is built empty, so its store is a new inode. It is deliberately
   * NOT the harder shape the module header describes, where a substitution
   * relocates the existing `.aih` subtree into the replacement and preserves the
   * store inode; POSIX refuses that through the home's ancestry and Windows
   * records it as a gap. Any future change that weakens the store-identity proof
   * has to keep this outcome.
   */
  it("refuses a home replaced by a different real directory after it was proved", async () => {
    const built = await plan();
    mkdirSync(store(), { recursive: true });
    // Own the destination the same way every other path in this suite does:
    // realpath'd and uniquely created, never a predictable shared-temp name the
    // cleanup below could then remove out from under someone else.
    const movedParent = mkdtempSync(join(realpathSync.native(tmpdir()), "aih-repair-moved-"));
    const moved = join(movedParent, "home");
    interposition.afterStoreEnumeration = () => {
      // The home is carried away whole and a fresh one is built at the same
      // path: every name below it resolves again, and every inode is new.
      renameSync(home.path, moved);
      mkdirSync(store(), { recursive: true });
    };

    try {
      expect(() => acquire(built)).toThrow(UNAVAILABLE);
      // Nothing was created in the substituted tree.
      expect(readdirSync(store())).toEqual([]);
    } finally {
      rmSync(movedParent, { force: true, recursive: true });
    }
  });

  /**
   * The record's own name is a lookup like any other. A link planted at
   * `<digest>.json` must read as unreadable rather than being followed to
   * whatever it names -- and unreadable, never absent, because "I cannot read
   * this" and "there is nothing here" collapsing into one answer is exactly how
   * a spent Plan would be handed back.
   */
  it.skipIf(process.platform === "win32")(
    "refuses a link planted at the record's own name rather than following it",
    async () => {
      const built = await plan();
      acquire(built);
      const name = readdirSync(store())[0] as string;
      const decoy = join(home.path, "decoy.json");
      writeFileSync(decoy, "not a claim this authority wrote");
      rmSync(join(store(), name));
      symlinkSync(decoy, join(store(), name));

      expect(() => acquire(built)).toThrow(UNREADABLE);
      // Nothing was read through the link and nothing was written over it.
      expect(readFileSync(decoy, "utf8")).toBe("not a claim this authority wrote");
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a store replaced by a symlink after it was proved",
    async () => {
      const built = await plan();
      interposition.afterStoreEnumeration = () => {
        renameSync(store(), aside());
        symlinkSync(aside(), store(), "dir");
      };

      expect(() => acquire(built)).toThrow(UNAVAILABLE);
      // Nothing followed the link: the real directory behind it is untouched.
      expect(readdirSync(aside())).toEqual([]);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "refuses a store replaced by a junction after it was proved",
    async () => {
      const built = await plan();
      let linked = true;
      interposition.afterStoreEnumeration = () => {
        renameSync(store(), aside());
        try {
          symlinkSync(aside(), store(), "junction");
        } catch {
          linked = false; // The volume or account does not permit creating one.
        }
      };

      expect(() => acquire(built)).toThrow(UNAVAILABLE);
      if (linked) expect(readdirSync(aside())).toEqual([]);
    },
  );

  it("never reports committed through a store substituted after the create", async () => {
    const built = await plan();
    interposition.afterClaimCreate = () => {
      renameSync(store(), aside());
      mkdirSync(store(), { recursive: false });
    };

    expect(() => acquire(built)).toThrow(NOT_COMMITTED);
    // The record this transaction created still exists, in the store it created it
    // in, so the Plan is spent. The substituted store was never published through.
    expect(readdirSync(aside())).toHaveLength(1);
    expect(readdirSync(store())).toEqual([]);
  });

  it("never reports committed through a store substituted after the read-back", async () => {
    const built = await plan();
    interposition.afterClaimReadback = () => {
      renameSync(store(), aside());
      mkdirSync(store(), { recursive: false });
    };

    expect(() => acquire(built)).toThrow(NOT_COMMITTED);
    expect(readdirSync(aside())).toHaveLength(1);
    expect(readdirSync(store())).toEqual([]);
  });
});

/** The record a clean commit would have written, for contrast with a torn one. */
function pristine(built: GovernanceDoctorRepairPlanV1) {
  return createGovernanceDoctorRepairClaimV1({
    claimedAtEpochMs: REPAIR_FIXTURE_ATTEMPTED_AT,
    consentSha256: repairFixtureConsent(built).consentSha256,
    planSha256: built.planSha256,
    scopeSha256: governanceDoctorRepairClaimScopeSha256V1({
      realPath: realpathSync.native(root),
    }),
    state: "claimed",
  });
}
