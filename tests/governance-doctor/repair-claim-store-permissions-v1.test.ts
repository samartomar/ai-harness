import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireGovernanceDoctorRepairClaimV1,
  GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_LIMITS,
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
 * The POSIX mutation bound on the store's resolved home and controlled segments.
 *
 * A spent record is the whole single-use guarantee, and this store never removes
 * one. That promise is only as strong as the ancestry holding it: a
 * group-writable `.aih`, a world-writable `governance-doctor`, or a
 * `repair-claims-v1` owned by another local account each let that account delete
 * the record -- and a deleted record reads as "never claimed", which hands a
 * spent Plan straight back.
 *
 * The resolved account home is inside that bound rather than above it. POSIX puts
 * the right to remove a name in the directory that holds the name, so locking
 * `.aih` down to 0700 says nothing about who may `unlink` or `rename` the entry
 * `.aih` -- that is the home's write bit.
 *
 * And the bound does not stop at the home. The same rule applies at every step
 * upward: a writable grandparent lets another account rename the *parent* aside
 * and supply its own, so pinning the boundary at one level would only move the
 * attack up one step. The whole lexical naming ancestry is proved, to the
 * filesystem root, under the weaker rule real layouts require -- root-owned and
 * not group- or world-writable, or sticky and naming an entry this account or
 * root owns, which is what makes `/tmp` at 01777 safe and 0777 not. The walk is
 * bounded by depth, and a home deeper than that ceiling is refused rather than
 * walked.
 *
 * The owner half of the rule needs an account this process can name, so the
 * `getuid` lookup is part of the proof: unavailable, throwing, or malformed is a
 * refusal, never a rule that quietly stops applying.
 *
 * ## Why the POSIX facts are reported rather than chmod-ed
 *
 * `chmod` states the first half of this directly, but only on a POSIX host, and
 * `chown` to a second account needs privileges no suite should ask for. So the
 * two facts the rule actually reads -- one path's permission bits and its owning
 * uid -- are reported through an `lstat` seam, with `process.platform` and
 * `process.getuid` stubbed to the POSIX shape. Every case below therefore states
 * the same rule the real syscalls would, on either platform family.
 *
 * ## The recorded platform limitation
 *
 * Windows reports a POSIX-shaped mode derived from the read-only attribute rather
 * than from an ACL, and reports no uid at all, so every directory there reads as
 * world-writable. The rule is not asserted on Windows and no ACL boundary is
 * invented in its place: on Windows the store's privacy is exactly whatever the
 * account profile's own ACLs already give it. That is a real gap, recorded here
 * rather than papered over.
 */
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { repairFixtureOsModuleV1 } = await import("./repair-account-home-v1.js");
  return repairFixtureOsModuleV1(actual);
});

