import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertGovernanceDoctorAuditCompletenessV1,
  deriveGovernanceDoctorAuditCompletenessV1,
} from "../../src/governance-doctor/audit-completeness-v1.js";
import {
  createGovernanceDoctorDiagnosticRegistryV1,
  runGovernanceDoctorAuditV1,
} from "../../src/governance-doctor/audit-guide-v1.js";
import { GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS } from "../../src/governance-doctor/capability-v1.js";
import { createGovernanceDoctorProfileV1 } from "../../src/governance-doctor/profile-v1.js";

const policyRevision = createHash("sha256").update("effective policy revision").digest("hex");
const DOCTOR = "aih.doctor.root";
const POLICY = "aih.policy.evaluate";

function prose(overrides: Record<string, unknown> = {}) {
  return {
    attribution: "detector:aih/doctor",
    text: "The repository canon router is present and loadable.",
    ...overrides,
  };
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    code: "CANON_ROUTER_PRESENT",
    severity: "info" as const,
    summary: prose(),
    ...overrides,
  };
}

function profile(overrides: Record<string, unknown> = {}) {
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
    guidance: prose({
      attribution: "catalog:aih/governance-doctor",
      text: "Read the coded findings before deciding anything.",
    }),
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
    ...overrides,
  });
}

const findings = (items: readonly unknown[] = [finding()]) =>
  ({ findings: items, kind: "findings" as const }) as unknown;
const refusal = (state: string) => ({ kind: "refusal" as const, state }) as unknown;

/** One audit over the two declared diagnostics, each given an outcome. */
function audit(doctor: unknown, policy: unknown) {
  return runGovernanceDoctorAuditV1({
    policy: { decision: "allowed" as const, revisionSha256: policyRevision },
    profile: profile(),
    registry: createGovernanceDoctorDiagnosticRegistryV1({
      diagnostics: [
        { diagnosticId: DOCTOR, outcome: doctor },
        { diagnosticId: POLICY, outcome: policy },
      ],
    }),
  });
}

describe("audit completeness", () => {
  it("is completed only when every declared diagnostic resolved", () => {
    const resolved = deriveGovernanceDoctorAuditCompletenessV1(audit(findings(), findings()));
    expect(resolved.state).toBe("completed");
    expect(resolved.unresolved).toEqual([]);
    expect(resolved.findingCount).toBe(2);

    // Resolving everything and finding nothing wrong is still completed: the
    // question was answered.
    const quiet = deriveGovernanceDoctorAuditCompletenessV1(audit(findings([]), findings([])));
    expect(quiet.state).toBe("completed");
    expect(quiet.findingCount).toBe(0);
  });

  /**
   * The state this slice exists for. A run that found real problems *and* could
   * not see part of the workstation is neither a completed audit nor an absence
   * of evidence, and reporting it as either loses something a reader needs.
   */
  it("is partial when findings and unresolved diagnostics coexist", () => {
    const partial = deriveGovernanceDoctorAuditCompletenessV1(
      audit(findings(), refusal("evidence-gap")),
    );
    expect(partial.state).toBe("partial");
    expect(partial.state).not.toBe("completed");
    expect(partial.findingCount).toBe(1);
    // The gap is explicit, and says which diagnostic and why.
    expect(partial.unresolved).toEqual([{ diagnosticId: POLICY, state: "evidence-gap" }]);
  });

  it("keeps the existing evidence-gap state when nothing resolved", () => {
    const gap = deriveGovernanceDoctorAuditCompletenessV1(
      audit(refusal("evidence-gap"), refusal("missing-credential")),
    );
    expect(gap.state).toBe("evidence-gap");
    expect(gap.findingCount).toBe(0);
    expect(gap.unresolved).toEqual([
      { diagnosticId: DOCTOR, state: "evidence-gap" },
      { diagnosticId: POLICY, state: "missing-credential" },
    ]);
  });

  /**
   * Every state a diagnostic can fail in leaves the audit unresolved for that
   * diagnostic. Only `evidence-gap` shares the name of the all-unresolved
   * outcome; none of them is a resolution.
   */
  it("treats every per-diagnostic refusal state as unresolved", () => {
    for (const state of [
      "evidence-gap",
      "missing-credential",
      "unmanaged-drift",
      "unsupported-host",
    ]) {
      const mixed = deriveGovernanceDoctorAuditCompletenessV1(audit(findings(), refusal(state)));
      expect(mixed.state, state).toBe("partial");
      expect(mixed.unresolved, state).toEqual([{ diagnosticId: POLICY, state }]);
    }
  });

  it("counts a declared diagnostic with no adapter as unresolved", () => {
    const result = runGovernanceDoctorAuditV1({
      policy: { decision: "allowed" as const, revisionSha256: policyRevision },
      profile: profile(),
      // POLICY is declared by the profile but supplied by no adapter.
      registry: createGovernanceDoctorDiagnosticRegistryV1({
        diagnostics: [{ diagnosticId: DOCTOR, outcome: findings() }],
      }),
    });
    const derived = deriveGovernanceDoctorAuditCompletenessV1(result);
    expect(derived.state).toBe("partial");
    expect(derived.unresolved).toEqual([{ diagnosticId: POLICY, state: "missing-adapter" }]);
  });

  it("binds the classification to the audit it read", () => {
    const one = audit(findings(), refusal("evidence-gap"));
    const derived = deriveGovernanceDoctorAuditCompletenessV1(one);
    if (one.kind !== "audited") throw new Error("expected an audited result");
    expect(derived.auditSha256).toBe(one.auditSha256);
    const other = audit(findings(), findings());
    if (other.kind !== "audited") throw new Error("expected an audited result");
    expect(deriveGovernanceDoctorAuditCompletenessV1(other).auditSha256).not.toBe(
      derived.auditSha256,
    );
  });

  it("refuses an audit-level refusal, which has no completeness to report", () => {
    const denied = runGovernanceDoctorAuditV1({
      policy: { decision: "denied" as const, revisionSha256: policyRevision },
      profile: profile(),
      // Denial short-circuits before any diagnostic is consulted; the registry
      // is well formed precisely so the refusal is the only reason it stops.
      registry: createGovernanceDoctorDiagnosticRegistryV1({
        diagnostics: [
          { diagnosticId: DOCTOR, outcome: findings() },
          { diagnosticId: POLICY, outcome: findings() },
        ],
      }),
    });
    expect(denied.kind).toBe("refused");
    expect(() => deriveGovernanceDoctorAuditCompletenessV1(denied)).toThrow(
      /audit completeness requires an audited result/,
    );
  });

  it("refuses every substitute for a branded audit", () => {
    const real = audit(findings(), refusal("evidence-gap"));
    for (const [label, value] of [
      ["plain object", { ...real }],
      ["proxy", new Proxy(real, {})],
      ["parse", JSON.parse(JSON.stringify(real))],
      ["prototype child", Object.create(real) as unknown],
      ["null", null],
      ["undefined", undefined],
      ["string", "audited"],
    ] as const)
      expect(() => deriveGovernanceDoctorAuditCompletenessV1(value), label).toThrow(
        /governance doctor audit requires a validated brand/,
      );
  });
});

