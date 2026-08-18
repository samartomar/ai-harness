import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireGovernanceDoctorRepairClaimV1,
  GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_LIMITS,
  GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_SEGMENTS,
} from "../../src/governance-doctor/repair-claim-store-v1.js";
import {
  canonicalGovernanceDoctorRepairClaimV1Bytes,
  createGovernanceDoctorRepairClaimV1,
  type GovernanceDoctorRepairClaimStateV1,
  governanceDoctorRepairClaimFileNameV1,
  governanceDoctorRepairClaimScopeSha256V1,
} from "../../src/governance-doctor/repair-claim-v1.js";
import type { GovernanceDoctorRepairPlanV1 } from "../../src/governance-doctor/repair-plan-v1.js";
import {
  REPAIR_FIXTURE_ATTEMPTED_AT,
  REPAIR_FIXTURE_CONSENTED_AT,
  type RepairFixtureEffect,
  type RepairFixtureHome,
  repairFixtureClaimStoreDirectory,
  repairFixtureConsent,
  repairFixtureIsolatedHome,
  repairFixturePlan,
} from "./repair-execution-fixture-v1.js";

/**
 * The durable machine-local claim store.
 *
 * Every case here is a variation on one rule: a Plan is spent the moment a record
 * for it exists, and this store never makes a record stop existing. So the suite
 * checks both halves -- that the first claim commits and is readable, and that
 * every other state of the store, readable or not, refuses rather than invites a
 * retry.
 */
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
let elsewhere: string;
let home: RepairFixtureHome;

const REFUSAL = /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /;
const ALREADY = /^GOVERNANCE_DOCTOR_REPAIR_V1: repair plan was already claimed$/;
const UNREADABLE =
  /^GOVERNANCE_DOCTOR_REPAIR_V1: repair claim store holds a record this authority cannot read$/;
const UNAVAILABLE = /^GOVERNANCE_DOCTOR_REPAIR_V1: repair claim store is not available$/;
const NOT_CANONICAL =
  /^GOVERNANCE_DOCTOR_REPAIR_V1: repair claim scope is not a canonical managed root$/;

const EFFECTS: readonly RepairFixtureEffect[] = [
  { arguments: { path: "canon" }, effectId: "ensure-canon", templateId: "ensure-canon-directory" },
];

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_ATTEMPTED_AT);
  home = repairFixtureIsolatedHome();
  root = mkdtempSync(join(realpathSync.native(tmpdir()), "aih-repair-claim-"));
  elsewhere = mkdtempSync(join(realpathSync.native(tmpdir()), "aih-repair-elsewhere-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  home.release();
  rmSync(root, { force: true, recursive: true });
  rmSync(elsewhere, { force: true, recursive: true });
});

async function plan(planNonce?: string): Promise<GovernanceDoctorRepairPlanV1> {
  return repairFixturePlan({
    effects: EFFECTS,
    ...(planNonce === undefined ? {} : { planNonce }),
    root,
    scopePaths: ["canon"],
  });
}

function acquire(
  built: GovernanceDoctorRepairPlanV1,
  overrides: Record<string, unknown> = {},
  realPath: string = realpathSync.native(root),
) {
  return acquireGovernanceDoctorRepairClaimV1({
    consent: repairFixtureConsent(built),
    plan: built,
    rootRealPath: realPath,
    ...overrides,
  });
}

function store(): string {
  return repairFixtureClaimStoreDirectory(home.path);
}

/** The record a previous process would have left, written straight to the store. */
function seed(
  built: GovernanceDoctorRepairPlanV1,
  state: GovernanceDoctorRepairClaimStateV1 = "claimed",
  realPath: string = realpathSync.native(root),
) {
  const claim = createGovernanceDoctorRepairClaimV1({
    claimedAtEpochMs: REPAIR_FIXTURE_CONSENTED_AT,
    consentSha256: repairFixtureConsent(built).consentSha256,
    planSha256: built.planSha256,
    scopeSha256: governanceDoctorRepairClaimScopeSha256V1({ realPath }),
    state,
  });
  mkdirSync(store(), { recursive: true });
  const path = join(store(), governanceDoctorRepairClaimFileNameV1(claim.claimSha256));
  writeFileSync(path, canonicalGovernanceDoctorRepairClaimV1Bytes(claim));
  return { claim, path };
}

