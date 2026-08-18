import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { command as doctorCommand } from "../../src/doctor.js";
import {
  createGovernanceDoctorOperationalContextV1,
  type GovernanceDoctorOperationV1,
  runGovernanceDoctorOperationV1,
} from "../../src/governance-doctor/operational-v1.js";
import { createGovernanceDoctorProfileV1 } from "../../src/governance-doctor/profile-v1.js";
import { createGovernanceDoctorRepairBrokerRegistryV1 } from "../../src/governance-doctor/repair-broker-v1.js";
import {
  createGovernanceDoctorRepairConsentContextV1,
  createGovernanceDoctorRepairConsentV1,
  type GovernanceDoctorRepairConsentV1,
} from "../../src/governance-doctor/repair-consent-v1.js";
import {
  createGovernanceDoctorRepairExecutionContextV1,
  createGovernanceDoctorRepairVerificationContextV1,
} from "../../src/governance-doctor/repair-outcome-v1.js";
import {
  createGovernanceDoctorRepairPlanV1,
  type GovernanceDoctorRepairPlanV1,
  governanceDoctorRepairEffectSummaryV1,
} from "../../src/governance-doctor/repair-plan-v1.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { policyEvaluateCommand } from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { setRepairFixtureAccountHomeV1 } from "./repair-account-home-v1.js";

/**
 * Shared Repair fixture for the executor and verifier suites. It builds exactly
 * the branded Plan, Consent, and context records the V1 foundation already
 * defines, bound to a caller-supplied temporary fixture root. Both code-owned
 * diagnostic planners are stubbed, so no fixture ever inspects this checkout.
 */
export const REPAIR_FIXTURE_CONTEXT_DIR = "ai-coding";
export const REPAIR_FIXTURE_TARGET = "target:aih.governance-doctor";
export const REPAIR_FIXTURE_EXECUTOR = "aih:governance-doctor.mechanical-executor";
export const REPAIR_FIXTURE_VERIFIER = "aih:governance-doctor.mechanical-verifier";
export const REPAIR_FIXTURE_TRUST_ANCHOR = createHash("sha256")
  .update("trust anchor")
  .digest("hex");

export const REPAIR_FIXTURE_CREATED_AT = 1_777_000_000_000;
export const REPAIR_FIXTURE_EXPIRES_AT = REPAIR_FIXTURE_CREATED_AT + 3_600_000;
export const REPAIR_FIXTURE_CONSENTED_AT = REPAIR_FIXTURE_CREATED_AT + 60_000;
export const REPAIR_FIXTURE_ATTEMPTED_AT = REPAIR_FIXTURE_CONSENTED_AT + 60_000;
export const REPAIR_FIXTURE_VERIFIED_AT = REPAIR_FIXTURE_ATTEMPTED_AT + 60_000;

const DOCTOR = "aih.doctor.root";
const POLICY = "aih.policy.evaluate";
export const REPAIR_FIXTURE_PROBE_CODE = "AIH_READ_ONLY_PROBES_COMPLETED";

const POLICY_REVISION = createHash("sha256").update("policy revision").digest("hex");

/**
 * A throwaway account home for the durable claim store.
 *
 * The store resolves its own home from the OS account, and there is no caller
 * input and no test setter for that location -- which is exactly the property
 * that keeps replay state from being something a caller can choose. The
 * environment is emphatically *not* a legitimate seam for it: `HOME` and
 * `USERPROFILE` are settable by anyone who can start the process, so redirecting
 * them is caller control of the store root, and the store is required to ignore
 * them. The only seam a suite may use is therefore the platform module itself.
 *
 * Every suite that executes a Repair must install the `node:os` interposition
 * from `repair-account-home-v1.ts` and must hold one of these for the whole test.
 * A suite that installs neither would write durable claims into the operator's
 * real account home, so the pairing is checked here rather than assumed.
 */
export interface RepairFixtureHome {
  readonly path: string;
  readonly release: () => void;
}

export function repairFixtureIsolatedHome(): RepairFixtureHome {
  const path = mkdtempSync(join(realpathSync.native(tmpdir()), "aih-repair-home-"));
  setRepairFixtureAccountHomeV1(path);
  if (userInfo().homedir !== path) {
    setRepairFixtureAccountHomeV1(null);
    rmSync(path, { force: true, recursive: true });
    throw new Error("repair fixture requires the node:os account-home interposition");
  }
  return {
    path,
    release: () => {
      setRepairFixtureAccountHomeV1(null);
      rmSync(path, { force: true, recursive: true });
    },
  };
}

/** The one location the claim store is allowed to own under a given home. */
export function repairFixtureClaimStoreDirectory(home: string): string {
  return join(home, ".aih", "governance-doctor", "repair-claims-v1");
}

export function repairFixtureSha256(bytes: Buffer | string): string {
  return createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes)
    .digest("hex");
}

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
    targetId: REPAIR_FIXTURE_TARGET,
  });
}

function planContext(root: string): PlanContext {
  const run = vi.fn(async () => ({ code: 0, spawnError: false, stderr: "", stdout: "" }));
  return {
    apply: false,
    contextDir: REPAIR_FIXTURE_CONTEXT_DIR,
    env: {},
    host: makeHostAdapter({ env: {}, platform: "linux", run }),
    json: false,
    options: {},
    root,
    run,
    verify: true,
  };
}