describe("audit completeness transport", () => {
  const derived = () =>
    deriveGovernanceDoctorAuditCompletenessV1(audit(findings(), refusal("evidence-gap")));

  it("accepts the record it derived", () => {
    const record = derived();
    expect(assertGovernanceDoctorAuditCompletenessV1(record)).toBe(record);
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("refuses unknown, missing, and renamed fields", () => {
    const base = { ...derived() } as Record<string, unknown>;
    const without = (key: string) => {
      const copy = { ...base };
      delete copy[key];
      return copy;
    };
    for (const [label, value] of [
      ["extra field", { ...base, executable: false }],
      ["missing state", without("state")],
      ["missing unresolved", without("unresolved")],
      ["renamed field", { ...without("state"), status: "completed" }],
    ] as const)
      expect(() => assertGovernanceDoctorAuditCompletenessV1(value), label).toThrow(
        /must declare exactly its schema fields/,
      );
  });

  it("refuses an incompatible protocol", () => {
    expect(() =>
      assertGovernanceDoctorAuditCompletenessV1({
        ...derived(),
        protocol: "GovernanceDoctorAuditCompletenessV2",
      }),
    ).toThrow(/audit completeness protocol/);
  });

  it("refuses duplicate diagnostic identities", () => {
    expect(() =>
      assertGovernanceDoctorAuditCompletenessV1({
        ...derived(),
        unresolved: [
          { diagnosticId: POLICY, state: "evidence-gap" },
          { diagnosticId: POLICY, state: "missing-credential" },
        ],
      }),
    ).toThrow(/audit completeness unresolved/);
  });

  it("refuses an unbounded unresolved collection", () => {
    const overflow = Array.from(
      { length: GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS.length + 1 },
      () => ({ diagnosticId: DOCTOR, state: "evidence-gap" }),
    );
    expect(() =>
      assertGovernanceDoctorAuditCompletenessV1({ ...derived(), unresolved: overflow }),
    ).toThrow(/outside its bounded cardinality/);
  });

  it("refuses hostile shapes", () => {
    const record = derived();
    const accessor: Record<string, unknown> = { ...record };
    Object.defineProperty(accessor, "state", { enumerable: true, get: () => "completed" });
    for (const [label, value] of [
      ["accessor", accessor],
      ["proxy", new Proxy(record, {})],
      ["array", []],
      ["sparse collection", { ...record, unresolved: Object.assign([], { 3: { state: "x" } }) }],
      ["null", null],
      ["number", 7],
    ] as const)
      expect(() => assertGovernanceDoctorAuditCompletenessV1(value), label).toThrow(TypeError);
  });

  /**
   * The invariant the whole slice rests on: a record cannot exist that says
   * "completed" while carrying an unresolved diagnostic, so no surface can read
   * a partial run as a healthy one -- not by construction, and not by transport.
   */
  it("refuses every state that contradicts its own contents", () => {
    const record = derived();
    const gap = { diagnosticId: POLICY, state: "evidence-gap" };
    // The message matters: every value here is also unbranded, so asserting
    // only `TypeError` would pass on the brand check with the cross-check
    // deleted. Removing that check locally does turn this red.
    for (const [label, value] of [
      ["completed while carrying a gap", { ...record, state: "completed" }],
      ["partial with nothing unresolved", { ...record, state: "partial", unresolved: [] }],
      [
        "evidence-gap with findings",
        { ...record, findingCount: 2, state: "evidence-gap", unresolved: [gap] },
      ],
      ["partial with no findings", { ...record, findingCount: 0, state: "partial" }],
    ] as const)
      expect(() => assertGovernanceDoctorAuditCompletenessV1(value), label).toThrow(
        /audit completeness state contradicts its own contents/,
      );
  });

  it("refuses a look-alike that is otherwise perfectly shaped", () => {
    // Reaching the brand check means every closed-schema rule above passed, so
    // this is the last line and it has to hold on its own.
    expect(() => assertGovernanceDoctorAuditCompletenessV1({ ...derived() })).toThrow(
      /audit completeness is not AIH-owned/,
    );
  });
});
