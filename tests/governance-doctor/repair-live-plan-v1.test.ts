import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { command as doctorCommand } from "../../src/doctor.js";
import {
  createGovernanceDoctorOperationalContextV1,
  runGovernanceDoctorOperationV1,
} from "../../src/governance-doctor/operational-v1.js";
import { createGovernanceDoctorProfileV1 } from "../../src/governance-doctor/profile-v1.js";
import { deriveGovernanceDoctorRepairCanonicalPlanV1 } from "../../src/governance-doctor/repair-canon-plan-v1.js";
import {
  GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
  mintGovernanceDoctorRepairEligibilityV1,
} from "../../src/governance-doctor/repair-eligibility-v1.js";
import { deriveGovernanceDoctorRepairLiveCanonicalPlanV1 } from "../../src/governance-doctor/repair-live-canon-plan-v1.js";
import { observeGovernanceDoctorRepairPreconditionV1 } from "../../src/governance-doctor/repair-precondition-v1.js";
import { mintGovernanceDoctorRepairPreconditionScopeV1 } from "../../src/governance-doctor/repair-scope-v1.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { policyEvaluateCommand } from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const DOCTOR = "aih.doctor.root";
const POLICY = "aih.policy.evaluate";
const policyRevisionSha256 = "b".repeat(64);
const HEALTHY = { name: "diagnostic", verdict: "pass" as const };
const CONTEXT_DIR_MISSING = {
  code: "canon.context-dir-missing",
  name: "context-dir",
  verdict: "skip" as const,
};
const UNMAPPED = { code: "other", name: "other-check", verdict: "skip" as const };

function prose(text = "Read the bounded result.") {
  return { attribution: "aih:governance-doctor", text };
}

function profile() {
  return createGovernanceDoctorProfileV1({
    conflicts: [
      { conflictId: "other-surface", conflictsWithSurfaceId: "surface:aih.other", note: prose() },
    ],
    diagnosticIds: [DOCTOR, POLICY],
    effectVersion: "1",
    guidance: prose(),
    nextActionId: DOCTOR,
    prerequisites: [{ note: prose(), prerequisiteId: "policy", satisfiedBy: "org-policy" }],
    profileVersion: "1",
    protocol: "GovernanceDoctorProfileV1",
    repairPosture: "guided-only",
    roles: [{ owner: "aih", roleId: "owner", summary: prose() }],
    schemaVersion: "1",
    surfaceId: "surface:aih.governance-doctor",
    targetId: "target:aih.governance-doctor",
  });
}

function context(root: string): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    apply: false,
    contextDir: GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
    env: {},
    host: makeHostAdapter({ env: {}, platform: "linux", run }),
    json: true,
    options: {},
    root,
    run,
    verify: true,
  };
}

function stubbedPlan(capability: string, checks: readonly unknown[]) {
  return {
    actions: checks.map((check) => ({
      describe: `${capability} diagnostic`,
      kind: "probe" as const,
      run: async () => check as never,
    })),
    capability,
  };
}

