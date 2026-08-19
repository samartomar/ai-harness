import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireGovernanceDoctorRepairClaimV1 } from "../../src/governance-doctor/repair-claim-store-v1.js";
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
 * Where the durable store's one location comes from.
 *
 * A claim record is the whole single-use guarantee, and it only guarantees
 * anything if the *same* Plan under the *same* root always resolves to the same
 * record. `HOME` and `USERPROFILE` are settable by anyone who can start this
 * process, so a store root read from them is a caller-controlled store root in
 * everything but name: relaunch the same Plan with a different environment and
 * the lookup lands in a fresh, empty store, where a spent Plan reads as never
 * claimed. That is the replay this module exists to refuse.
 *
 * The store therefore reads the OS *account* home -- the account database, which
 * no environment variable redirects -- and that is not a caller input and not a
 * test setter. The only seam this suite may use is the platform module itself, so
 * `node:os` is replaced at the module boundary and `userInfo()` reports a
 * throwaway fixture directory.
 *
 * Both environment variables are pointed at a throwaway decoy for the whole
 * suite, so a regression that starts following them again is caught here rather
 * than by writing durable records into the operator's real account home.
 */
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { repairFixtureOsModuleV1 } = await import("./repair-account-home-v1.js");
  return repairFixtureOsModuleV1(actual);
});

let decoy: string;
let home: RepairFixtureHome;
let previousHome: string | undefined;
let previousProfile: string | undefined;
let root: string;

const ALREADY = /^GOVERNANCE_DOCTOR_REPAIR_V1: repair plan was already claimed$/;
const UNAVAILABLE = /^GOVERNANCE_DOCTOR_REPAIR_V1: repair claim store is not available$/;

const EFFECTS: readonly RepairFixtureEffect[] = [
  { arguments: { path: "canon" }, effectId: "ensure-canon", templateId: "ensure-canon-directory" },
];

function scratchDirectory(prefix: string): string {
  return mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_ATTEMPTED_AT);
  home = repairFixtureIsolatedHome();
  root = scratchDirectory("aih-repair-account-root-");
  decoy = scratchDirectory("aih-repair-decoy-home-");
  previousHome = process.env.HOME;
  previousProfile = process.env.USERPROFILE;
  process.env.HOME = decoy;
  process.env.USERPROFILE = decoy;
});

function restoreEnv(name: "HOME" | "USERPROFILE", previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv("HOME", previousHome);
  restoreEnv("USERPROFILE", previousProfile);
  home.release();
  rmSync(root, { force: true, recursive: true });
  rmSync(decoy, { force: true, recursive: true });
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

describe("durable claim store account home", () => {
  /**
   * Resolved -- the reviewed environment-redirection defect. The store read
   * `os.homedir()`, which prefers `$HOME` / `%USERPROFILE%`, so an operator or a
   * caller could relaunch the same granted Plan under a different environment and
   * be handed a fresh empty store. Single use survived only as long as nobody
   * changed a variable.
   */
  it("resolves one store from the OS account, whatever the environment says", async () => {
    const built = await plan();
    const first = acquire(built);
    expect(readdirSync(store())).toEqual([`${first.claimSha256}.json`]);

    // The same Plan, the same root, the same account -- and a different
    // environment. Nothing about the account changed, so nothing about the store
    // or the record's name may change either.
    const elsewhere = scratchDirectory("aih-repair-elsewhere-home-");
    try {
      process.env.HOME = elsewhere;
      process.env.USERPROFILE = elsewhere;

      expect(() => acquire(built)).toThrow(ALREADY);
      // No second store was selected, and none was created to be empty in.
      expect(existsSync(join(elsewhere, ".aih"))).toBe(false);
      expect(existsSync(join(decoy, ".aih"))).toBe(false);
      // The one record that spends this Plan is still the only one there is.
      expect(readdirSync(store())).toEqual([`${first.claimSha256}.json`]);
    } finally {
      rmSync(elsewhere, { force: true, recursive: true });
    }
  });

  it("fails closed when the account reports no usable home", async () => {
    const built = await plan();

    for (const unusable of ["", "relative/home", join(home.path, "no-such-account-home")]) {
      setRepairFixtureAccountHomeV1(unusable);
      expect(() => acquire(built), unusable).toThrow(UNAVAILABLE);
    }

    // Nothing was created anywhere while the account home was unusable -- least of
    // all under the environment the store is required to ignore.
    setRepairFixtureAccountHomeV1(home.path);
    expect(existsSync(store())).toBe(false);
    expect(existsSync(join(decoy, ".aih"))).toBe(false);
  });

  /**
   * A reported home that is itself a link is a redirect by another name.
   *
   * Canonicalizing it and carrying on would follow the link wherever it points,
   * so whoever can re-point it chooses the store -- the same defect as reading
   * `HOME`, arriving by a different route. The spelling the account reports has
   * to *be* the directory, so a symlink and a Windows junction or other reparse
   * point are refused rather than resolved.
   */
  it("refuses a reported account home that is a symlink or reparse point", async () => {
    const built = await plan();
    const link = join(decoy, "link-to-account-home");
    try {
      symlinkSync(home.path, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // The volume or account does not permit creating one.
    }

    setRepairFixtureAccountHomeV1(link);
    expect(() => acquire(built)).toThrow(UNAVAILABLE);

    // The link was not followed: no store exists under what it pointed at.
    setRepairFixtureAccountHomeV1(home.path);
    expect(existsSync(store())).toBe(false);
    expect(existsSync(join(link, ".aih"))).toBe(false);
  });
});
