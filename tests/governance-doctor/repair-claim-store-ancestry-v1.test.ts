import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireGovernanceDoctorRepairClaimV1,
  GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_SEGMENTS,
} from "../../src/governance-doctor/repair-claim-store-v1.js";
import type { GovernanceDoctorRepairPlanV1 } from "../../src/governance-doctor/repair-plan-v1.js";
import { setRepairFixtureAccountHomeV1 } from "./repair-account-home-v1.js";
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
 * Deterministic filesystem interposition for the store's own ancestry.
 *
 * The three controlled segments are proved one at a time, and each proof hands the
 * next one a *path*. A path is not a handle: every syscall after the proof
 * re-resolves it, so a parent renamed away and replaced by a real directory that
 * already holds the deeper name is addressed exactly as if it were the proved one.
 * That substitution cannot be scheduled from a test, so the seam here is the
 * canonicalization itself -- a hook may run once, immediately after one exact path
 * has been canonicalized, which is the last syscall of that segment's proof.
 *
 * Two rules are checked at both depths. A segment this authority proved and a
 * segment it did not are never allowed to be the same thing, and a foreign tree
 * substituted for one is preserved byte for byte rather than adopted, written
 * into, or removed.
 *
 * ## The bounded proof
 *
 * Node exposes no way to prove a directory and then resolve a child inside that
 * open handle, so the gap between proving a parent and addressing a name under it
 * is a path lookup this module cannot close. What is proved here is therefore
 * bounded and is deliberately not atomicity: the parent's canonical path and its
 * `dev`+`ino` identity are re-proved immediately before the child is addressed and
 * again immediately after the child's own proof, so a substitution spanning either
 * boundary is refused. A substitution that lands and is reverted entirely inside
 * one syscall is outside what these APIs can observe, and is not claimed.
 */