async function operation(root: string) {
  const doctorPlan = vi
    .spyOn(doctorCommand, "plan")
    .mockReturnValue(stubbedPlan("doctor", [CONTEXT_DIR_MISSING, UNMAPPED]));
  const policyPlan = vi
    .spyOn(policyEvaluateCommand, "plan")
    .mockReturnValue(stubbedPlan("policy evaluate", [HEALTHY]));
  const builtProfile = profile();
  const operational = createGovernanceDoctorOperationalContextV1(context(root));
  try {
    return {
      built: await runGovernanceDoctorOperationV1({
        context: operational,
        policy: { decision: "allowed", revisionSha256: policyRevisionSha256 },
        profile: builtProfile,
      }),
      operational,
      profile: builtProfile,
    };
  } finally {
    doctorPlan.mockRestore();
    policyPlan.mockRestore();
  }
}

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("live Governance Doctor repair canonical plan V1", () => {
  it("uses branded live precondition evidence without widening the shared audit preview mapping", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aih-live-repair-plan-")));
    roots.push(root);
    const { built, operational, profile: builtProfile } = await operation(root);
    const scope = mintGovernanceDoctorRepairPreconditionScopeV1(operational);
    const precondition = observeGovernanceDoctorRepairPreconditionV1(scope);
    const eligibility = mintGovernanceDoctorRepairEligibilityV1(
      GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
      GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
      built.record.rootSha256,
    );

    // The all-or-nothing operational mapping remains unchanged: the extra
    // unresolved Doctor check keeps the shared preview from constructing a plan.
    expect(
      deriveGovernanceDoctorRepairCanonicalPlanV1({
        eligibility,
        operation: built,
        profile: builtProfile,
      }).kind,
    ).toBe("no-mechanical-repair");

    const live = deriveGovernanceDoctorRepairLiveCanonicalPlanV1({
      eligibility,
      operation: built,
      precondition,
      profile: builtProfile,
      scope,
    });

    expect(precondition.eligible).toBe(true);
    expect(precondition.targetOccupancy).toBe("unoccupied");
    expect(live.kind).toBe("plan");
    if (live.kind !== "plan") throw new Error("expected a live repair plan");
    expect(live.auditCompleteness).toBe("partial");
    expect(live.plan.effects).toEqual([
      expect.objectContaining({
        arguments: { path: GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1 },
        effectId: "ensure-canonical-context-dir",
        effectKind: "create-managed-directory",
      }),
    ]);
  });

  it("fails closed when the branded scope/precondition root is not the audited root", async () => {
    const auditedRoot = realpathSync.native(
      mkdtempSync(join(tmpdir(), "aih-live-repair-audited-")),
    );
    const observedRoot = realpathSync.native(
      mkdtempSync(join(tmpdir(), "aih-live-repair-observed-")),
    );
    roots.push(auditedRoot, observedRoot);
    const { built, operational, profile: builtProfile } = await operation(auditedRoot);
    const observedOperational = createGovernanceDoctorOperationalContextV1(context(observedRoot));
    const scope = mintGovernanceDoctorRepairPreconditionScopeV1(operational);
    const precondition = observeGovernanceDoctorRepairPreconditionV1(
      mintGovernanceDoctorRepairPreconditionScopeV1(observedOperational),
    );
    const eligibility = mintGovernanceDoctorRepairEligibilityV1(
      GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
      GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
      built.record.rootSha256,
    );

    expect(
      deriveGovernanceDoctorRepairLiveCanonicalPlanV1({
        eligibility,
        operation: built,
        precondition,
        profile: builtProfile,
        scope,
      }).kind,
    ).toBe("unavailable");
  });

  it("refuses forged preconditions and extra live-intake keys", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aih-live-repair-forged-")));
    roots.push(root);
    const { built, operational, profile: builtProfile } = await operation(root);
    const scope = mintGovernanceDoctorRepairPreconditionScopeV1(operational);
    const precondition = observeGovernanceDoctorRepairPreconditionV1(scope);
    const eligibility = mintGovernanceDoctorRepairEligibilityV1(
      GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
      GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
      built.record.rootSha256,
    );
    const request = { eligibility, operation: built, precondition, profile: builtProfile, scope };

    for (const hostile of [
      { ...request, precondition: { ...precondition } },
      { ...request, extra: true },
    ])
      expect(deriveGovernanceDoctorRepairLiveCanonicalPlanV1(hostile).kind).toBe("unavailable");
  });

  it("labels an indeterminate live target distinctly from no mechanical repair", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aih-live-repair-indeterminate-")));
    roots.push(root);
    const { built, operational, profile: builtProfile } = await operation(root);
    const scope = mintGovernanceDoctorRepairPreconditionScopeV1(operational);
    const eligibility = mintGovernanceDoctorRepairEligibilityV1(
      GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
      GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
      built.record.rootSha256,
    );
    rmSync(root, { force: true, recursive: true });
    const precondition = observeGovernanceDoctorRepairPreconditionV1(scope);

    expect(precondition.targetOccupancy).toBe("indeterminate");
    expect(
      deriveGovernanceDoctorRepairLiveCanonicalPlanV1({
        eligibility,
        operation: built,
        precondition,
        profile: builtProfile,
        scope,
      }).kind,
    ).toBe("target-occupancy-indeterminate");
  });
});