const posix = vi.hoisted(() => ({
  enabled: false,
  /** Owning uid reported for one exact path; every other path reports `uid`. */
  owners: new Map<string, number>(),
  /**
   * Permission bits reported for one exact path, special bits included; every
   * other path reports a plain 0o700. Cases that need setuid, setgid, or sticky
   * state it explicitly (0o1777), so a host directory's own special bits -- a
   * real `/tmp`'s sticky bit above all -- can never leak into a simulated shape.
   */
  permissions: new Map<string, number>(),
  uid: 4242,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const reported = (path: string, stats: unknown): unknown => {
    const raw = stats as { readonly mode: bigint; readonly uid: bigint };
    if (!posix.enabled || typeof raw.mode !== "bigint") return stats;
    const permission = BigInt(posix.permissions.get(path) ?? 0o700);
    const owner = BigInt(posix.owners.get(path) ?? posix.uid);
    // A proxy rather than a copy: how a `Stats` instance holds its own fields is
    // not this seam's business, and only two of them are being restated. The
    // file-type bits are untouched, so `isDirectory` and its siblings stay exactly
    // as truthful as the real syscall was. The whole 0o7777 permission field is
    // governed by the override -- special bits included -- so the simulated shape
    // is identical on every host.
    return new Proxy(raw, {
      get: (target, property) => {
        if (property === "mode") return (target.mode & ~0o7777n) | permission;
        if (property === "uid") return owner;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const lstatSync = ((path: string, options?: unknown): unknown =>
    reported(
      String(path),
      (actual.lstatSync as (p: string, o?: unknown) => unknown)(path, options),
    )) as typeof actual.lstatSync;
  const interposed = { ...actual, lstatSync };
  return { ...interposed, default: interposed };
});

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");

let home: RepairFixtureHome;
let homePath: string;
let root: string;

const UNAVAILABLE = /^GOVERNANCE_DOCTOR_REPAIR_V1: repair claim store is not available$/;
const FOREIGN = "a record this authority did not create";

const EFFECTS: readonly RepairFixtureEffect[] = [
  { arguments: { path: "canon" }, effectId: "ensure-canon", templateId: "ensure-canon-directory" },
];

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_ATTEMPTED_AT);
  home = repairFixtureIsolatedHome();
  // The naming-ancestry cases prove depths 0..2 below the home, but a host whose
  // temp directory sits directly under the filesystem root (`/tmp/...`) leaves
  // only two real ancestors. The account home is therefore re-pinned two
  // suite-owned layers deeper, so every proved depth exists on every host and
  // the nearest ancestors are directories this suite created.
  homePath = join(home.path, "layer-one", "layer-two");
  mkdirSync(homePath, { recursive: true });
  setRepairFixtureAccountHomeV1(homePath);
  root = mkdtempSync(join(realpathSync.native(tmpdir()), "aih-repair-permissions-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  posix.enabled = false;
  posix.owners.clear();
  posix.permissions.clear();
  if (platformDescriptor !== undefined)
    Object.defineProperty(process, "platform", platformDescriptor);
  if (getuidDescriptor === undefined) delete (process as { getuid?: unknown }).getuid;
  else Object.defineProperty(process, "getuid", getuidDescriptor);
  home.release();
  rmSync(root, { force: true, recursive: true });
});

/**
 * Reports the POSIX facts this rule reads, on whichever host is running.
 *
 * `getuid` is a parameter because on a non-Windows host it is half of a security
 * proof: an account this process cannot name is an account it cannot compare
 * against, so every way that lookup can fail has to be stated here rather than
 * assumed away.
 */
function simulatePosix(getuid: "absent" | (() => number) = () => posix.uid): void {
  posix.enabled = true;
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  if (getuid === "absent") delete (process as { getuid?: unknown }).getuid;
  else Object.defineProperty(process, "getuid", { configurable: true, value: getuid });
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
  return repairFixtureClaimStoreDirectory(homePath);
}

/** Every lexical naming ancestor of one path, nearest first, up to the root. */
function ancestors(path: string): readonly string[] {
  const chain: string[] = [];
  let current = dirname(path);
  while (!chain.includes(current)) {
    chain.push(current);
    current = dirname(current);
  }
  return chain;
}

/** One authority-controlled segment, by its depth below the resolved home. */
function segment(depth: number): string {
  return join(homePath, ...GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_SEGMENTS.slice(0, depth + 1));
}

/** A store that already exists and already holds something this run must not touch. */
function seededStore(): void {
  mkdirSync(store(), { recursive: true });
  writeFileSync(join(store(), "foreign.json"), FOREIGN);
}

/** The seeded entry is exactly as it was found: no rewrite, no removal, no addition. */
function expectStorePreserved(): void {
  expect(readdirSync(store())).toEqual(["foreign.json"]);
  expect(readFileSync(join(store(), "foreign.json"), "utf8")).toBe(FOREIGN);
}

describe("durable claim store authority permissions", () => {
  /**
   * Resolved -- the reviewed persistence-authority defect. An existing controlled
   * segment was accepted on shape alone, so an ancestry any other local account
   * could write into was treated as a durable home for a permanent record.
   */
  for (const depth of [0, 1, 2])
    for (const [sharing, permission] of [
      ["group-writable", 0o770],
      ["world-writable", 0o707],
    ] as const)
      it(`refuses a ${sharing} controlled segment at depth ${depth}`, async () => {
        const built = await plan();
        seededStore();
        simulatePosix();
        posix.permissions.set(segment(depth), permission);

        expect(() => acquire(built)).toThrow(UNAVAILABLE);
        // The refusal is the whole remedy: nothing is re-permissioned, nothing is
        // removed, and what was already there is left exactly as it was found.
        expectStorePreserved();
      });

  /**
   * Mode bits alone are not the bound. An account that *owns* a segment can widen
   * it at any later instant, so a segment owned by another local account is
   * refused even while it currently reads as private.
   */
  for (const depth of [0, 1, 2])
    it(`refuses a controlled segment at depth ${depth} owned by another local account`, async () => {
      const built = await plan();
      seededStore();
      simulatePosix();
      posix.owners.set(segment(depth), posix.uid + 1);

      expect(() => acquire(built)).toThrow(UNAVAILABLE);
      expectStorePreserved();
    });

  it("commits when every controlled segment is private to the running account", async () => {
    const built = await plan();
    mkdirSync(store(), { recursive: true });
    simulatePosix();

    const claim = acquire(built);
    expect(readdirSync(store())).toEqual([`${claim.claimSha256}.json`]);
  });

  /**
   * The resolved account home is *inside* the mutation boundary, because POSIX
   * puts the right to remove a name in the directory that holds it, not in the
   * named object. Locking `.aih` down to 0700 says nothing about who may
   * `unlink` or `rename` the entry `.aih`: that is governed by write permission
   * on the home. A group- or world-writable home therefore lets another local
   * account replace the whole store and erase a permanent spent record, however
   * private the segments below it are.
   *
   * The sticky bit would narrow that, but only under a complete owner-and-sticky
   * matrix this store does not carry, so a writable home is refused outright
   * rather than accepted on a rule that is not separately proven.
   */
  for (const [sharing, permission] of [
    ["group-writable", 0o770],
    ["world-writable", 0o707],
  ] as const)
    it(`refuses a ${sharing} resolved account home before it touches .aih`, async () => {
      const built = await plan();
      simulatePosix();
      posix.permissions.set(homePath, permission);

      expect(() => acquire(built)).toThrow(UNAVAILABLE);
      // The refusal lands before the first controlled segment is created, so a
      // home this authority cannot trust is never written into at all.
      expect(readdirSync(homePath)).toEqual([]);
    });

  it("refuses a resolved account home owned by another local account", async () => {
    const built = await plan();
    seededStore();
    simulatePosix();
    posix.owners.set(homePath, posix.uid + 1);

    expect(() => acquire(built)).toThrow(UNAVAILABLE);
    // An existing store under a home this authority cannot trust is left exactly
    // as it was found: refused, never re-permissioned and never cleaned up.
    expectStorePreserved();
  });

  /**
   * The whole lexical naming ancestry, not one level of it.
   *
   * The rule that puts removal rights in the holding directory does not stop at
   * the home's parent. A writable grandparent lets another account rename the
   * *parent* aside and supply its own, which brings its own home with it, and
   * every proof below then succeeds against a tree that account controls. Pinning
   * the bound at one level would just move the same attack up one step, so the
   * chain is proved from the reported home to the filesystem root.
   *
   * Two ownership shapes are accepted, because both are what real systems look
   * like. A root-owned directory that no other account may write -- `/`, `/home`,
   * `/Users` -- is safe: only root can rename through it, and an account that
   * already has root does not need this hole. A world-writable directory is safe
   * only when it is sticky and the entry it names belongs to this account or to
   * root, which is exactly `/tmp` at 01777.
   */
  for (const depth of [0, 1, 2])
    for (const [shape, permission, owner] of [
      ["group-writable", 0o770, undefined],
      ["world-writable", 0o707, undefined],
      ["foreign-owned", undefined, 1],
    ] as const)
      it(`refuses a ${shape} naming ancestor at depth ${depth}`, async () => {
        const built = await plan();
        seededStore();
        const chain = ancestors(homePath);
        expect(chain.length).toBeGreaterThan(depth);
        simulatePosix();
        if (permission !== undefined) posix.permissions.set(chain[depth] as string, permission);
        if (owner !== undefined) posix.owners.set(chain[depth] as string, posix.uid + owner);

        expect(() => acquire(built)).toThrow(UNAVAILABLE);
        expectStorePreserved();
      });

  /**
   * A world-writable ancestor without the sticky bit is refused even when it is
   * root-owned: `/` at 0777 would let anybody rename `/home` itself.
   */
  it("refuses a root-owned world-writable ancestor that is not sticky", async () => {
    const built = await plan();
    seededStore();
    const chain = ancestors(homePath);
    simulatePosix();
    posix.owners.set(chain[0] as string, 0);
    posix.permissions.set(chain[0] as string, 0o777);

    expect(() => acquire(built)).toThrow(UNAVAILABLE);
    expectStorePreserved();
  });

  /** The ordinary installed layout: root-owned 0755 the whole way up. */
  it("accepts a root-owned 0755 ancestry", async () => {
    const built = await plan();
    mkdirSync(store(), { recursive: true });
    simulatePosix();
    for (const ancestor of ancestors(homePath)) {
      posix.owners.set(ancestor, 0);
      posix.permissions.set(ancestor, 0o755);
    }

    const claim = acquire(built);
    expect(readdirSync(store())).toEqual([`${claim.claimSha256}.json`]);
  });

  /**
   * The layout this suite's own fixture home actually sits in: a root-owned
   * sticky `/tmp` at 01777 naming a directory this account owns, above a
   * root-owned 0755 root. Sticky is what makes the write bit harmless -- nobody
   * else may rename an entry they do not own -- so refusing it would refuse every
   * temporary-directory installation without protecting anything.
   */
  it("accepts a root-owned sticky ancestor naming an entry this account owns", async () => {
    const built = await plan();
    mkdirSync(store(), { recursive: true });
    simulatePosix();
    const chain = ancestors(homePath);
    posix.owners.set(chain[0] as string, 0);
    posix.permissions.set(chain[0] as string, 0o1777);
    for (const ancestor of chain.slice(1)) {
      posix.owners.set(ancestor, 0);
      posix.permissions.set(ancestor, 0o755);
    }

    const claim = acquire(built);
    expect(readdirSync(store())).toEqual([`${claim.claimSha256}.json`]);
  });

  /**
   * The walk is bounded by depth, never by whatever the platform hands over. An
   * ancestry longer than the ceiling is refused rather than walked, so a hostile
   * or pathological account home cannot turn this proof into unbounded work.
   */
  it("refuses an account home whose ancestry is deeper than the bounded ceiling", async () => {
    const built = await plan();
    const ceiling = GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_LIMITS.maxHomeAncestorDepth;
    const deep = join(
      homePath,
      ...Array.from({ length: ceiling + 1 }, (_entry, index) => `d${index}`),
    );
    mkdirSync(deep, { recursive: true });
    setRepairFixtureAccountHomeV1(deep);
    simulatePosix();

    expect(() => acquire(built)).toThrow(UNAVAILABLE);
    expect(existsSync(join(deep, ".aih"))).toBe(false);
  });

  /**
   * On a non-Windows host the owner comparison is half of a security proof, so
   * every way the account lookup can fail is a refusal rather than a pass.
   * Treating an unavailable `getuid` as "no owner rule applies" turned the
   * proof off exactly where it could not be evaluated, and handing an
   * unvalidated value to `BigInt` turned a bad one into a raw platform error
   * instead of this module's own fixed label.
   */
  for (const [label, getuid] of [
    ["unavailable", "absent"],
    [
      "throwing",
      () => {
        throw new Error("this platform cannot name the account");
      },
    ],
    ["negative", () => -1],
    ["non-integer", () => 1.5],
    ["outside the safe integer range", () => Number.MAX_SAFE_INTEGER + 1],
  ] as const)
    it(`refuses when the account uid is ${label}`, async () => {
      const built = await plan();
      seededStore();
      simulatePosix(getuid);
      // The reported owner agrees with whatever the bogus lookup returns wherever
      // that is expressible -- an integer this seam can restate -- so the refusal
      // is the uid rule itself rather than a mismatch that would have refused
      // anyway. A lookup that cannot even be called is left alone.
      let reported: number | undefined;
      if (typeof getuid !== "string")
        try {
          reported = getuid();
        } catch {
          reported = undefined;
        }
      if (reported !== undefined && Number.isInteger(reported))
        for (const path of [homePath, segment(0), segment(1), segment(2)])
          posix.owners.set(path, reported);

      expect(() => acquire(built)).toThrow(UNAVAILABLE);
      expectStorePreserved();
    });

  it.skipIf(process.platform !== "win32")(
    "asserts no POSIX mutation bound on Windows, where the mode does not describe the ACL",
    async () => {
      const built = await plan();
      mkdirSync(store(), { recursive: true });
      // No simulation, so the real Windows facts apply. Refusing on a mode derived
      // from the read-only attribute would refuse every Windows run, and inventing
      // an ACL boundary here would claim a bound this store does not have.
      const claim = acquire(built);
      expect(readdirSync(store())).toEqual([`${claim.claimSha256}.json`]);
    },
  );
});
