import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGovernanceDoctorDiagnosticRegistryV1,
  runGovernanceDoctorAuditV1,
} from "../../src/governance-doctor/audit-guide-v1.js";
import { createGovernanceDoctorOperationalContextV1 } from "../../src/governance-doctor/operational-v1.js";
import { createGovernanceDoctorProfileV1 } from "../../src/governance-doctor/profile-v1.js";
import {
  createGovernanceDoctorRepairClaimV1,
  governanceDoctorRepairClaimScopeSha256V1,
  markGovernanceDoctorRepairClaimSpentV1,
} from "../../src/governance-doctor/repair-claim-v1.js";
import {
  assertGovernanceDoctorRepairCompletionV1,
  canonicalGovernanceDoctorRepairCompletionV1Bytes,
  deriveGovernanceDoctorRepairCompletionV1,
} from "../../src/governance-doctor/repair-completion-v1.js";
import { createGovernanceDoctorRepairContentV1 } from "../../src/governance-doctor/repair-content-v1.js";
import { createGovernanceDoctorRepairCustodyV1 } from "../../src/governance-doctor/repair-custody-v1.js";
import { executeGovernanceDoctorRepairV1 } from "../../src/governance-doctor/repair-executor-v1.js";
import { observeGovernanceDoctorRepairPreconditionV1 } from "../../src/governance-doctor/repair-precondition-v1.js";
import { mintGovernanceDoctorRepairPreconditionScopeV1 } from "../../src/governance-doctor/repair-scope-v1.js";
import { verifyGovernanceDoctorRepairV1 } from "../../src/governance-doctor/repair-verifier-v1.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  REPAIR_FIXTURE_ATTEMPTED_AT,
  REPAIR_FIXTURE_CONTEXT_DIR,
  type RepairFixtureHome,
  repairFixtureConsent,
  repairFixtureExecutionContext,
  repairFixtureIsolatedHome,
  repairFixturePlan,
  repairFixtureVerificationContext,
} from "./repair-execution-fixture-v1.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { repairFixtureOsModuleV1 } = await import("./repair-account-home-v1.js");
  return repairFixtureOsModuleV1(actual);
});

const CANON = "ai-coding";
const DOCTOR = "aih.doctor.root";
const POLICY = "aih.policy.evaluate";
const policyRevision = createHash("sha256").update("effective policy revision").digest("hex");

let root: string;
let home: RepairFixtureHome;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(REPAIR_FIXTURE_ATTEMPTED_AT);
  home = repairFixtureIsolatedHome();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "aih-repair-completion-")));
});

afterEach(() => {
  vi.restoreAllMocks();
  home.release();
  rmSync(root, { recursive: true, force: true });
});

const prose = (overrides: Record<string, unknown> = {}) => ({
  attribution: "detector:aih/doctor",
  text: "The repository canon router is present and loadable.",
  ...overrides,
});

function auditProfile() {
  return createGovernanceDoctorProfileV1({
    conflicts: [
      {
        conflictId: "mcp-controls",
        conflictsWithSurfaceId: "surface:aih.mcp-controls",
        note: prose({ attribution: "catalog:aih/governance-doctor", text: "Shared MCP target." }),
      },
    ],
    diagnosticIds: [DOCTOR, POLICY],
    effectVersion: "1",
    guidance: prose({ attribution: "catalog:aih/governance-doctor", text: "Read the findings." }),
    nextActionId: "aih.status.root",
    prerequisites: [
      {
        note: prose({ attribution: "catalog:aih/governance-doctor", text: "Policy must exist." }),
        prerequisiteId: "effective-policy",
        satisfiedBy: "org-policy" as const,
      },
    ],
    profileVersion: "1",
    protocol: "GovernanceDoctorProfileV1" as const,
    repairPosture: "guided-only" as const,
    roles: [
      {
        owner: "aih" as const,
        roleId: "policy-owner",
        summary: prose({ attribution: "catalog:aih/governance-doctor", text: "AIH decides." }),
      },
    ],
    schemaVersion: "1",
    surfaceId: "surface:aih.governance-doctor",
    targetId: "target:aih.workstation",
  });
}

/** An audit over the two declared diagnostics, each given an outcome. */
function audit(doctor: unknown, policy: unknown, decision: "allowed" | "denied" = "allowed") {
  return runGovernanceDoctorAuditV1({
    policy: { decision, revisionSha256: policyRevision },
    profile: auditProfile(),
    registry: createGovernanceDoctorDiagnosticRegistryV1({
      diagnostics: [
        { diagnosticId: DOCTOR, outcome: doctor },
        { diagnosticId: POLICY, outcome: policy },
      ],
    }),
  });
}

const clean = () => ({ findings: [], kind: "findings" as const });
const finding = (code: string) => ({
  findings: [{ code, severity: "low" as const, summary: prose() }],
  kind: "findings" as const,
});
const refused = (state: string) => ({ kind: "refusal" as const, state });

/** Nothing non-pass survived: no finding and no unresolved diagnostic. */
const healthyAudit = () => audit(clean(), clean());

