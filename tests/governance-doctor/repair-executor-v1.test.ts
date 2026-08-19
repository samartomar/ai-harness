import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1 } from "../../src/governance-doctor/repair-broker-v1.js";
import {
  canonicalGovernanceDoctorRepairClaimV1Bytes,
  createGovernanceDoctorRepairClaimV1,
  type GovernanceDoctorRepairClaimStateV1,
  governanceDoctorRepairClaimFileNameV1,
  governanceDoctorRepairClaimScopeSha256V1,
} from "../../src/governance-doctor/repair-claim-v1.js";
import {
  createGovernanceDoctorRepairContentV1,
  governanceDoctorRepairMarkerBeginLineV1,
  governanceDoctorRepairMarkerEndLineV1,
} from "../../src/governance-doctor/repair-content-v1.js";
import { createGovernanceDoctorRepairCustodyV1 } from "../../src/governance-doctor/repair-custody-v1.js";
import {
  executeGovernanceDoctorRepairV1,
  GOVERNANCE_DOCTOR_REPAIR_EXECUTABLE_EFFECT_KINDS_V1,
} from "../../src/governance-doctor/repair-executor-v1.js";
import type { GovernanceDoctorRepairPlanV1 } from "../../src/governance-doctor/repair-plan-v1.js";
import {
  REPAIR_FIXTURE_ATTEMPTED_AT,
  REPAIR_FIXTURE_CONSENTED_AT,
  REPAIR_FIXTURE_CONTEXT_DIR,
  REPAIR_FIXTURE_EXPIRES_AT,
  type RepairFixtureEffect,
  type RepairFixtureHome,
  repairFixtureClaimStoreDirectory,
  repairFixtureConsent,
  repairFixtureExecutionContext,
  repairFixtureIsolatedHome,
  repairFixturePlan,
  repairFixtureSha256,
} from "./repair-execution-fixture-v1.js";

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
let outside: string;
let home: RepairFixtureHome;

const BEGIN = governanceDoctorRepairMarkerBeginLineV1("canon-block");
const END = governanceDoctorRepairMarkerEndLineV1("canon-block");

const ROUTER_BODY = "router body\n";
const BLOCK_BODY = "generated block";
const ROUTER_SHA256 = repairFixtureSha256(ROUTER_BODY);
const BLOCK_SHA256 = repairFixtureSha256(BLOCK_BODY);

const SCOPE = ["block.md", "canon", "canon/router.md", "crlf.md"] as const;

const EFFECTS: readonly RepairFixtureEffect[] = [
  { arguments: { path: "canon" }, effectId: "ensure-canon", templateId: "ensure-canon-directory" },
  {
    arguments: { path: "crlf.md" },
    effectId: "normalize-crlf",
    templateId: "normalize-canon-endings",
  },
  {
    arguments: { contentSha256: ROUTER_SHA256, path: "canon/router.md" },
    effectId: "restore-router",
    templateId: "restore-canon-file",
  },
  {
    arguments: { blockId: "canon-block", contentSha256: BLOCK_SHA256, path: "block.md" },
    effectId: "rewrite-block",
    templateId: "rewrite-canon-block",
  },
];

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_ATTEMPTED_AT);
  // Every execution below now takes a durable claim. Without this the suite would
  // write claim records into the real user's home.
  home = repairFixtureIsolatedHome();
  root = mkdtempSync(join(tmpdir(), "aih-repair-executor-"));
  outside = mkdtempSync(join(tmpdir(), "aih-repair-outside-"));
  writeFileSync(join(root, "crlf.md"), "a\r\nb\r\n");
  writeFileSync(join(root, "block.md"), `preamble\n${BEGIN}\nold\n${END}\ntrailer\n`);
  writeFileSync(join(root, "bystander.md"), "bystander\r\n");
});

