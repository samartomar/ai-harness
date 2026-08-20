import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGovernanceDoctorOperationalContextV1 } from "../../src/governance-doctor/operational-v1.js";
import {
  attemptGovernanceDoctorRepairV1,
  didGovernanceDoctorRepairAttemptEffectChangeV1,
  GovernanceDoctorRepairPostClaimRefusalV1,
  isGovernanceDoctorRepairPostClaimRefusalV1,
} from "../../src/governance-doctor/repair-attempt-v1.js";
import { createGovernanceDoctorRepairContentV1 } from "../../src/governance-doctor/repair-content-v1.js";
import { createGovernanceDoctorRepairCustodyV1 } from "../../src/governance-doctor/repair-custody-v1.js";
import { observeGovernanceDoctorRepairPreconditionV1 } from "../../src/governance-doctor/repair-precondition-v1.js";
import { mintGovernanceDoctorRepairPreconditionScopeV1 } from "../../src/governance-doctor/repair-scope-v1.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  REPAIR_FIXTURE_ATTEMPTED_AT,
  REPAIR_FIXTURE_CONTEXT_DIR,
  type RepairFixtureHome,
  repairFixtureClaimStoreDirectory,
  repairFixtureConsent,
  repairFixtureExecutionContext,
  repairFixtureIsolatedHome,
  repairFixturePlan,
} from "./repair-execution-fixture-v1.js";

/**
 * The observer and claim boundary are deliberately interposed only in this
 * high-level attempt suite. The count proves that a passing root-replacement
 * case did not merely rely on custody's existing mutation-boundary rejection.
 */
const interposition = vi.hoisted(() => ({
  afterClaim: undefined as undefined | (() => void),
  claimCalls: 0,
  claimStorePredicateMissing: false,
  claimStorePredicateMode: "actual" as "actual" | "undefined" | "truthy",
  claimStoreThrows: false,
  claimWriteStalls: false,
  executorClaimPredicateMissing: false,
  executorClaimPredicateMode: "actual" as "actual" | "undefined" | "truthy",
  executorClaimThrows: false,
  executorThrows: false,
  occupancyCalls: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: (...input: Parameters<typeof actual.writeSync>): number =>
      interposition.claimWriteStalls ? 0 : actual.writeSync(...input),
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { repairFixtureOsModuleV1 } = await import("./repair-account-home-v1.js");
  return repairFixtureOsModuleV1(actual);
});

vi.mock("../../src/governance-doctor/repair-target-occupancy-v1.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/governance-doctor/repair-target-occupancy-v1.js")
    >();
  return {
    ...actual,
    observeGovernanceDoctorRepairTargetOccupancyV1: (scope: unknown) => {
      interposition.occupancyCalls += 1;
      return actual.observeGovernanceDoctorRepairTargetOccupancyV1(scope);
    },
  };
});

vi.mock("../../src/governance-doctor/repair-claim-store-v1.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/governance-doctor/repair-claim-store-v1.js")>();
  const actualAcquire =
    actual.acquireGovernanceDoctorRepairClaimV1 as typeof actual.acquireGovernanceDoctorRepairClaimV1 & {
      readonly isPostExclusiveCreateRefusalV1: (value: unknown) => boolean;
    };
  const acquire = (input: unknown) => {
    interposition.claimCalls += 1;
    if (interposition.claimStoreThrows) throw new Error("claim-store interposition failure");
    const claim = actualAcquire(input);
    interposition.afterClaim?.();
    return claim;
  };
  Object.defineProperty(acquire, "isPostExclusiveCreateRefusalV1", {
    get: () => {
      if (interposition.claimStorePredicateMissing) return undefined;
      if (interposition.claimStorePredicateMode === "undefined") return () => undefined;
      if (interposition.claimStorePredicateMode === "truthy") return () => "malformed";
      return actualAcquire.isPostExclusiveCreateRefusalV1;
    },
  });
  return {
    ...actual,
    acquireGovernanceDoctorRepairClaimV1: acquire,
  };
});