function scope() {
  const run = fakeRunner(() => undefined);
  return mintGovernanceDoctorRepairPreconditionScopeV1(
    createGovernanceDoctorOperationalContextV1({
      apply: false,
      contextDir: CANON,
      env: {},
      host: makeHostAdapter({ env: {}, platform: "linux", run }),
      json: true,
      options: {},
      root,
      run,
      verify: true,
    } as unknown as PlanContext),
  );
}

/**
 * One real attempt: the precondition observed before the effect, the effect
 * applied by the real executor, and the real verifier's verdict over the live
 * tree afterwards.
 */
async function attempt() {
  const precondition = observeGovernanceDoctorRepairPreconditionV1(scope());
  const plan = await repairFixturePlan({
    effects: [
      {
        arguments: { path: CANON },
        effectId: "ensure-canon",
        templateId: "ensure-canon-directory",
      },
    ],
    root,
    scopePaths: [CANON],
  });
  const content = createGovernanceDoctorRepairContentV1({ entries: [] });
  const custody = () =>
    createGovernanceDoctorRepairCustodyV1({ contextDir: REPAIR_FIXTURE_CONTEXT_DIR, plan, root });
  const receipt = executeGovernanceDoctorRepairV1({
    consent: repairFixtureConsent(plan),
    content,
    context: repairFixtureExecutionContext(plan),
    custody: custody(),
    plan,
  });
  const verification = verifyGovernanceDoctorRepairV1({
    content,
    context: repairFixtureVerificationContext(plan),
    custody: custody(),
    plan,
    receipt,
  });
  return {
    effectSha256: plan.effects[0]?.effectSha256 as string,
    precondition,
    receipt,
    verification,
  };
}

function spentClaim(
  receipt: { consentSha256: string; planSha256: string },
  realPath: string = root,
) {
  return markGovernanceDoctorRepairClaimSpentV1(
    createGovernanceDoctorRepairClaimV1({
      claimedAtEpochMs: REPAIR_FIXTURE_ATTEMPTED_AT,
      consentSha256: receipt.consentSha256,
      planSha256: receipt.planSha256,
      scopeSha256: governanceDoctorRepairClaimScopeSha256V1({ realPath }),
      state: "claimed",
    }),
  );
}

type Attempt = Awaited<ReturnType<typeof attempt>>;

/**
 * Derives one completion from one attempt. The attempt is a parameter because a
 * plan may be spent exactly once per checkout, so a test that needs two reports
 * derives both from the same real execution rather than running it twice.
 */
function completionFrom(made: Attempt, overrides: Record<string, unknown> = {}) {
  return deriveGovernanceDoctorRepairCompletionV1({
    claim: spentClaim(made.receipt),
    effectSha256: made.effectSha256,
    postAudit: healthyAudit(),
    precondition: made.precondition,
    receipt: made.receipt,
    rootRealPath: root,
    verification: made.verification,
    ...overrides,
  });
}

async function completion(overrides: Record<string, unknown> = {}) {
  return completionFrom(await attempt(), overrides);
}