afterEach(() => {
  vi.restoreAllMocks();
  home.release();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function plan(
  effects: readonly RepairFixtureEffect[] = EFFECTS,
  planNonce?: string,
): Promise<GovernanceDoctorRepairPlanV1> {
  return repairFixturePlan({
    effects,
    ...(planNonce === undefined ? {} : { planNonce }),
    root,
    scopePaths: SCOPE,
  });
}

function trustedContent(...bodies: readonly string[]) {
  return createGovernanceDoctorRepairContentV1({
    entries: bodies.map((body) => {
      const bytes = Buffer.from(body, "utf8");
      return { bytes, contentSha256: repairFixtureSha256(bytes) };
    }),
  });
}

function custody(built: GovernanceDoctorRepairPlanV1) {
  return createGovernanceDoctorRepairCustodyV1({
    contextDir: REPAIR_FIXTURE_CONTEXT_DIR,
    plan: built,
    root,
  });
}

function execute(built: GovernanceDoctorRepairPlanV1, overrides: Record<string, unknown> = {}) {
  return executeGovernanceDoctorRepairV1({
    consent: repairFixtureConsent(built),
    content: trustedContent(ROUTER_BODY, BLOCK_BODY),
    context: repairFixtureExecutionContext(built),
    custody: custody(built),
    plan: built,
    ...overrides,
  });
}

function executeOnly(built: GovernanceDoctorRepairPlanV1, ...bodies: readonly string[]) {
  return executeGovernanceDoctorRepairV1({
    consent: repairFixtureConsent(built),
    content: trustedContent(...bodies),
    context: repairFixtureExecutionContext(built),
    custody: custody(built),
    plan: built,
  });
}

/** The refusal message a closed failure produced, or an empty string if none did. */
function refusalMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

/** The one directory the durable claim store may own under the fixture home. */
function claimStore(): string {
  return repairFixtureClaimStoreDirectory(home.path);
}

function claimPath(claimSha256: string): string {
  return join(claimStore(), governanceDoctorRepairClaimFileNameV1(claimSha256));
}

function expectedClaimSha256(
  built: GovernanceDoctorRepairPlanV1,
  realPath: string = realpathSync.native(root),
): string {
  return createGovernanceDoctorRepairClaimV1({
    claimedAtEpochMs: REPAIR_FIXTURE_CONSENTED_AT,
    consentSha256: repairFixtureConsent(built).consentSha256,
    planSha256: built.planSha256,
    scopeSha256: governanceDoctorRepairClaimScopeSha256V1({ realPath }),
    state: "claimed",
  }).claimSha256;
}

/**
 * Writes the durable record a previous process would have left, without going
 * through the executor at all. Nothing in this process holds any memory of it.
 */
function seedClaim(
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
  mkdirSync(claimStore(), { recursive: true });
  writeFileSync(claimPath(claim.claimSha256), canonicalGovernanceDoctorRepairClaimV1Bytes(claim));
  return claim;
}

const results = (receipt: { effects: readonly { result: string }[] }) =>
  receipt.effects.map((effect) => effect.result);

describe("executeGovernanceDoctorRepairV1", () => {
  it("never widens the frozen V1 effect allowlist", () => {
    expect([...GOVERNANCE_DOCTOR_REPAIR_EXECUTABLE_EFFECT_KINDS_V1]).toEqual([
      ...GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1,
    ]);
    expect(Object.isFrozen(GOVERNANCE_DOCTOR_REPAIR_EXECUTABLE_EFFECT_KINDS_V1)).toBe(true);
  });

  it("applies all four frozen effect kinds and returns a bound applied-unverified receipt", async () => {
    const built = await plan();
    const receipt = execute(built);

    expect(results(receipt)).toEqual(["applied", "applied", "applied", "applied"]);
    expect(receipt.state).toBe("applied-unverified");
    expect(receipt.planSha256).toBe(built.planSha256);
    expect(receipt.rootSha256).toBe(built.rootSha256);
    expect(receipt.effects.map((effect) => effect.effectSha256)).toEqual(
      built.effects.map((effect) => effect.effectSha256),
    );

    expect(readFileSync(join(root, "canon", "router.md"), "utf8")).toBe(ROUTER_BODY);
    expect(readFileSync(join(root, "crlf.md"), "utf8")).toBe("a\nb\n");
    expect(readFileSync(join(root, "block.md"), "utf8")).toBe(
      `preamble\n${BEGIN}\n${BLOCK_BODY}\n${END}\ntrailer\n`,
    );
  });

  /**
   * The authority window is re-read per effect, so a plan that expires between
   * effects must stop rather than finish on the strength of a check it passed
   * before the first write. Freezing the clock for the whole run would never
   * exercise that, which is why this advances it mid-run.
   */
  it("halts when the authority window closes between effects", async () => {
    const built = await plan();
    // The window closes the moment the first effect has landed on disk, which is
    // a fact about the run rather than a guess at how many times the clock is
    // read. Effect zero creates `canon`.
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() =>
        existsSync(join(root, "canon")) ? built.expiresAtEpochMs + 1 : REPAIR_FIXTURE_ATTEMPTED_AT,
      );
    try {
      const receipt = execute(built);
      const outcome = results(receipt);
      expect(outcome[0]).toBe("applied");
      expect(outcome.slice(1).every((result) => result !== "applied")).toBe(true);
      expect(receipt.state).toBe("failed");
      // The effects that never ran left nothing behind.
      expect(existsSync(join(root, "canon", "router.md"))).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it("preserves every unrelated byte and deletes nothing", async () => {
    execute(await plan());
    expect(readFileSync(join(root, "bystander.md"), "utf8")).toBe("bystander\r\n");
  });

  it("allows a fresh Plan over an already-satisfied state without replaying the old Plan", async () => {
    const built = await plan();
    const first = execute(built);
    const before = readFileSync(join(root, "block.md"));
    const secondPlan = await plan(EFFECTS, "6e".repeat(32));
    const second = execute(secondPlan);

    expect(second.planSha256).not.toBe(first.planSha256);
    expect(readFileSync(join(root, "block.md"))).toEqual(before);
    expect(second.state).toBe("applied-unverified");
  });

  /**
   * Resolved -- issue #775, review finding 2. Durable single-use now has an
   * authority home.
   *
   * The `consumedPlanSha256` array this executor used to accept was never
   * authority: it was the caller vouching for itself, so accepting it let one
   * granted Consent be spent any number of times while the Receipt still read as a
   * one-shot application. Removing it was the fail-closed half of the correction;
   * the durable machine-local claim store is the other half.
   *
   * The claim is taken after every pure join and before the first effect, so the
   * refusal below happens with the tree untouched. The two undone effects are what
   * make that observable: a replay that reached the effect loop would restore them.
   */
  it("refuses to spend one granted consent more than once, before any effect", async () => {
    const built = await plan();
    expect(execute(built).state).toBe("applied-unverified");
    writeFileSync(join(root, "crlf.md"), "a\r\nb\r\n");
    rmSync(join(root, "canon", "router.md"));

    expect(() => execute(built)).toThrow(
      /^GOVERNANCE_DOCTOR_REPAIR_V1: repair plan was already claimed$/,
    );
    expect(readFileSync(join(root, "crlf.md"), "utf8")).toBe("a\r\nb\r\n");
    expect(existsSync(join(root, "canon", "router.md"))).toBe(false);
  });

  /**
   * Resolved -- the reviewed identity defect. Minting a second granted Consent for
   * the same Plan under the same canonical root is a replay of one spent authority,
   * not a fresh one, so it has to be refused before the first byte moves.
   *
   * The two undone effects below are what make "before every effect" observable: a
   * run that reached the effect loop would restore them.
   */
  it("refuses a fresh granted consent for a plan already claimed, before any effect", async () => {
    const built = await plan();
    expect(execute(built).state).toBe("applied-unverified");
    writeFileSync(join(root, "crlf.md"), "a\r\nb\r\n");
    rmSync(join(root, "canon", "router.md"));

    const fresh = repairFixtureConsent(built, { consentNonce: "9a".repeat(32) });
    expect(fresh.consentSha256).not.toBe(repairFixtureConsent(built).consentSha256);

    expect(() => execute(built, { consent: fresh })).toThrow(
      /^GOVERNANCE_DOCTOR_REPAIR_V1: repair plan was already claimed$/,
    );
    expect(readFileSync(join(root, "crlf.md"), "utf8")).toBe("a\r\nb\r\n");
    expect(existsSync(join(root, "canon", "router.md"))).toBe(false);
    // One plan under one root still occupies exactly one name.
    expect(readdirSync(claimStore())).toEqual([`${expectedClaimSha256(built)}.json`]);
  });

  /**
   * The restart case, and the crash case, which are the same case.
   *
   * The record is written straight into the store here, so nothing in this process
   * has ever seen this Plan: no brand, no WeakMap, and no module-level cache can be
   * what refuses it. Only the durable record can. That is exactly the state a crash
   * between the claim and the first effect leaves behind -- a claim with no work
   * done -- and it must refuse rather than invite a retry.
   */
  it("refuses a plan a previous process claimed but never applied", async () => {
    const built = await plan();
    seedClaim(built);

    expect(() => execute(built)).toThrow(
      /^GOVERNANCE_DOCTOR_REPAIR_V1: repair plan was already claimed$/,
    );
    expect(readFileSync(join(root, "crlf.md"), "utf8")).toBe("a\r\nb\r\n");
    expect(existsSync(join(root, "canon"))).toBe(false);
  });

  it("refuses a plan whose durable record has already reached a terminal state", async () => {
    const built = await plan();
    seedClaim(built, "consumed");

    expect(() => execute(built)).toThrow(
      /^GOVERNANCE_DOCTOR_REPAIR_V1: repair plan was already claimed$/,
    );
    expect(existsSync(join(root, "canon"))).toBe(false);
  });

  it("refuses rather than reads a malformed durable record as an absent one", async () => {
    const built = await plan();
    const seeded = seedClaim(built);
    writeFileSync(claimPath(seeded.claimSha256), "{ not a claim");

    expect(() => execute(built)).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: (?!repair plan was already claimed)/,
    );
    expect(existsSync(join(root, "canon"))).toBe(false);
  });

  it("binds the claim to this canonical root, so another checkout's record does not block it", async () => {
    const built = await plan();
    // The same Plan and the same granted Consent, claimed under a different
    // canonical root. Moving a checkout is a new authority scope on purpose.
    seedClaim(built, "claimed", realpathSync.native(outside));

    expect(execute(built).state).toBe("applied-unverified");
    expect(readFileSync(join(root, "crlf.md"), "utf8")).toBe("a\nb\n");
    expect(readdirSync(claimStore())).toHaveLength(2);
  });

  it("claims into the machine-local store under a fixed digest-derived name only", async () => {
    const built = await plan();
    execute(built);

    // Not the project's disposable `.aih/`, and not any other project location.
    expect(existsSync(join(root, ".aih"))).toBe(false);
    const entries = readdirSync(claimStore());
    expect(entries).toEqual([`${expectedClaimSha256(built)}.json`]);
    expect(entries[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  });

  it("rejects caller-supplied replay state instead of treating it as authority", async () => {
    const built = await plan();
    expect(() => execute(built, { consumedPlanSha256: [built.planSha256] })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(readFileSync(join(root, "crlf.md"), "utf8")).toBe("a\r\nb\r\n");
  });

  it("uses the actual wall clock rather than a caller-supplied in-window attempt instant", async () => {
    const built = await plan();
    vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_EXPIRES_AT);

    expect(() => execute(built, { attemptedAtEpochMs: REPAIR_FIXTURE_ATTEMPTED_AT })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(readFileSync(join(root, "crlf.md"), "utf8")).toBe("a\r\nb\r\n");
  });

  it("refuses a denied consent, a foreign consent, and an attempt outside the window", async () => {
    const built = await plan();
    const other = await plan(EFFECTS, "1a".repeat(32));

    expect(() =>
      execute(built, { consent: repairFixtureConsent(built, { decision: "denied" }) }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(() => execute(built, { consent: repairFixtureConsent(other) })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_EXPIRES_AT);
    expect(() => execute(built)).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(readFileSync(join(root, "crlf.md"), "utf8")).toBe("a\r\nb\r\n");
  });

  it("requires an exactly closed trusted content input", async () => {
    const built = await plan();
    expect(() => execute(built, { content: trustedContent(ROUTER_BODY) })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(() =>
      execute(built, { content: trustedContent(ROUTER_BODY, BLOCK_BODY, "extra\n") }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(() =>
      execute(built, { content: { protocol: "GovernanceDoctorRepairContentV1" } }),
    ).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(readFileSync(join(root, "crlf.md"), "utf8")).toBe("a\r\nb\r\n");
  });

  it("refuses custody minted for a different plan and a non-closed request", async () => {
    const built = await plan();
    const other = await plan(EFFECTS, "1a".repeat(32));

    expect(() => execute(built, { custody: custody(other) })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
    expect(() => execute(built, { extra: 1 })).toThrow(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(() => execute(built, { plan: { ...built } })).toThrow(
      /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /,
    );
  });

  it("records a failed effect, skips the rest, and never claims a rollback that did not occur", async () => {
    mkdirSync(join(root, "canon"));
    mkdirSync(join(root, "canon", "router.md"));
    const built = await plan();
    const receipt = execute(built);

    expect(results(receipt)).toEqual(["applied", "applied", "failed", "skipped"]);
    expect(receipt.state).toBe("failed");
    // The normalization that already committed is reported as applied, not undone.
    expect(readFileSync(join(root, "crlf.md"), "utf8")).toBe("a\nb\n");
    expect(readFileSync(join(root, "block.md"), "utf8")).toBe(
      `preamble\n${BEGIN}\nold\n${END}\ntrailer\n`,
    );
  });

  it("fails an effect whose managed file carries an unsafe encoding", async () => {
    writeFileSync(join(root, "crlf.md"), "a\rb\n");
    const built = await plan([
      {
        arguments: { path: "crlf.md" },
        effectId: "normalize-crlf",
        templateId: "normalize-canon-endings",
      },
    ]);
    const receipt = executeOnly(built);

    expect(results(receipt)).toEqual(["failed"]);
    expect(receipt.state).toBe("failed");
    expect(readFileSync(join(root, "crlf.md"), "utf8")).toBe("a\rb\n");
  });

  it.skipIf(process.platform === "win32")(
    "fails an effect whose managed path is a symlink out of the root",
    async () => {
      rmSync(join(root, "crlf.md"));
      writeFileSync(join(outside, "target.md"), "a\r\nb\r\n");
      symlinkSync(join(outside, "target.md"), join(root, "crlf.md"));
      const built = await plan([
        {
          arguments: { path: "crlf.md" },
          effectId: "normalize-crlf",
          templateId: "normalize-canon-endings",
        },
      ]);
      const receipt = executeOnly(built);

      expect(results(receipt)).toEqual(["failed"]);
      expect(readFileSync(join(outside, "target.md"), "utf8")).toBe("a\r\nb\r\n");
    },
  );

  it("fails a marker rewrite over a malformed region instead of repairing it", async () => {
    writeFileSync(join(root, "block.md"), `preamble\n${BEGIN}\nold\n`);
    const built = await plan([
      {
        arguments: { blockId: "canon-block", contentSha256: BLOCK_SHA256, path: "block.md" },
        effectId: "rewrite-block",
        templateId: "rewrite-canon-block",
      },
    ]);
    const receipt = executeOnly(built, BLOCK_BODY);

    expect(results(receipt)).toEqual(["failed"]);
    expect(readFileSync(join(root, "block.md"), "utf8")).toBe(`preamble\n${BEGIN}\nold\n`);
  });

  it("never echoes a managed path or file content in a refusal", async () => {
    const built = await plan();
    const message = refusalMessage(() =>
      execute(built, { consumedPlanSha256: [built.planSha256] }),
    );

    expect(message).toMatch(/^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /);
    expect(message).not.toContain(root);
    expect(message).not.toContain("router.md");
    expect(message).not.toContain(ROUTER_BODY.trim());
  });
});