const interposition = vi.hoisted(() => ({
  /**
   * Fires once, immediately after this exact path has been canonicalized for the
   * `nth` time. The occurrence index is what lets a case choose *which* proof
   * boundary it lands inside, since one path is canonicalized once per boundary
   * that re-proves it.
   */
  afterCanonicalPath: null as null | {
    readonly nth?: number;
    readonly path: string;
    readonly run: () => void;
  },
  /** How many times the currently hooked path has been canonicalized. */
  canonicalized: 0,
  /**
   * Permission bits reported for one exact path; every other path reports 0o700.
   * This is what lets a case make an ancestor unsafe *without* moving anything,
   * so the ancestry walk itself refuses while every identity below it still
   * matches -- the only way to reach the refusal paths inside the walk rather
   * than the identity comparison after it.
   */
  permissions: new Map<string, number>(),
  /**
   * Reports POSIX-shaped ownership and permissions for every path, so the home's
   * naming-ancestry rule -- which is asserted on POSIX only -- can be exercised on
   * either platform family. `dev` and `ino` pass straight through: identity is the
   * fact these cases are about, and restating it would test the seam instead.
   */
  posixAncestry: false,
  uid: 4242,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const native = (path: string): string => {
    const resolved = actual.realpathSync.native(path);
    const hook = interposition.afterCanonicalPath;
    if (hook !== null && hook.path === path) {
      interposition.canonicalized += 1;
      if (interposition.canonicalized >= (hook.nth ?? 1)) {
        interposition.afterCanonicalPath = null;
        hook.run();
      }
    }
    return resolved;
  };
  const forward = (path: string, options?: unknown): unknown =>
    (actual.realpathSync as (p: string, o?: unknown) => unknown)(path, options);
  const lstatSync = ((path: string, options?: unknown): unknown => {
    const stats = (actual.lstatSync as (p: string, o?: unknown) => unknown)(path, options);
    const raw = stats as { readonly mode: bigint; readonly uid: bigint };
    if (!interposition.posixAncestry || typeof raw.mode !== "bigint") return stats;
    const permission = BigInt(interposition.permissions.get(String(path)) ?? 0o700);
    // Only the two facts the ancestry rule reads are restated; the file-type bits
    // are untouched, so `isDirectory` and its siblings stay as truthful as the
    // real syscall was.
    return new Proxy(raw, {
      get: (target, property) => {
        if (property === "mode") return (target.mode & ~0o7777n) | permission;
        if (property === "uid") return BigInt(interposition.uid);
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof actual.lstatSync;
  const interposed = {
    ...actual,
    lstatSync,
    realpathSync: Object.assign(forward, { native }) as unknown as typeof actual.realpathSync,
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

const UNAVAILABLE = /^GOVERNANCE_DOCTOR_REPAIR_V1: repair claim store is not available$/;
const NOT_COMMITTED = /^GOVERNANCE_DOCTOR_REPAIR_V1: repair claim did not commit$/;
const FOREIGN = "a tree this authority never proved";

const EFFECTS: readonly RepairFixtureEffect[] = [
  { arguments: { path: "canon" }, effectId: "ensure-canon", templateId: "ensure-canon-directory" },
];

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_ATTEMPTED_AT);
  interposition.afterCanonicalPath = null;
  interposition.canonicalized = 0;
  interposition.permissions.clear();
  interposition.posixAncestry = false;
  home = repairFixtureIsolatedHome();
  root = mkdtempSync(join(realpathSync.native(tmpdir()), "aih-repair-ancestry-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  interposition.afterCanonicalPath = null;
  interposition.canonicalized = 0;
  interposition.permissions.clear();
  interposition.posixAncestry = false;
  if (platformDescriptor !== undefined)
    Object.defineProperty(process, "platform", platformDescriptor);
  if (getuidDescriptor === undefined) delete (process as { getuid?: unknown }).getuid;
  else Object.defineProperty(process, "getuid", getuidDescriptor);
  home.release();
  rmSync(root, { force: true, recursive: true });
});

/**
 * Reports the POSIX facts the ancestry rule reads, on whichever host is running.
 * The rule is asserted on POSIX only, so without this the whole proof would be
 * inert on Windows and these cases would assert nothing at all.
 */
function simulatePosix(): void {
  interposition.posixAncestry = true;
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  Object.defineProperty(process, "getuid", {
    configurable: true,
    value: () => interposition.uid,
  });
}

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

/** Somewhere inside the fixture home to move a proved segment aside to. */
function aside(): string {
  return join(home.path, "aside");
}

/**
 * A real, canonical directory somewhere else in the home that already holds the
 * remaining controlled names -- exactly what a substitution needs to be adopted
 * rather than merely refused for being the wrong shape.
 */
function foreignTree(...remaining: readonly string[]): string {
  const tree = join(home.path, "foreign");
  const deepest = join(tree, ...remaining);
  mkdirSync(deepest, { recursive: true });
  writeFileSync(join(deepest, "foreign.txt"), FOREIGN);
  return tree;
}

describe("durable claim store ancestry under filesystem interposition", () => {
  /**
   * The reviewed controlled-ancestor substitution. A segment was re-proved only
   * when this invocation had created it, so an existing candidate under a parent
   * that had meanwhile been swapped for a foreign real directory was adopted
   * outright -- and a claim written into a tree the operator does not control is a
   * spent record another party can simply remove.
   */
  it("refuses a shallow controlled parent swapped between segment proofs", async () => {
    const built = await plan();
    // Every controlled segment already exists, so nothing on this run is created
    // and the created-only re-proof never runs.
    mkdirSync(store(), { recursive: true });
    const foreign = foreignTree("governance-doctor", "repair-claims-v1");
    const aih = join(home.path, ".aih");
    interposition.afterCanonicalPath = {
      path: aih,
      run: () => {
        renameSync(aih, aside());
        renameSync(foreign, aih);
      },
    };

    expect(() => acquire(built)).toThrow(UNAVAILABLE);

    // The foreign tree was neither adopted nor written into nor cleaned up.
    const substituted = join(aih, "governance-doctor", "repair-claims-v1");
    expect(readdirSync(substituted)).toEqual(["foreign.txt"]);
    expect(readFileSync(join(substituted, "foreign.txt"), "utf8")).toBe(FOREIGN);
    // And the store this authority actually proved holds no record either.
    expect(readdirSync(join(aside(), "governance-doctor", "repair-claims-v1"))).toEqual([]);
  });

  it("refuses a deep controlled parent swapped between segment proofs", async () => {
    const built = await plan();
    mkdirSync(store(), { recursive: true });
    const foreign = foreignTree("repair-claims-v1");
    const doctor = join(home.path, ".aih", "governance-doctor");
    interposition.afterCanonicalPath = {
      path: doctor,
      run: () => {
        renameSync(doctor, aside());
        renameSync(foreign, doctor);
      },
    };

    expect(() => acquire(built)).toThrow(UNAVAILABLE);

    const substituted = join(doctor, "repair-claims-v1");
    expect(readdirSync(substituted)).toEqual(["foreign.txt"]);
    expect(readFileSync(join(substituted, "foreign.txt"), "utf8")).toBe(FOREIGN);
    expect(readdirSync(join(aside(), "repair-claims-v1"))).toEqual([]);
  });

  /**
   * The home's naming ancestry is proved once and re-proved at the same
   * boundaries the controlled segments are. This is the substitution that
   * re-proof exists for, and it is deliberately the hardest shape of it: an
   * account that can rename an ancestor replaces the *ancestor* while carrying
   * the home into the replacement, so the home keeps its inode and every proof
   * below the ancestor still matches exactly. Only the ancestor's own `dev`+`ino`
   * has moved, and only the ancestry re-proof can see it.
   *
   * The substitution is fired from the canonicalization of that ancestor during
   * the initial walk -- after its identity has been captured, before the walk has
   * finished -- so it lands squarely inside the window between the proof and its
   * re-proof.
   */
  it("refuses a naming ancestor substituted between the ancestry proof and its reproof", async () => {
    const built = await plan();
    // A home one level deeper than the fixture's, so an ancestor of it can be
    // renamed without touching anything shared with another suite.
    const holder = join(home.path, "holder");
    const account = join(holder, "account");
    const accountStore = join(account, ...GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_SEGMENTS);
    mkdirSync(accountStore, { recursive: true });
    setRepairFixtureAccountHomeV1(account);
    simulatePosix();

    const displaced = join(home.path, "displaced");
    interposition.afterCanonicalPath = {
      path: holder,
      run: () => {
        renameSync(holder, displaced);
        mkdirSync(holder);
        renameSync(join(displaced, "account"), account);
      },
    };

    expect(() => acquire(built)).toThrow(UNAVAILABLE);

    // Refused before publication: the store this run would have written into is
    // exactly as it was found, and the emptied husk holds nothing either.
    expect(readdirSync(accountStore)).toEqual([]);
    expect(readdirSync(displaced)).toEqual([]);
    expect(readdirSync(holder)).toEqual(["account"]);
  });

  /**
   * The same substitution, moved past the window the previous case covers.
   *
   * The home's ancestry used to be re-proved only while `.aih` was being
   * resolved, and then dropped: the deeper segments and the store carried no
   * ancestry at all, so nothing re-proved the chain again before the exclusive
   * create. An attacker who waited until after that window could swap a proved
   * ancestor and still have every identity below it match, because carrying the
   * home into the replacement preserves the home, the three segments, and the
   * store inode alike -- and the record would then be created under a chain this
   * authority no longer controls.
   *
   * The substitution is fired from the *second* canonicalization of the store,
   * which is the pre-create identity boundary: the first is the store's own
   * proof, the second is the check taken immediately before the name is claimed.
   */
  it("refuses a naming ancestor substituted at the pre-create store boundary", async () => {
    const built = await plan();
    const holder = join(home.path, "holder");
    const account = join(holder, "account");
    const accountStore = join(account, ...GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_SEGMENTS);
    mkdirSync(accountStore, { recursive: true });
    setRepairFixtureAccountHomeV1(account);
    simulatePosix();

    const displaced = join(home.path, "displaced");
    interposition.afterCanonicalPath = {
      nth: 2,
      path: accountStore,
      run: () => {
        renameSync(holder, displaced);
        mkdirSync(holder);
        renameSync(join(displaced, "account"), account);
      },
    };

    expect(() => acquire(built)).toThrow(UNAVAILABLE);

    // Refused before publication: the name was never claimed, so the store holds
    // no record and the Plan is not spent.
    expect(readdirSync(accountStore)).toEqual([]);
    expect(readdirSync(displaced)).toEqual([]);
    expect(readdirSync(holder)).toEqual(["account"]);
  });

  /**
   * The same chain, failing after the record exists.
   *
   * Once the exclusive create has succeeded the Plan is spent, and every later
   * refusal has to say so: "the store is not available" invites a retry, and a
   * retry of a Plan whose record is already on disk is exactly the replay this
   * module exists to refuse. So the post-read-back boundary reports "the claim
   * did not commit", and the record stays exactly where it is.
   *
   * The ancestor is made unsafe rather than moved, on purpose. A substitution
   * that replaces the directory is caught by the identity comparison, which
   * already carried the caller's label; a permission change is caught *inside*
   * the ancestry walk, which is the path that was still answering with its own
   * hardcoded label regardless of where in the transaction it was called from.
   */
  it("reports the post-publication label when an ancestor fails after the read-back", async () => {
    const built = await plan();
    const holder = join(home.path, "holder");
    const account = join(holder, "account");
    const accountStore = join(account, ...GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_SEGMENTS);
    mkdirSync(accountStore, { recursive: true });
    setRepairFixtureAccountHomeV1(account);
    simulatePosix();

    // The third canonicalization of the store is the boundary after the
    // read-back; the first is its own proof and the second is the pre-create
    // check.
    interposition.afterCanonicalPath = {
      nth: 3,
      path: accountStore,
      run: () => {
        interposition.permissions.set(holder, 0o777);
      },
    };

    expect(() => acquire(built)).toThrow(NOT_COMMITTED);

    // The record survives the refusal: the name was taken, so the Plan is spent
    // and the next attempt must mint a new one rather than retry this one.
    expect(readdirSync(accountStore)).toHaveLength(1);
    expect(readdirSync(accountStore)[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it("commits normally when no segment is substituted", async () => {
    const built = await plan();
    const claim = acquire(built);

    expect(readdirSync(store())).toEqual([`${claim.claimSha256}.json`]);
  });
});