async function operation(root: string): Promise<GovernanceDoctorOperationV1> {
  const probe = {
    actions: [
      {
        describe: "diagnostic",
        kind: "probe" as const,
        run: async () => ({ name: "diagnostic", verdict: "pass" as const }),
      },
    ],
  };
  const doctorPlan = vi
    .spyOn(doctorCommand, "plan")
    .mockReturnValue({ ...probe, capability: "doctor" });
  const policyPlan = vi
    .spyOn(policyEvaluateCommand, "plan")
    .mockReturnValue({ ...probe, capability: "policy evaluate" });
  try {
    return await runGovernanceDoctorOperationV1({
      context: createGovernanceDoctorOperationalContextV1(planContext(root)),
      policy: { decision: "allowed", revisionSha256: POLICY_REVISION },
      profile: profile(),
    });
  } finally {
    doctorPlan.mockRestore();
    policyPlan.mockRestore();
  }
}

/** One recipe registering exactly one template per frozen V1 effect kind. */
export function repairFixtureRegistry() {
  return createGovernanceDoctorRepairBrokerRegistryV1({
    brokerId: "aih:governance-doctor.mechanical",
    owner: "aih",
    recipes: [
      {
        effectVersion: "1",
        effects: [
          {
            argumentSchema: [{ name: "path", type: "managed-relative-path" }],
            effectKind: "create-managed-directory",
            templateId: "ensure-canon-directory",
          },
          {
            argumentSchema: [{ name: "path", type: "managed-relative-path" }],
            effectKind: "normalize-managed-line-endings",
            templateId: "normalize-canon-endings",
          },
          {
            argumentSchema: [
              { name: "contentSha256", type: "sha256" },
              { name: "path", type: "managed-relative-path" },
            ],
            effectKind: "restore-managed-file-content",
            templateId: "restore-canon-file",
          },
          {
            argumentSchema: [
              { name: "blockId", type: "managed-token" },
              { name: "contentSha256", type: "sha256" },
              { name: "path", type: "managed-relative-path" },
            ],
            effectKind: "rewrite-managed-marker-block",
            templateId: "rewrite-canon-block",
          },
        ],
        recipeId: "restore-repository-canon",
        schemaVersion: "1",
      },
    ],
  });
}

export interface RepairFixtureEffect {
  readonly arguments: Record<string, string>;
  readonly effectId: string;
  readonly templateId: string;
}

export interface RepairFixturePlanRequest {
  readonly effects: readonly RepairFixtureEffect[];
  readonly planNonce?: string;
  readonly root: string;
  readonly scopePaths: readonly string[];
}

export async function repairFixturePlan(
  request: RepairFixturePlanRequest,
): Promise<GovernanceDoctorRepairPlanV1> {
  return createGovernanceDoctorRepairPlanV1({
    createdAtEpochMs: REPAIR_FIXTURE_CREATED_AT,
    effects: request.effects.map((effect) => ({
      arguments: { ...effect.arguments },
      effectId: effect.effectId,
      templateId: effect.templateId,
    })),
    evidence: {
      findings: [{ code: REPAIR_FIXTURE_PROBE_CODE, diagnosticId: DOCTOR }],
      refusals: [],
    },
    expiresAtEpochMs: REPAIR_FIXTURE_EXPIRES_AT,
    operation: await operation(request.root),
    planNonce: request.planNonce ?? "7f".repeat(32),
    profile: profile(),
    recipeId: "restore-repository-canon",
    registry: repairFixtureRegistry(),
    scope: { paths: [...request.scopePaths] },
  });
}

export function repairFixtureConsent(
  plan: GovernanceDoctorRepairPlanV1,
  overrides: Record<string, unknown> = {},
): GovernanceDoctorRepairConsentV1 {
  return createGovernanceDoctorRepairConsentV1({
    consentNonce: "3c".repeat(32),
    consentedAtEpochMs: REPAIR_FIXTURE_CONSENTED_AT,
    context: createGovernanceDoctorRepairConsentContextV1({
      channel: "out-of-band",
      signerId: "operator:jane.doe",
      subjectId: REPAIR_FIXTURE_TARGET,
      trustAnchorSha256: REPAIR_FIXTURE_TRUST_ANCHOR,
    }),
    decision: "granted",
    plan,
    summary: governanceDoctorRepairEffectSummaryV1(plan),
    ...overrides,
  });
}

export function repairFixtureExecutionContext(plan: GovernanceDoctorRepairPlanV1) {
  return createGovernanceDoctorRepairExecutionContextV1({
    brokerId: plan.brokerId,
    executorId: REPAIR_FIXTURE_EXECUTOR,
    owner: "aih",
    recipeSha256: plan.recipeSha256,
    registrySha256: plan.registrySha256,
    rootSha256: plan.rootSha256,
  });
}

export function repairFixtureVerificationContext(plan: GovernanceDoctorRepairPlanV1) {
  return createGovernanceDoctorRepairVerificationContextV1({
    brokerId: plan.brokerId,
    recipeSha256: plan.recipeSha256,
    registrySha256: plan.registrySha256,
    rootSha256: plan.rootSha256,
    trustAnchorSha256: REPAIR_FIXTURE_TRUST_ANCHOR,
    verifierId: REPAIR_FIXTURE_VERIFIER,
  });
}