vi.mock("../../src/governance-doctor/repair-executor-v1.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/governance-doctor/repair-executor-v1.js")>();
  const actualClaim =
    actual.claimGovernanceDoctorRepairExecutionV1 as typeof actual.claimGovernanceDoctorRepairExecutionV1 & {
      readonly isPostClaimRefusalV1: (value: unknown) => boolean;
    };
  const claim = (prepared: unknown) => {
    if (interposition.executorClaimThrows) throw new Error("executor claim interposition failure");
    return actualClaim(prepared);
  };
  Object.defineProperty(claim, "isPostClaimRefusalV1", {
    get: () => {
      if (interposition.executorClaimPredicateMissing) return undefined;
      if (interposition.executorClaimPredicateMode === "undefined") return () => undefined;
      if (interposition.executorClaimPredicateMode === "truthy") return () => "malformed";
      return actualClaim.isPostClaimRefusalV1;
    },
  });
  return {
    ...actual,
    claimGovernanceDoctorRepairExecutionV1: claim,
    applyGovernanceDoctorRepairExecutionOutcomeV1: (claimed: unknown) => {
      if (interposition.executorThrows) throw new Error("executor failure after durable claim");
      return actual.applyGovernanceDoctorRepairExecutionOutcomeV1(claimed);
    },
  };
});

const CANON = "ai-coding";

let home: RepairFixtureHome;
let root: string;
let replacement: string;
let moved: string;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_ATTEMPTED_AT);
  interposition.afterClaim = undefined;
  interposition.claimCalls = 0;
  interposition.claimStorePredicateMissing = false;
  interposition.claimStorePredicateMode = "actual";
  interposition.claimStoreThrows = false;
  interposition.claimWriteStalls = false;
  interposition.executorClaimPredicateMissing = false;
  interposition.executorClaimPredicateMode = "actual";
  interposition.executorClaimThrows = false;
  interposition.executorThrows = false;
  interposition.occupancyCalls = 0;
  home = repairFixtureIsolatedHome();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "aih-repair-attempt-")));
  replacement = root;
  moved = `${root}-moved`;
});

afterEach(() => {
  vi.restoreAllMocks();
  home.release();
  rmSync(root, { force: true, recursive: true });
  rmSync(moved, { force: true, recursive: true });
});

function scopeFor(rootPath: string) {
  const run = fakeRunner(() => undefined);
  return mintGovernanceDoctorRepairPreconditionScopeV1(
    createGovernanceDoctorOperationalContextV1({
      apply: false,
      contextDir: CANON,
      env: {},
      host: makeHostAdapter({ env: {}, platform: "linux", run }),
      json: true,
      options: {},
      root: rootPath,
      run,
      verify: true,
    } as unknown as PlanContext),
  );
}

async function attempt(scope = scopeFor(root)) {
  const plan = await repairFixturePlan({
    effects: [
      {
        arguments: { path: CANON },
        effectId: "create-canonical-context-directory",
        templateId: "ensure-canon-directory",
      },
    ],
    root,
    scopePaths: [CANON],
  });
  const custody = createGovernanceDoctorRepairCustodyV1({
    contextDir: REPAIR_FIXTURE_CONTEXT_DIR,
    plan,
    root,
  });
  return attemptGovernanceDoctorRepairV1({
    consent: repairFixtureConsent(plan),
    content: createGovernanceDoctorRepairContentV1({ entries: [] }),
    context: repairFixtureExecutionContext(plan),
    custody,
    plan,
    scope,
  });
}

function claimFiles(): readonly string[] {
  const store = repairFixtureClaimStoreDirectory(home.path);
  return existsSync(store) ? readdirSync(store) : [];
}