describe("repair completion", () => {
  it("is complete only when the effect verified and the fresh audit is healthy", async () => {
    const report = await completion();
    expect(report.effectVerification).toBe("verified");
    expect(report.postAuditState).toBe("healthy");
    expect(report.repairState).toBe("complete");
    expect(report.residual).toEqual([]);
    expect(report.targetPath).toBe(CANON);
    expect(report.reportSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  /**
   * The distinction the whole record exists for. The directory was created and
   * independently verified; the workstation still has problems that have nothing
   * to do with it. Neither fact cancels the other, and neither is rounded away.
   */
  it("is partial when the effect verified and unrelated evidence remains", async () => {
    const report = await completion({
      postAudit: audit(finding("AIH_SOMETHING_ELSE_WRONG"), refused("evidence-gap")),
    });
    expect(report.effectVerification).toBe("verified");
    expect(report.postAuditState).toBe("partial");
    expect(report.repairState).toBe("partial");
    expect(report.repairState).not.toBe("complete");
    // Residual is codes and counts, and nothing else.
    expect(report.residual).toEqual([
      { code: "AIH_SOMETHING_ELSE_WRONG", count: 1 },
      { code: "evidence-gap", count: 1 },
    ]);
    expect(JSON.stringify(report)).not.toContain(root);
  });

  it("is failed when no valid post-execution audit was produced", async () => {
    const made = await attempt();
    for (const [label, postAudit] of [
      ["refused audit", audit(clean(), clean(), "denied")],
      ["unbranded look-alike", { findings: [], kind: "audited", refusals: [] }],
      ["malformed", { nonsense: true }],
      ["absent", null],
    ] as const) {
      const report = completionFrom(made, { postAudit });
      expect(report.postAuditState, label).toBe("unavailable");
      expect(report.postAuditSha256, label).toBeNull();
      expect(report.repairState, label).toBe("failed");
    }
  });

  it("is failed when a trusted join does not hold, even though the parts are real", async () => {
    const made = await attempt();
    const report = deriveGovernanceDoctorRepairCompletionV1({
      claim: spentClaim(made.receipt, `${root}-elsewhere`),
      effectSha256: made.effectSha256,
      postAudit: healthyAudit(),
      precondition: made.precondition,
      receipt: made.receipt,
      rootRealPath: root,
      verification: made.verification,
    });
    // The effect really did verify and the audit really is healthy. The claim
    // was spent for another checkout, so the attempt does not hold together.
    expect(report.effectVerification).toBe("verified");
    expect(report.postAuditState).toBe("healthy");
    expect(report.repairState).toBe("failed");
  });

  it("is failed when the named effect is not the one that verified", async () => {
    const report = await completion({ effectSha256: "a".repeat(64) });
    expect(report.effectVerification).toBe("unverified");
    expect(report.repairState).toBe("failed");
  });

  /**
   * Freshness is the caller's obligation; this module cannot tell one audit's
   * instant from another's. What it can do is make a reused pre-execution audit
   * useless: that audit is the one that reported the missing canon, so its
   * residual is non-empty and it can never read as healthy. Reuse degrades to
   * `partial`, and never manufactures `complete`.
   */
  it("cannot be talked into complete by reusing the audit that reported the problem", async () => {
    const report = await completion({
      postAudit: audit(finding("AIH_CANON_CONTEXT_DIR_MISSING"), clean()),
    });
    expect(report.postAuditState).toBe("partial");
    expect(report.repairState).toBe("partial");
    expect(report.residual).toEqual([{ code: "AIH_CANON_CONTEXT_DIR_MISSING", count: 1 }]);
  });

  it("refuses an input that is not what it claims to be, rather than recording a failure", async () => {
    const made = await attempt();
    const base = {
      claim: spentClaim(made.receipt),
      effectSha256: made.effectSha256,
      postAudit: healthyAudit(),
      precondition: made.precondition,
      receipt: made.receipt,
      rootRealPath: root,
      verification: made.verification,
    };
    for (const [label, override] of [
      ["unbranded receipt", { receipt: { ...made.receipt } }],
      ["unbranded verification", { verification: { ...made.verification } }],
      ["unbranded precondition", { precondition: { ...made.precondition } }],
      ["unspent claim", { claim: { ...spentClaim(made.receipt) } }],
      ["missing root", { rootRealPath: "" }],
      ["extra field", { unexpected: true }],
    ] as const)
      expect(
        () => deriveGovernanceDoctorRepairCompletionV1({ ...base, ...override }),
        label,
      ).toThrow(TypeError);
  });
});

describe("repair completion transport", () => {
  it("carries canonical bytes only for a record it minted", async () => {
    const report = await completion();
    expect(canonicalGovernanceDoctorRepairCompletionV1Bytes(report).length).toBeGreaterThan(0);
    expect(assertGovernanceDoctorRepairCompletionV1(report)).toBe(report);
    for (const [label, value] of [
      ["plain object", { ...report }],
      ["parse", JSON.parse(JSON.stringify(report))],
      ["proxy", new Proxy(report, {})],
      ["null", null],
    ] as const)
      expect(() => canonicalGovernanceDoctorRepairCompletionV1Bytes(value), label).toThrow(
        TypeError,
      );
  });

  /**
   * A record may not claim more than its own parts allow, however it was
   * produced. These are refused on their contents before the brand is consulted,
   * so the rule holds for a transported record too.
   */
  it("refuses every state that contradicts its own contents", async () => {
    const made = await attempt();
    const report = completionFrom(made);
    const partial = completionFrom(made, { postAudit: audit(finding("AIH_OTHER"), clean()) });
    for (const [label, value] of [
      ["complete on an unverified effect", { ...report, effectVerification: "unverified" }],
      ["complete on a partial audit", { ...partial, repairState: "complete" }],
      ["partial on a healthy audit", { ...report, repairState: "partial" }],
      ["healthy with residual", { ...report, residual: [{ code: "AIH_X", count: 1 }] }],
      ["partial with no residual", { ...partial, residual: [] }],
      ["unavailable carrying an audit identity", { ...report, postAuditState: "unavailable" }],
    ] as const)
      expect(() => assertGovernanceDoctorRepairCompletionV1(value), label).toThrow(TypeError);
  });

  it("refuses hostile shapes and out-of-bound residual entries", async () => {
    const report = await completion();
    for (const [label, value] of [
      ["array", []],
      ["accessor", Object.defineProperty({ ...report }, "repairState", { get: () => "complete" })],
      ["residual count of zero", { ...report, residual: [{ code: "AIH_X", count: 0 }] }],
      [
        "residual duplicate",
        {
          ...report,
          residual: [
            { code: "A", count: 1 },
            { code: "A", count: 1 },
          ],
        },
      ],
      ["residual extra key", { ...report, residual: [{ code: "A", count: 1, detail: "no" }] }],
      ["wrong protocol", { ...report, protocol: "GovernanceDoctorRepairCompletionV2" }],
    ] as const)
      expect(() => assertGovernanceDoctorRepairCompletionV1(value), label).toThrow(TypeError);
  });
});