describe("acquireGovernanceDoctorRepairClaimV1", () => {
  it("commits one record under the approved machine-local location and nowhere else", async () => {
    const built = await plan();
    const claim = acquire(built);

    expect(claim.state).toBe("claimed");
    expect(claim.planSha256).toBe(built.planSha256);
    expect(claim.consentSha256).toBe(repairFixtureConsent(built).consentSha256);
    expect(claim.claimedAtEpochMs).toBe(REPAIR_FIXTURE_ATTEMPTED_AT);

    // Exactly `<home>/.aih/governance-doctor/repair-claims-v1/<digest>.json`.
    expect([...GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_SEGMENTS]).toEqual([
      ".aih",
      "governance-doctor",
      "repair-claims-v1",
    ]);
    expect(store()).toBe(join(home.path, ...GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_SEGMENTS));
    expect(readdirSync(store())).toEqual([`${claim.claimSha256}.json`]);
    expect(readdirSync(home.path)).toEqual([".aih"]);
    expect(
      readFileSync(join(store(), `${claim.claimSha256}.json`)).equals(
        canonicalGovernanceDoctorRepairClaimV1Bytes(claim),
      ),
    ).toBe(true);
    // The project tree is never a claim home; `.aih/` there is disposable.
    expect(existsSync(join(root, ".aih"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("keeps the record private to its owner", async () => {
    const claim = acquire(await plan());
    expect(statSync(join(store(), `${claim.claimSha256}.json`)).mode & 0o777).toBe(
      GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_LIMITS.claimFileMode,
    );
    expect(lstatSync(store()).mode & 0o777).toBe(
      GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_LIMITS.storeDirectoryMode,
    );
  });

  it("spends the plan exactly once in one process, and never steals the held name", async () => {
    const built = await plan();
    const claim = acquire(built);
    const before = readFileSync(join(store(), `${claim.claimSha256}.json`));

    expect(() => acquire(built)).toThrow(ALREADY);
    expect(() => acquire(built)).toThrow(ALREADY);
    // The record that won is untouched: the losing attempts took nothing.
    expect(readFileSync(join(store(), `${claim.claimSha256}.json`)).equals(before)).toBe(true);
    expect(readdirSync(store())).toHaveLength(1);
  });

  it("refuses a record left by a previous process it never saw", async () => {
    const built = await plan();
    const { path } = seed(built);
    const before = readFileSync(path);

    // Nothing in this process has ever claimed this plan. Only the file refuses it.
    expect(() => acquire(built)).toThrow(ALREADY);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("treats a terminal record as spending the plan just as a claimed one does", async () => {
    const built = await plan();
    seed(built, "consumed");
    expect(() => acquire(built)).toThrow(ALREADY);
  });

  it("refuses rather than reads a malformed, non-canonical, or oversized record as absent", async () => {
    const built = await plan();
    const { path } = seed(built);
    const canonical = readFileSync(path);

    for (const corrupt of [
      Buffer.alloc(0),
      Buffer.from("{ not a claim", "utf8"),
      canonical.subarray(0, canonical.length - 3),
      Buffer.concat([canonical, Buffer.from(" ", "utf8")]),
      Buffer.from(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(JSON.parse(canonical.toString("utf8")) as object).reverse(),
          ),
        ),
        "utf8",
      ),
      Buffer.alloc(4096, 0x20),
    ]) {
      writeFileSync(path, corrupt);
      expect(() => acquire(built), corrupt.subarray(0, 16).toString("hex")).toThrow(UNREADABLE);
      // Unreadable is a refusal, never a licence to overwrite what is there.
      expect(readFileSync(path).equals(corrupt)).toBe(true);
    }
  });

  it("refuses a record that occupies this claim's name but declares another identity", async () => {
    const built = await plan();
    const other = await plan("5e".repeat(32));
    const mine = seed(built);
    const theirs = seed(other);
    writeFileSync(mine.path, readFileSync(theirs.path));

    expect(() => acquire(built)).toThrow(UNREADABLE);
  });

  it("refuses a hard-linked record rather than trusting a second name for it", async () => {
    const built = await plan();
    const { path } = seed(built);
    try {
      linkSync(path, join(store(), "alias.tmp"));
    } catch {
      return; // The platform or volume does not support hard links here.
    }

    expect(lstatSync(path).nlink).toBe(2);
    expect(() => acquire(built)).toThrow(UNREADABLE);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked controlled segment rather than following it",
    async () => {
      const built = await plan();
      // `.aih` itself, aliased to somewhere the operator did not authorize.
      symlinkSync(elsewhere, join(home.path, ".aih"), "dir");

      expect(() => acquire(built)).toThrow(UNAVAILABLE);
      expect(readdirSync(elsewhere)).toEqual([]);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "refuses a junction or reparse point in a controlled segment",
    async () => {
      const built = await plan();
      try {
        symlinkSync(elsewhere, join(home.path, ".aih"), "junction");
      } catch {
        return; // The volume or account does not permit creating one.
      }

      expect(() => acquire(built)).toThrow(UNAVAILABLE);
      expect(readdirSync(elsewhere)).toEqual([]);
    },
  );

  it("refuses a controlled segment occupied by something that is not a directory", async () => {
    const built = await plan();
    writeFileSync(join(home.path, ".aih"), "not a directory");

    expect(() => acquire(built)).toThrow(UNAVAILABLE);
    // The operator's own file is left exactly as it was found.
    expect(readFileSync(join(home.path, ".aih"), "utf8")).toBe("not a directory");
  });

  it("refuses a deeper controlled segment occupied by a file", async () => {
    const built = await plan();
    mkdirSync(join(home.path, ".aih", "governance-doctor"), { recursive: true });
    writeFileSync(join(home.path, ".aih", "governance-doctor", "repair-claims-v1"), "occupied");

    expect(() => acquire(built)).toThrow(UNAVAILABLE);
  });

  it.skipIf(process.platform === "win32")("refuses an unwritable store", async () => {
    const built = await plan();
    mkdirSync(store(), { recursive: true });
    chmodSync(store(), 0o500);
    try {
      expect(() => acquire(built)).toThrow(REFUSAL);
      expect(readdirSync(store())).toEqual([]);
    } finally {
      chmodSync(store(), 0o700);
    }
  });

  it("refuses an unbounded store rather than making room by deleting evidence", async () => {
    const built = await plan();
    const ceiling = GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_LIMITS.maxStoreRecords;
    mkdirSync(store(), { recursive: true });
    for (let index = 0; index < ceiling; index += 1)
      writeFileSync(join(store(), `${String(index).padStart(6, "0")}.json`), "");

    expect(() => acquire(built)).toThrow(
      /^GOVERNANCE_DOCTOR_REPAIR_V1: repair claim store exceeds its bounded record count$/,
    );
    // No reaper: every record that was there is still there.
    expect(readdirSync(store())).toHaveLength(ceiling);
  });

  it("binds the claim to one canonical root, so another checkout is a separate scope", async () => {
    const built = await plan();
    const here = acquire(built);
    const there = acquire(built, {}, realpathSync.native(elsewhere));

    expect(there.claimSha256).not.toBe(here.claimSha256);
    expect(there.scopeSha256).not.toBe(here.scopeSha256);
    expect(readdirSync(store()).sort()).toEqual(
      [`${here.claimSha256}.json`, `${there.claimSha256}.json`].sort(),
    );
    // And each scope is still single-use in its own right.
    expect(() => acquire(built)).toThrow(ALREADY);
    expect(() => acquire(built, {}, realpathSync.native(elsewhere))).toThrow(ALREADY);
  });

  /**
   * Resolved -- the reviewed canonical-root defect. The contract binds one
   * *canonical* root, so a spelling the filesystem never reports must not be able
   * to open a second authority scope for the same checkout. Treating a fake case
   * variant as "simply a different scope" made the single-use rule opt-out: spell
   * the root differently and the same Plan claims again under a second name.
   */
  it("requires an existing canonical real directory and refuses a fake spelling", async () => {
    const built = await plan();
    const real = realpathSync.native(root);
    acquire(built, {}, real);
    expect(readdirSync(store())).toHaveLength(1);

    // A case variant is a spelling `realpath` does not report. On a case-sensitive
    // volume it does not exist at all; on a case-insensitive one it resolves to a
    // different spelling than the one supplied. Both are refused, not re-scoped.
    expect(() => acquire(built, {}, real.toUpperCase())).toThrow(NOT_CANONICAL);
    // Relative, absent, non-directory, and non-string roots are all refused too.
    expect(() => acquire(built, {}, "relative/checkout")).toThrow(NOT_CANONICAL);
    expect(() => acquire(built, {}, join(root, "no-such-checkout"))).toThrow(NOT_CANONICAL);
    writeFileSync(join(elsewhere, "file.txt"), "not a directory");
    expect(() => acquire(built, {}, join(elsewhere, "file.txt"))).toThrow(NOT_CANONICAL);
    expect(() => acquire(built, {}, "")).toThrow(NOT_CANONICAL);

    // Not one of those reached the store.
    expect(readdirSync(store())).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked spelling of the root rather than binding the link",
    async () => {
      const built = await plan();
      const link = join(elsewhere, "link-to-root");
      symlinkSync(realpathSync.native(root), link, "dir");

      expect(() => acquire(built, {}, link)).toThrow(NOT_CANONICAL);
      expect(existsSync(store())).toBe(false);
    },
  );

  /**
   * Resolved -- the reviewed identity defect. A claimed record permanently spends
   * the Plan for one canonical root. A fresh granted Consent for that same Plan and
   * that same root is therefore a replay, not a new authority, and it has to be
   * refused at the one fixed name the Plan already occupies.
   */
  it("refuses a fresh granted consent for a plan and root already claimed", async () => {
    const built = await plan();
    const first = acquire(built);

    const fresh = repairFixtureConsent(built, { consentNonce: "9a".repeat(32) });
    expect(fresh.consentSha256).not.toBe(repairFixtureConsent(built).consentSha256);
    expect(fresh.decision).toBe("granted");

    expect(() => acquire(built, { consent: fresh })).toThrow(ALREADY);
    // One plan under one root has exactly one name, and it still holds the first
    // record: the second consent minted no second file to read as absent.
    expect(readdirSync(store())).toEqual([`${first.claimSha256}.json`]);
  });

  it("requires branded records and refuses caller-shaped stand-ins", async () => {
    const built = await plan();
    const consent = repairFixtureConsent(built);

    expect(() => acquire(built, { consent: { ...consent } })).toThrow(REFUSAL);
    expect(() => acquire(built, { plan: { ...built } })).toThrow(REFUSAL);
    expect(() => acquire(built, { consent: null })).toThrow(REFUSAL);
    expect(existsSync(store())).toBe(false);
  });

  it("refuses a denied consent, a foreign consent, and a non-closed request", async () => {
    const built = await plan();
    const other = await plan("1a".repeat(32));

    expect(() =>
      acquire(built, { consent: repairFixtureConsent(built, { decision: "denied" }) }),
    ).toThrow(REFUSAL);
    expect(() => acquire(built, { consent: repairFixtureConsent(other) })).toThrow(REFUSAL);
    expect(() => acquire(built, { extra: 1 })).toThrow(REFUSAL);
    expect(() => acquire(built, { rootRealPath: 1 })).toThrow(REFUSAL);
    expect(existsSync(store())).toBe(false);
  });

  it("never echoes the home, the store path, or the checkout in a refusal", async () => {
    const built = await plan();
    seed(built);
    let message = "";
    try {
      acquire(built);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(ALREADY);
    expect(message).not.toContain(home.path);
    expect(message).not.toContain(root);
    expect(message).not.toContain(".aih");
  });

  it("never echoes a rejected root spelling back to the caller", async () => {
    // This refusal is the one that reads a caller-supplied path, so it is the one
    // with something to leak. The label stays fixed and content-free.
    const built = await plan();
    const rejected = join(root, "no-such-secret-checkout");
    let message = "";
    try {
      acquire(built, {}, rejected);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(NOT_CANONICAL);
    expect(message).not.toContain(rejected);
    expect(message).not.toContain(root);
  });
});