describe("Governance Doctor live Repair attempt V1", () => {
  it("keeps a valid negative claim-store predicate pre-claim", async () => {
    interposition.claimStoreThrows = true;
    const refusal = await attempt(scopeFor(root)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isGovernanceDoctorRepairPostClaimRefusalV1(refusal)).toBe(false);
    expect((refusal as Error).message).toBe("claim-store interposition failure");
    expect(interposition.claimCalls).toBe(1);
    expect(claimFiles()).toEqual([]);
    expect(existsSync(join(root, CANON))).toBe(false);
  });

  it("keeps a missing claim-store predicate conservatively post-claim", async () => {
    interposition.claimStorePredicateMissing = true;
    interposition.claimStoreThrows = true;
    const refusal = await attempt(scopeFor(root)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isGovernanceDoctorRepairPostClaimRefusalV1(refusal)).toBe(true);
    expect((refusal as GovernanceDoctorRepairPostClaimRefusalV1).effectState).toBe("not-applied");
    expect(interposition.claimCalls).toBe(1);
    expect(claimFiles()).toEqual([]);
    expect(existsSync(join(root, CANON))).toBe(false);
  });

  it("keeps an undefined claim-store predicate result conservatively post-claim", async () => {
    interposition.claimStorePredicateMode = "undefined";
    interposition.claimStoreThrows = true;
    const refusal = await attempt(scopeFor(root)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isGovernanceDoctorRepairPostClaimRefusalV1(refusal)).toBe(true);
    expect((refusal as GovernanceDoctorRepairPostClaimRefusalV1).effectState).toBe("not-applied");
    expect(interposition.claimCalls).toBe(1);
    expect(claimFiles()).toEqual([]);
    expect(existsSync(join(root, CANON))).toBe(false);
  });

  it("keeps a missing executor predicate conservatively post-claim", async () => {
    interposition.executorClaimPredicateMissing = true;
    interposition.executorClaimThrows = true;
    const refusal = await attempt(scopeFor(root)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isGovernanceDoctorRepairPostClaimRefusalV1(refusal)).toBe(true);
    expect((refusal as GovernanceDoctorRepairPostClaimRefusalV1).effectState).toBe("not-applied");
    expect(interposition.claimCalls).toBe(0);
    expect(claimFiles()).toEqual([]);
    expect(existsSync(join(root, CANON))).toBe(false);
  });

  it("keeps a truthy executor predicate result conservatively post-claim", async () => {
    interposition.executorClaimPredicateMode = "truthy";
    interposition.executorClaimThrows = true;
    const refusal = await attempt(scopeFor(root)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isGovernanceDoctorRepairPostClaimRefusalV1(refusal)).toBe(true);
    expect((refusal as GovernanceDoctorRepairPostClaimRefusalV1).effectState).toBe("not-applied");
    expect(interposition.claimCalls).toBe(0);
    expect(claimFiles()).toEqual([]);
    expect(existsSync(join(root, CANON))).toBe(false);
  });

  it("classifies an exclusive-create short write as post-claim without a target effect", async () => {
    interposition.claimWriteStalls = true;
    const refusal = await attempt(scopeFor(root)).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isGovernanceDoctorRepairPostClaimRefusalV1(refusal)).toBe(true);
    expect(refusal).toBeInstanceOf(GovernanceDoctorRepairPostClaimRefusalV1);
    expect((refusal as GovernanceDoctorRepairPostClaimRefusalV1).effectState).toBe("not-applied");
    expect(interposition.claimCalls).toBe(1);
    expect(claimFiles()).toHaveLength(1);
    expect(
      readFileSync(join(repairFixtureClaimStoreDirectory(home.path), claimFiles()[0] ?? "")),
    ).toEqual(Buffer.alloc(0));
    expect(existsSync(join(root, CANON))).toBe(false);
  });

  it("marks an executor exception after the durable claim as post-claim without inventing an effect", async () => {
    interposition.executorThrows = true;
    const scope = scopeFor(root);

    await expect(attempt(scope)).rejects.toThrow(
      /^GOVERNANCE_DOCTOR_V1: repair attempt precondition is not currently eligible$/,
    );

    expect(interposition.claimCalls).toBe(1);
    expect(claimFiles()).toHaveLength(1);
    expect(existsSync(join(root, CANON))).toBe(false);
  });

  it("creates only the canonical managed directory from a fresh branded scope and spends one claim", async () => {
    const scope = scopeFor(root);
    const initial = observeGovernanceDoctorRepairPreconditionV1(scope);
    expect(initial.eligible).toBe(true);
    expect(initial.targetOccupancy).toBe("unoccupied");

    const receipt = await attempt(scope);

    expect(receipt.state).toBe("applied-unverified");
    expect(receipt.effects).toEqual([
      expect.objectContaining({
        effectId: "create-canonical-context-directory",
        result: "applied",
      }),
    ]);
    expect(readdirSync(root)).toEqual([CANON]);
    expect(statSync(join(root, CANON)).isDirectory()).toBe(true);
    const effectSha256 = receipt.effects[0]?.effectSha256;
    expect(typeof effectSha256).toBe("string");
    expect(didGovernanceDoctorRepairAttemptEffectChangeV1({ effectSha256, receipt })).toBe(true);
    expect(() =>
      didGovernanceDoctorRepairAttemptEffectChangeV1({ effectSha256, receipt: { ...receipt } }),
    ).toThrow(TypeError);
    expect(claimFiles()).toHaveLength(1);
    // Initial probe, pre-claim re-observation, and effect-boundary re-observation.
    expect(interposition.occupancyCalls).toBe(3);
    expect(interposition.claimCalls).toBe(1);
  });

  it("refuses a target that became occupied after observation but before its live pre-claim check without spending a claim", async () => {
    const scope = scopeFor(root);
    const initial = observeGovernanceDoctorRepairPreconditionV1(scope);
    expect(initial.eligible).toBe(true);
    expect(initial.targetOccupancy).toBe("unoccupied");
    mkdirSync(join(root, CANON));
    writeFileSync(join(root, CANON, "pre-existing.txt"), "bystander");

    await expect(attempt(scope)).rejects.toThrow(
      /^GOVERNANCE_DOCTOR_V1: repair attempt precondition is not currently eligible$/,
    );

    // The stale branded record still describes the old tree, so passing relies
    // on the new live observation rather than reinterpreting that record.
    expect(initial.targetOccupancy).toBe("unoccupied");
    expect(interposition.occupancyCalls).toBe(2);
    expect(interposition.claimCalls).toBe(0);
    expect(claimFiles()).toEqual([]);
    expect(readdirSync(join(root, CANON))).toEqual(["pre-existing.txt"]);
  });

  it("refuses a branded scope for a different custody root before observation can spend a claim", async () => {
    const otherRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "aih-repair-attempt-other-")));
    try {
      await expect(attempt(scopeFor(otherRoot))).rejects.toThrow(
        /^GOVERNANCE_DOCTOR_V1: repair attempt precondition is not currently eligible$/,
      );
      expect(interposition.occupancyCalls).toBe(0);
      expect(interposition.claimCalls).toBe(0);
      expect(claimFiles()).toEqual([]);
      expect(readdirSync(root)).toEqual([]);
      expect(readdirSync(otherRoot)).toEqual([]);
    } finally {
      rmSync(otherRoot, { force: true, recursive: true });
    }
  });

  it("refuses a same-root target occupation after its durable claim without applying an effect", async () => {
    const scope = scopeFor(root);
    const initial = observeGovernanceDoctorRepairPreconditionV1(scope);
    expect(initial.eligible).toBe(true);
    writeFileSync(join(root, "bystander.txt"), "leave this alone\n");

    interposition.afterClaim = () => {
      // The root itself stays bound. Only the canonical target becomes occupied
      // after the durable claim, so the second observer -- not custody's root
      // identity boundary -- must stop the executor before its first effect.
      mkdirSync(join(root, CANON));
    };

    await expect(attempt(scope)).rejects.toThrow(
      /^GOVERNANCE_DOCTOR_V1: repair attempt precondition is not currently eligible$/,
    );

    expect(interposition.claimCalls).toBe(1);
    expect(claimFiles()).toHaveLength(1);
    // Initial probe, pre-claim probe, then post-claim target-occupancy probe.
    expect(interposition.occupancyCalls).toBe(3);
    expect(readdirSync(join(root, CANON))).toEqual([]);
    expect(readFileSync(join(root, "bystander.txt"), "utf8")).toBe("leave this alone\n");
    expect(readdirSync(root).sort()).toEqual([CANON, "bystander.txt"]);
  });

  it("refuses at the effect boundary after a durable claim when its bound root is replaced", async () => {
    const scope = scopeFor(root);
    const initial = observeGovernanceDoctorRepairPreconditionV1(scope);
    expect(initial.eligible).toBe(true);

    interposition.afterClaim = () => {
      // This hook runs only after the real exclusive claim has committed. A
      // fresh directory at the same canonical spelling defeats path-only
      // assumptions while custody's existing identity check would also refuse;
      // the exact observer count below neutralizes that accidental coverage.
      renameSync(root, moved);
      mkdirSync(root);
      replacement = root;
    };

    await expect(attempt(scope)).rejects.toThrow(
      /^GOVERNANCE_DOCTOR_V1: repair attempt precondition is not currently eligible$/,
    );

    expect(interposition.claimCalls).toBe(1);
    expect(claimFiles()).toHaveLength(1);
    // Initial probe, pre-claim probe, then a separate post-claim, pre-effect
    // probe. Custody must not be able to make this pass without the third one.
    expect(interposition.occupancyCalls).toBe(3);
    expect(existsSync(join(moved, CANON))).toBe(false);
    expect(existsSync(join(replacement, CANON))).toBe(false);
    expect(readdirSync(replacement)).toEqual([]);
  });
});
