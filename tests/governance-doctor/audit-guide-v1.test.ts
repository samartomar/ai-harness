import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITY_PACKAGE_COMMAND_SPECS } from "../../src/capability/package-manager/commands.js";
import {
  ALL_COMMAND_SPEC_PATHS,
  GROUPED_COMMAND_SPECS,
  READONLY,
} from "../../src/commands/index.js";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import {
  canonicalGovernanceDoctorAuditV1Bytes,
  canonicalGovernanceDoctorGuideV1Bytes,
  createGovernanceDoctorDiagnosticRegistryV1,
  parseGovernanceDoctorAuditV1Json,
  parseGovernanceDoctorGuideV1Json,
  renderGovernanceDoctorGuideV1,
  runGovernanceDoctorAuditV1,
} from "../../src/governance-doctor/audit-guide-v1.js";
import {
  GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS,
  GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES,
  GOVERNANCE_DOCTOR_V1_LIMITS,
  governanceDoctorSha256V1,
} from "../../src/governance-doctor/capability-v1.js";
import {
  canonicalGovernanceDoctorProfileV1Bytes,
  createGovernanceDoctorProfileV1,
} from "../../src/governance-doctor/profile-v1.js";

const root = resolve(__dirname, "..", "..");
const auditSource = readFileSync(resolve(root, "src/governance-doctor/audit-guide-v1.ts"), "utf8");

const policyRevision = createHash("sha256").update("effective policy revision").digest("hex");
const DOCTOR = "aih.doctor.root";
const POLICY = "aih.policy.evaluate";
// biome-ignore lint/suspicious/noExplicitAny: closed transport mutation matrices need mutable nested JSON.
type MutableJson = Record<string, any>;
type MutableJsonMutation = (body: MutableJson) => void;

/**
 * Unicode fixtures are built from code points rather than written as literals, so
 * this source stays pure ASCII. An invisible literal is unreviewable, and it would
 * itself be hidden Unicode in a file whose subject is rejecting hidden Unicode.
 */
const cp = (...points: readonly number[]): string => String.fromCodePoint(...points);

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

function seam(diagnosticId: string, outcome: unknown) {
  return { diagnosticId, outcome };
}

function registry(diagnostics: readonly unknown[]) {
  return createGovernanceDoctorDiagnosticRegistryV1({ diagnostics });
}

function findingsOutcome(findings: readonly unknown[] = [finding()]) {
  return { findings, kind: "findings" as const };
}

function refusalOutcome(state: string) {
  return { kind: "refusal" as const, state };
}

function auditInput(overrides: Record<string, unknown> = {}) {
  return {
    policy: { decision: "allowed" as const, revisionSha256: policyRevision },
    profile: profile(),
    registry: registry([
      seam(DOCTOR, findingsOutcome()),
      seam(POLICY, findingsOutcome([finding({ code: "POLICY_EFFECTIVE", severity: "info" })])),
    ]),
    ...overrides,
  };
}

function audited(overrides: Record<string, unknown> = {}) {
  const result = runGovernanceDoctorAuditV1(auditInput(overrides));
  if (result.kind !== "audited") throw new Error(`expected an audited result, got ${result.kind}`);
  return result;
}

function canonicalAuditTransport(body: Record<string, unknown>): Buffer {
  return canonicalStrictJsonBytesV1({
    ...body,
    auditSha256: governanceDoctorSha256V1("aih.governance-doctor-audit-v1", body),
  });
}

function canonicalGuideTransport(body: Record<string, unknown>): Buffer {
  return canonicalStrictJsonBytesV1({
    ...body,
    guideSha256: governanceDoctorSha256V1("aih.governance-doctor-guide-v1", body),
  });
}

describe("GovernanceDoctorAuditV1 capability boundary (static)", () => {
  it("holds no filesystem, process, network, or command-synthesis capability", () => {
    expect(auditSource).not.toMatch(
      /node:(?:fs|child_process|net|http|https|dgram|worker_threads|vm|readline)/,
    );
    expect(auditSource).not.toMatch(/\b(?:fetch|execSync|execFileSync|spawnSync|require)\s*\(/);
    expect(auditSource).not.toMatch(/\bprocess\.(?:env|argv|cwd)\b/);
    expect(auditSource).not.toMatch(/\bnew Function\b|\beval\s*\(/);
  });

  it("names no repair, mutation, consent, or submission contract", () => {
    for (const token of [
      "RemediationActionV1",
      "RepairPlanV1",
      "RepairReceiptV1",
      "--force",
      "--yes",
      "--delete",
      "broker",
    ])
      expect(auditSource, token).not.toContain(token);
  });

  it("orders exclusively by raw UTF-16 code units", () => {
    expect(auditSource).not.toMatch(/localeCompare|\bIntl\b|Collator/);
    expect(auditSource).not.toMatch(/\.sort\(\s*\)/);
  });

  it("does not retain an arbitrary caller callback behind a read-only label", () => {
    let invoked = false;
    const smuggled = () => {
      invoked = true;
      return findingsOutcome();
    };
    expect(() => registry([{ diagnosticId: DOCTOR, outcome: smuggled }])).toThrow(TypeError);
    expect(invoked).toBe(false);
    expect(auditSource).not.toMatch(/\brun\s*:\s*\(/);
  });

  it("pins each accepted diagnostic name to independently recorded read-only command ownership", () => {
    const expected = [
      ["aih.capability.package.doctor", ["capability", "package", "doctor"]],
      ["aih.doctor.root", ["doctor"]],
      ["aih.pack.status", ["pack", "status"]],
      ["aih.policy.evaluate", ["policy", "evaluate"]],
      ["aih.skill.inventory", ["skill", "inventory"]],
      ["aih.status.root", ["status"]],
    ];
    expect(
      GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES.map((item) => [
        item.diagnosticId,
        item.commandPath,
      ]),
    ).toEqual(expected);
    expect(Object.isFrozen(GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES)).toBe(true);
    for (const surface of GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_SURFACES) {
      expect(Object.isFrozen(surface)).toBe(true);
      expect(Object.isFrozen(surface.commandPath)).toBe(true);
    }
    for (const [, path] of expected) expect(ALL_COMMAND_SPEC_PATHS).toContainEqual(path);
    expect(READONLY.map((spec) => spec.name)).toEqual(expect.arrayContaining(["doctor", "status"]));
    expect(CAPABILITY_PACKAGE_COMMAND_SPECS.find((spec) => spec.name === "doctor")?.readOnly).toBe(
      true,
    );
    for (const [group, name] of [
      ["pack", "status"],
      ["policy", "evaluate"],
      ["skill", "inventory"],
    ] as const)
      expect(GROUPED_COMMAND_SPECS[group].find((spec) => spec.name === name)?.readOnly).toBe(true);
  });
});

describe("createGovernanceDoctorDiagnosticRegistryV1", () => {
  it("registers explicitly allow-listed read-only seams", () => {
    const built = registry([seam(DOCTOR, findingsOutcome()), seam(POLICY, findingsOutcome())]);
    expect(built.protocol).toBe("GovernanceDoctorDiagnosticRegistryV1");
    expect(built.diagnosticIds).toEqual([DOCTOR, POLICY]);
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.diagnosticIds)).toBe(true);
  });

  it("orders registered ids deterministically regardless of registration order", () => {
    expect(
      registry([seam(POLICY, findingsOutcome()), seam(DOCTOR, findingsOutcome())]).diagnosticIds,
    ).toEqual([DOCTOR, POLICY]);
  });

  it("refuses a seam whose id is not an explicitly registered read-only diagnostic", () => {
    for (const id of [
      "aih.trust.allow",
      "aih.mcp.approve",
      "aih.marketplace.publish",
      "aih.skill.remove",
      "aih.pack.uninstall",
      "aih.support.issue",
      "aih.trust.scan",
      "aih.evidence.build",
      "npm install",
      "gh issue create",
      "sh -c 'aih doctor'",
      "aih doctor --force",
      "",
    ])
      expect(() => registry([seam(id, findingsOutcome())]), id).toThrow(TypeError);
  });

  it("refuses legacy effect and runner fields even when its id is allow-listed", () => {
    for (const extra of [
      { effect: "read-only" },
      { run: () => findingsOutcome() },
      { effect: "mutating", run: () => findingsOutcome() },
    ])
      expect(() => registry([{ ...seam(DOCTOR, findingsOutcome()), ...extra }])).toThrow(TypeError);
  });

  it("refuses duplicate, empty, malformed, proxied, accessor-backed, and sparse seams", () => {
    expect(() =>
      registry([seam(DOCTOR, findingsOutcome()), seam(DOCTOR, findingsOutcome())]),
    ).toThrow(TypeError);
    expect(() => registry([])).toThrow(TypeError);
    expect(() => createGovernanceDoctorDiagnosticRegistryV1({ diagnostics: {} })).toThrow(
      TypeError,
    );
    expect(() => createGovernanceDoctorDiagnosticRegistryV1({ diagnostics: [], extra: 1 })).toThrow(
      TypeError,
    );
    expect(() => registry([{ diagnosticId: DOCTOR }])).toThrow(TypeError);
    expect(() => registry([{ ...seam(DOCTOR, findingsOutcome()), extra: 1 }])).toThrow(TypeError);
    expect(() => registry([new Proxy(seam(DOCTOR, findingsOutcome()), {})])).toThrow(TypeError);

    const accessorSeam = seam(DOCTOR, findingsOutcome());
    Object.defineProperty(accessorSeam, "diagnosticId", {
      configurable: true,
      enumerable: true,
      get: () => DOCTOR,
    });
    expect(() => registry([accessorSeam])).toThrow(TypeError);

    const sparse = [seam(DOCTOR, findingsOutcome()), seam(POLICY, findingsOutcome())];
    delete sparse[0];
    expect(() => registry(sparse)).toThrow(TypeError);
  });

  it("accepts the whole allow-list at its natural ceiling", () => {
    const all = GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS.map((id) => seam(id, findingsOutcome()));
    expect(registry(all).diagnosticIds).toEqual([...GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS]);
  });

  it("stores only precomputed diagnostic data at registration time", () => {
    const doctor = seam(DOCTOR, findingsOutcome());
    registry([doctor]);
    expect(Object.keys(doctor).sort()).toEqual(["diagnosticId", "outcome"]);
    expect(auditSource).not.toContain("GovernanceDoctorDiagnosticRequestV1");
  });

  it("refuses a forged registry that was never validated by this module", () => {
    const built = registry([seam(DOCTOR, findingsOutcome())]);
    expect(() => runGovernanceDoctorAuditV1(auditInput({ registry: { ...built } }))).toThrow(
      TypeError,
    );
    expect(() =>
      runGovernanceDoctorAuditV1(
        auditInput({
          registry: {
            diagnosticIds: [DOCTOR],
            protocol: "GovernanceDoctorDiagnosticRegistryV1",
          },
        }),
      ),
    ).toThrow(TypeError);
  });
});

describe("runGovernanceDoctorAuditV1", () => {
  it("summarizes stable coded findings from registered read-only diagnostics only", () => {
    const result = audited();
    expect(result.protocol).toBe("GovernanceDoctorAuditV1");
    expect(result.policyRevisionSha256).toBe(policyRevision);
    expect(result.profileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.auditSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.refusals).toEqual([]);
    expect(result.findings.map((item) => [item.diagnosticId, item.code, item.severity])).toEqual([
      [DOCTOR, "CANON_ROUTER_PRESENT", "info"],
      [POLICY, "POLICY_EFFECTIVE", "info"],
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.findings)).toBe(true);
    expect(Object.isFrozen(result.findings[0])).toBe(true);
  });

  it("uses only precomputed outcomes and exposes no diagnostic invocation surface", () => {
    const result = runGovernanceDoctorAuditV1(auditInput());
    expect(result.kind).toBe("audited");
    expect(auditSource).not.toMatch(/\b(?:run|invoke)\s*\(/);
  });

  it("ignores precomputed diagnostics the profile did not declare", () => {
    const undeclared = seam("aih.status.root", findingsOutcome());
    const result = runGovernanceDoctorAuditV1(
      auditInput({
        registry: registry([
          seam(DOCTOR, findingsOutcome()),
          seam(POLICY, findingsOutcome()),
          undeclared,
        ]),
      }),
    );
    if (result.kind !== "audited") throw new Error("expected an audited result");
    expect(result.findings.map((item) => item.diagnosticId)).not.toContain(undeclared.diagnosticId);
  });

  it("reports missing-adapter without conflating it with an evidence gap", () => {
    const result = runGovernanceDoctorAuditV1(
      auditInput({ registry: registry([seam(DOCTOR, findingsOutcome())]) }),
    );
    if (result.kind !== "audited") throw new Error("expected an audited result");
    expect(result.refusals).toEqual([{ diagnosticId: POLICY, state: "missing-adapter" }]);
    expect(result.findings.map((item) => item.diagnosticId)).toEqual([DOCTOR]);
  });

  it("preserves each seam-reported refusal state distinctly", () => {
    for (const state of [
      "evidence-gap",
      "missing-credential",
      "unsupported-host",
      "unmanaged-drift",
    ]) {
      const result = runGovernanceDoctorAuditV1(
        auditInput({
          registry: registry([
            seam(DOCTOR, refusalOutcome(state)),
            seam(POLICY, findingsOutcome()),
          ]),
        }),
      );
      if (result.kind !== "audited") throw new Error("expected an audited result");
      expect(result.refusals, state).toEqual([{ diagnosticId: DOCTOR, state }]);
      expect(
        result.findings.map((item) => item.diagnosticId),
        state,
      ).toEqual([POLICY]);
    }
  });

  it("refuses the whole audit when policy denies without reading diagnostics", () => {
    const result = runGovernanceDoctorAuditV1(
      auditInput({
        policy: { decision: "denied", revisionSha256: policyRevision },
        registry: registry([seam(DOCTOR, findingsOutcome()), seam(POLICY, findingsOutcome())]),
      }),
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") throw new Error("expected a refused result");
    expect(result.state).toBe("policy-denied");
    expect(result.actionable).toBe(false);
    expect(result.policyRevisionSha256).toBe(policyRevision);
    expect(result.profileSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses denied and incompatible requests before consulting an unbranded registry", () => {
    const forgedRegistry = {
      diagnosticIds: [DOCTOR],
      protocol: "GovernanceDoctorDiagnosticRegistryV1",
    };
    const denied = runGovernanceDoctorAuditV1(
      auditInput({
        policy: { decision: "denied", revisionSha256: policyRevision },
        registry: forgedRegistry,
      }),
    );
    expect(denied.kind).toBe("refused");
    if (denied.kind === "refused") expect(denied.state).toBe("policy-denied");
    const incompatible = runGovernanceDoctorAuditV1(
      auditInput({ profile: profile({ schemaVersion: "2" }), registry: forgedRegistry }),
    );
    expect(incompatible.kind).toBe("refused");
    if (incompatible.kind === "refused") expect(incompatible.state).toBe("compatibility-required");
  });

  it("keeps an unknown schema, effect, or profile version visible and non-actionable", () => {
    for (const override of [
      { schemaVersion: "2" },
      { effectVersion: "99" },
      { profileVersion: "future" },
    ]) {
      const result = runGovernanceDoctorAuditV1(
        auditInput({
          profile: profile(override),
          registry: registry([seam(DOCTOR, findingsOutcome()), seam(POLICY, findingsOutcome())]),
        }),
      );
      if (result.kind !== "refused") throw new Error("expected a refused result");
      expect(result.state, JSON.stringify(override)).toBe("compatibility-required");
      expect(result.actionable).toBe(false);
      expect(result.profileSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("reports policy denial ahead of compatibility so authority is never bypassed", () => {
    const result = runGovernanceDoctorAuditV1(
      auditInput({
        policy: { decision: "denied", revisionSha256: policyRevision },
        profile: profile({ schemaVersion: "2" }),
      }),
    );
    if (result.kind !== "refused") throw new Error("expected a refused result");
    expect(result.state).toBe("policy-denied");
  });

  it("rejects an unbranded profile, malformed policy, and unknown input fields", () => {
    const real = profile();
    const forged = JSON.parse(canonicalGovernanceDoctorProfileV1Bytes(real).toString("utf8"));
    expect(() => runGovernanceDoctorAuditV1(auditInput({ profile: forged }))).toThrow(TypeError);
    expect(() => runGovernanceDoctorAuditV1(auditInput({ profile: { ...real } }))).toThrow(
      TypeError,
    );
    for (const policy of [
      { decision: "allowed" },
      { decision: "maybe", revisionSha256: policyRevision },
      { decision: "allowed", revisionSha256: "not-a-digest" },
      { decision: "allowed", extra: 1, revisionSha256: policyRevision },
      null,
    ])
      expect(
        () => runGovernanceDoctorAuditV1(auditInput({ policy })),
        JSON.stringify(policy),
      ).toThrow(TypeError);
    expect(() => runGovernanceDoctorAuditV1({ ...auditInput(), extra: 1 })).toThrow(TypeError);
    expect(() => runGovernanceDoctorAuditV1(new Proxy(auditInput(), {}))).toThrow(TypeError);
    expect(() => runGovernanceDoctorAuditV1(null)).toThrow(TypeError);
  });
});

describe("GovernanceDoctorAuditV1 canonical transport", () => {
  it("binds every audited and refused semantic field into the audit identity", () => {
    const auditedBody = JSON.parse(
      canonicalGovernanceDoctorAuditV1Bytes(audited()).toString("utf8"),
    ) as MutableJson;
    delete auditedBody.auditSha256;
    const auditedBase = governanceDoctorSha256V1("aih.governance-doctor-audit-v1", auditedBody);
    const auditedMutations: MutableJsonMutation[] = [
      (b) => (b.policyRevisionSha256 = "b".repeat(64)),
      (b) => (b.profileSha256 = "c".repeat(64)),
      (b) => (b.findings[0].code = "OTHER_CODE"),
      (b) => (b.findings[0].diagnosticId = POLICY),
      (b) => (b.findings[0].severity = "low"),
      (b) => (b.findings[0].summary.attribution = "detector:aih/other"),
      (b) => (b.findings[0].summary.text = "Different finding."),
      (b) => (b.refusals = [{ diagnosticId: "aih.status.root", state: "evidence-gap" }]),
    ];
    for (const mutate of auditedMutations) {
      const body = structuredClone(auditedBody);
      mutate(body);
      const parsed = parseGovernanceDoctorAuditV1Json(canonicalAuditTransport(body));
      expect(parsed.auditSha256).not.toBe(auditedBase);
    }
    const refused = runGovernanceDoctorAuditV1(
      auditInput({ policy: { decision: "denied", revisionSha256: policyRevision } }),
    );
    const refusedBody = JSON.parse(
      canonicalGovernanceDoctorAuditV1Bytes(refused).toString("utf8"),
    ) as MutableJson;
    delete refusedBody.auditSha256;
    const refusedBase = governanceDoctorSha256V1("aih.governance-doctor-audit-v1", refusedBody);
    const refusedMutations: MutableJsonMutation[] = [
      (b) => (b.policyRevisionSha256 = "d".repeat(64)),
      (b) => (b.profileSha256 = "e".repeat(64)),
      (b) => (b.state = "compatibility-required"),
    ];
    for (const mutate of refusedMutations) {
      const body = structuredClone(refusedBody);
      mutate(body);
      expect(parseGovernanceDoctorAuditV1Json(canonicalAuditTransport(body)).auditSha256).not.toBe(
        refusedBase,
      );
    }
  });
  it("rejects rehashed overlap and per-diagnostic cardinality bypasses", () => {
    const body = JSON.parse(
      canonicalGovernanceDoctorAuditV1Bytes(audited()).toString("utf8"),
    ) as Record<string, unknown>;
    delete body.auditSha256;
    body.refusals = [{ diagnosticId: DOCTOR, state: "evidence-gap" }];
    expect(() => parseGovernanceDoctorAuditV1Json(canonicalAuditTransport(body))).toThrow(
      TypeError,
    );

    body.refusals = [];
    body.findings = Array.from(
      { length: GOVERNANCE_DOCTOR_V1_LIMITS.maxFindingsPerDiagnostic + 1 },
      (_, index) => ({
        code: `BOUND_${String(index).padStart(2, "0")}`,
        diagnosticId: DOCTOR,
        severity: "info",
        summary: prose(),
      }),
    );
    expect(() => parseGovernanceDoctorAuditV1Json(canonicalAuditTransport(body))).toThrow(
      TypeError,
    );
  });

  it("does not render a rehashed parsed audit whose diagnostic is outside its matched profile", () => {
    const matchedProfile = profile({ diagnosticIds: [POLICY] });
    const body = JSON.parse(
      canonicalGovernanceDoctorAuditV1Bytes(audited()).toString("utf8"),
    ) as Record<string, unknown>;
    delete body.auditSha256;
    body.profileSha256 = matchedProfile.governanceDoctorProfileSha256;
    const parsed = parseGovernanceDoctorAuditV1Json(canonicalAuditTransport(body));
    expect(() => renderGovernanceDoctorGuideV1({ audit: parsed, profile: matchedProfile })).toThrow(
      TypeError,
    );
  });

  it("round-trips audited and refused records only through their exact canonical bytes", () => {
    const auditedRecord = audited();
    const refusedRecord = runGovernanceDoctorAuditV1(
      auditInput({ policy: { decision: "denied", revisionSha256: policyRevision } }),
    );
    for (const record of [auditedRecord, refusedRecord]) {
      const bytes = canonicalGovernanceDoctorAuditV1Bytes(record);
      const parsed = parseGovernanceDoctorAuditV1Json(bytes);
      expect(canonicalGovernanceDoctorAuditV1Bytes(parsed).equals(bytes)).toBe(true);
      expect(parsed.auditSha256).toBe(record.auditSha256);
    }
    expect(canonicalGovernanceDoctorAuditV1Bytes(auditedRecord).toString("base64")).toBe(
      "eyJhdWRpdFNoYTI1NiI6Ijg2YTc5NGRhMGEzYTBlYjdiZjNmZDVjNWRhNjExOWJiZGIxMzY1NTBiOGZjNWNhNzg0YmIxYzdlMDUzNTA4MDMiLCJmaW5kaW5ncyI6W3siY29kZSI6IkNBTk9OX1JPVVRFUl9QUkVTRU5UIiwiZGlhZ25vc3RpY0lkIjoiYWloLmRvY3Rvci5yb290Iiwic2V2ZXJpdHkiOiJpbmZvIiwic3VtbWFyeSI6eyJhdHRyaWJ1dGlvbiI6ImRldGVjdG9yOmFpaC9kb2N0b3IiLCJ0ZXh0IjoiVGhlIHJlcG9zaXRvcnkgY2Fub24gcm91dGVyIGlzIHByZXNlbnQgYW5kIGxvYWRhYmxlLiJ9fSx7ImNvZGUiOiJQT0xJQ1lfRUZGRUNUSVZFIiwiZGlhZ25vc3RpY0lkIjoiYWloLnBvbGljeS5ldmFsdWF0ZSIsInNldmVyaXR5IjoiaW5mbyIsInN1bW1hcnkiOnsiYXR0cmlidXRpb24iOiJkZXRlY3RvcjphaWgvZG9jdG9yIiwidGV4dCI6IlRoZSByZXBvc2l0b3J5IGNhbm9uIHJvdXRlciBpcyBwcmVzZW50IGFuZCBsb2FkYWJsZS4ifX1dLCJraW5kIjoiYXVkaXRlZCIsInBvbGljeVJldmlzaW9uU2hhMjU2IjoiYTUzNDlmNjRlM2VlNTRkNDQ1YmJlYzNhNDdiYTJkYmUxNzlmOGI0MDU5YjIwYzQ3ZDVjM2VkNWY0NGZhMjA2OSIsInByb2ZpbGVTaGEyNTYiOiJjODc5YjlkNTQ4ZWFiNzI2ZjE5YjVkMTMzZmE4ZjRhNDZkZDJmZTMxMjVhNzMxOTBjMjhmODNjMTNmNzZiYTBkIiwicHJvdG9jb2wiOiJHb3Zlcm5hbmNlRG9jdG9yQXVkaXRWMSIsInJlZnVzYWxzIjpbXX0=",
    );
  });

  it("rejects noncanonical, BOM-prefixed, duplicate, malformed, and forged audit transport", () => {
    const bytes = canonicalGovernanceDoctorAuditV1Bytes(audited());
    const text = bytes.toString("utf8");
    const duplicate = text.replace("{", '{"kind":"audited",');
    const forged = JSON.parse(text) as Record<string, unknown>;
    forged.auditSha256 = "0".repeat(64);
    for (const candidate of [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
      Buffer.from(` ${text}`, "utf8"),
      Buffer.from(duplicate, "utf8"),
      Buffer.from("{", "utf8"),
      Buffer.from(JSON.stringify(forged), "utf8"),
    ])
      expect(() => parseGovernanceDoctorAuditV1Json(candidate)).toThrow(TypeError);
  });
});

describe("runGovernanceDoctorAuditV1 hostile seam outcomes", () => {
  it("rejects an unknown, mislabeled, or capability-bearing outcome shape", () => {
    for (const outcome of [
      { kind: "repair", plan: "x" },
      { kind: "findings" },
      { extra: 1, findings: [finding()], kind: "findings" },
      { kind: "refusal", state: "applied-unverified" },
      { kind: "refusal", state: "policy-denied" },
      { kind: "refusal", state: "compatibility-required" },
      { kind: "refusal" },
      { command: "aih doctor --force", findings: [], kind: "findings" },
      [finding()],
      "findings",
      null,
      undefined,
    ])
      expect(
        () =>
          runGovernanceDoctorAuditV1(
            auditInput({
              registry: registry([seam(DOCTOR, outcome), seam(POLICY, findingsOutcome())]),
            }),
          ),
        JSON.stringify(outcome ?? null),
      ).toThrow(TypeError);
  });

  it("rejects a proxied or accessor-backed outcome", () => {
    expect(() =>
      runGovernanceDoctorAuditV1(
        auditInput({
          registry: registry([
            seam(DOCTOR, new Proxy(findingsOutcome(), {})),
            seam(POLICY, findingsOutcome()),
          ]),
        }),
      ),
    ).toThrow(TypeError);

    const accessorOutcome: Record<string, unknown> = { findings: [finding()] };
    Object.defineProperty(accessorOutcome, "kind", {
      configurable: true,
      enumerable: true,
      get: () => "findings",
    });
    expect(() =>
      runGovernanceDoctorAuditV1(
        auditInput({
          registry: registry([seam(DOCTOR, accessorOutcome), seam(POLICY, findingsOutcome())]),
        }),
      ),
    ).toThrow(TypeError);
  });

  it("rejects hostile finding prose rather than sanitizing it into the summary", () => {
    for (const text of [
      `run${cp(0x0007)}aih`,
      `run ${cp(0x202e)}aih doctor`,
      `run${cp(0x200b)}aih`,
      `run${cp(0xfeff)}aih`,
      `run${cp(0x00ad)}aih`,
      `run${cp(0x2028)}aih`,
      "run\naih",
      `cafe${cp(0x0301)} policy`,
      "run \ud800 aih",
      " padded",
      "",
      "a".repeat(GOVERNANCE_DOCTOR_V1_LIMITS.maxProseCodeUnits + 1),
    ])
      expect(
        () =>
          runGovernanceDoctorAuditV1(
            auditInput({
              registry: registry([
                seam(DOCTOR, findingsOutcome([finding({ summary: prose({ text }) })])),
                seam(POLICY, findingsOutcome()),
              ]),
            }),
          ),
        JSON.stringify(text),
      ).toThrow(TypeError);
  });

  it("rejects malformed finding codes, severities, and unattributed summaries", () => {
    for (const code of ["", "lowercase", "WITH SPACE", "WITH-DASH", "_LEADING", "A".repeat(200)])
      expect(
        () =>
          runGovernanceDoctorAuditV1(
            auditInput({
              registry: registry([
                seam(DOCTOR, findingsOutcome([finding({ code })])),
                seam(POLICY, findingsOutcome()),
              ]),
            }),
          ),
        code,
      ).toThrow(TypeError);
    for (const severity of ["", "fatal", "INFO", null, 1])
      expect(
        () =>
          runGovernanceDoctorAuditV1(
            auditInput({
              registry: registry([
                seam(DOCTOR, findingsOutcome([finding({ severity })])),
                seam(POLICY, findingsOutcome()),
              ]),
            }),
          ),
        String(severity),
      ).toThrow(TypeError);
    expect(() =>
      runGovernanceDoctorAuditV1(
        auditInput({
          registry: registry([
            seam(DOCTOR, findingsOutcome([{ code: "X", severity: "info" }])),
            seam(POLICY, findingsOutcome()),
          ]),
        }),
      ),
    ).toThrow(TypeError);
  });

  it("enforces per-diagnostic and total finding ceilings", () => {
    const perDiagnostic = GOVERNANCE_DOCTOR_V1_LIMITS.maxFindingsPerDiagnostic;
    const build = (tag: string, count: number) =>
      Array.from({ length: count }, (_unused, index) =>
        finding({ code: `${tag}_${String(index).padStart(4, "0")}` }),
      );

    expect(
      audited({
        registry: registry([
          seam(DOCTOR, findingsOutcome(build("D", perDiagnostic))),
          seam(POLICY, findingsOutcome()),
        ]),
      }).findings.length,
    ).toBe(perDiagnostic + 1);
    expect(() =>
      runGovernanceDoctorAuditV1(
        auditInput({
          registry: registry([
            seam(DOCTOR, findingsOutcome(build("D", perDiagnostic + 1))),
            seam(POLICY, findingsOutcome()),
          ]),
        }),
      ),
    ).toThrow(TypeError);

    const needed = Math.ceil((GOVERNANCE_DOCTOR_V1_LIMITS.maxFindings + 1) / perDiagnostic);
    expect(needed).toBeLessThanOrEqual(GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS.length);
    const wide = GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS.slice(0, needed);
    expect(() =>
      runGovernanceDoctorAuditV1(
        auditInput({
          profile: profile({ diagnosticIds: [...wide] }),
          registry: registry(
            wide.map((id) =>
              seam(id, findingsOutcome(build(id.replace(/\W/g, "_").toUpperCase(), perDiagnostic))),
            ),
          ),
        }),
      ),
    ).toThrow(TypeError);
  });

  it("rejects duplicate coded findings from one diagnostic", () => {
    expect(() =>
      runGovernanceDoctorAuditV1(
        auditInput({
          registry: registry([
            seam(DOCTOR, findingsOutcome([finding(), finding()])),
            seam(POLICY, findingsOutcome()),
          ]),
        }),
      ),
    ).toThrow(TypeError);
  });

  it("rejects a callback-bearing legacy entry with a fixed diagnostic that leaks nothing", () => {
    const secret = "ghp_EXAMPLE_TOKEN_VALUE_FOR_TEST";
    const throwing = {
      diagnosticId: DOCTOR,
      outcome: findingsOutcome(),
      run: () => {
        throw new Error(`connect to https://internal.example/${secret}`);
      },
    };
    let message = "";
    try {
      registry([throwing, seam(POLICY, findingsOutcome())]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "GOVERNANCE_DOCTOR_V1: precomputed diagnostic must declare exactly its schema fields",
    );
    expect(message).not.toContain(secret);
    expect(message).not.toContain("internal.example");
  });

  it("is deterministic across seam order, finding order, and repeated runs", () => {
    const shuffled = runGovernanceDoctorAuditV1(
      auditInput({
        registry: registry([
          seam(POLICY, findingsOutcome([finding({ code: "POLICY_EFFECTIVE" })])),
          seam(
            DOCTOR,
            findingsOutcome([finding({ code: "Z_LAST" }), finding({ code: "A_FIRST" })]),
          ),
        ]),
      }),
    );
    const straight = runGovernanceDoctorAuditV1(
      auditInput({
        registry: registry([
          seam(
            DOCTOR,
            findingsOutcome([finding({ code: "A_FIRST" }), finding({ code: "Z_LAST" })]),
          ),
          seam(POLICY, findingsOutcome([finding({ code: "POLICY_EFFECTIVE" })])),
        ]),
      }),
    );
    if (shuffled.kind !== "audited" || straight.kind !== "audited")
      throw new Error("expected audited results");
    expect(shuffled.findings.map((item) => item.code)).toEqual([
      "A_FIRST",
      "Z_LAST",
      "POLICY_EFFECTIVE",
    ]);
    expect(shuffled.auditSha256).toBe(straight.auditSha256);
  });

  it("deep copies precomputed diagnostic output so post-return mutation cannot alter the audit", () => {
    const mutable = finding();
    const result = audited({
      registry: registry([
        seam(DOCTOR, findingsOutcome([mutable])),
        seam(POLICY, findingsOutcome()),
      ]),
    });
    const before = result.auditSha256;
    mutable.code = "TAMPERED";
    (mutable.summary as { text: string }).text = "tampered";
    expect(result.findings[0]?.code).toBe("CANON_ROUTER_PRESENT");
    expect(result.findings[0]?.summary.text).toBe(
      "The repository canon router is present and loadable.",
    );
    expect(result.auditSha256).toBe(before);
  });

  it("separates the audit identity domain from the profile identity domain", () => {
    const result = audited();
    expect(result.auditSha256).not.toBe(result.profileSha256);
  });
});

describe("renderGovernanceDoctorGuideV1", () => {
  it("explains roles, prerequisites, conflicts, policy state, and the next AIH-owned action", () => {
    const audit = audited();
    const guide = renderGovernanceDoctorGuideV1({ audit, profile: profile() });
    if (guide.kind !== "available") throw new Error("expected an available guide");
    expect(guide.protocol).toBe("GovernanceDoctorGuideV1");
    expect(guide.surfaceId).toBe("surface:aih.governance-doctor");
    expect(guide.targetId).toBe("target:aih.workstation");
    expect(guide.repairPosture).toBe("guided-only");
    expect(guide.policy).toEqual({ decision: "allowed", revisionSha256: policyRevision });
    expect(guide.nextAction).toEqual({
      actionId: "aih.status.root",
      executable: false,
      owner: "aih",
    });
    expect(guide.roles.map((item) => [item.roleId, item.owner])).toEqual([["policy-owner", "aih"]]);
    expect(guide.prerequisites.map((item) => [item.prerequisiteId, item.satisfiedBy])).toEqual([
      ["effective-policy", "org-policy"],
    ]);
    expect(guide.conflicts.map((item) => item.conflictsWithSurfaceId)).toEqual([
      "surface:aih.mcp-controls",
    ]);
    expect(guide.auditSha256).toBe(audit.auditSha256);
    expect(guide.profileSha256).toBe(audit.profileSha256);
    expect(guide.guideSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(guide.guideSha256).not.toBe(audit.auditSha256);
    expect(Object.isFrozen(guide)).toBe(true);
    expect(Object.isFrozen(guide.roles[0])).toBe(true);
  });

  it("renders every prose field quoted, source-attributed, and explicitly non-authoritative", () => {
    const audit = audited();
    const guide = renderGovernanceDoctorGuideV1({ audit, profile: profile() });
    if (guide.kind !== "available") throw new Error("expected an available guide");
    const quoted = [
      ...guide.roles.map((item) => item.summary),
      ...guide.prerequisites.map((item) => item.note),
      ...guide.conflicts.map((item) => item.note),
      ...guide.findings.map((item) => item.summary),
      guide.guidance,
    ];
    expect(quoted.length).toBeGreaterThan(4);
    for (const entry of quoted) {
      expect(Object.keys(entry).sort()).toEqual(["attribution", "authority", "quoted"]);
      expect(entry.authority).toBe("none");
      expect(entry.attribution).toMatch(/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9./-]*$/);
      expect(entry.quoted.startsWith('"')).toBe(true);
      expect(entry.quoted.endsWith('"')).toBe(true);
      expect(entry.quoted.slice(1, -1)).not.toContain('"');
    }
  });

  it("names no executable command anywhere in its rendered output", () => {
    const audit = audited();
    const guide = renderGovernanceDoctorGuideV1({ audit, profile: profile() });
    const text = JSON.stringify(guide);
    for (const token of ["--force", "--yes", "--delete", "npx ", "sh -c", "&&", ">"])
      expect(text, token).not.toContain(token);
    expect(text).toContain('"executable":false');
  });

  it("withholds the guide and the next action for every audit-level refusal", () => {
    const denied = runGovernanceDoctorAuditV1(
      auditInput({ policy: { decision: "denied", revisionSha256: policyRevision } }),
    );
    const deniedGuide = renderGovernanceDoctorGuideV1({ audit: denied, profile: profile() });
    if (deniedGuide.kind !== "withheld") throw new Error("expected a withheld guide");
    expect(deniedGuide.state).toBe("policy-denied");
    expect(deniedGuide.nextAction).toEqual({ executable: false, owner: "aih", unavailable: true });
    expect(deniedGuide.profileSha256).toBe(denied.profileSha256);
    expect(JSON.stringify(deniedGuide)).not.toContain("actionId");

    const incompatibleProfile = profile({ schemaVersion: "2" });
    const incompatible = runGovernanceDoctorAuditV1(auditInput({ profile: incompatibleProfile }));
    const incompatibleGuide = renderGovernanceDoctorGuideV1({
      audit: incompatible,
      profile: incompatibleProfile,
    });
    if (incompatibleGuide.kind !== "withheld") throw new Error("expected a withheld guide");
    expect(incompatibleGuide.state).toBe("compatibility-required");
  });

  it("surfaces per-diagnostic refusal states beside the findings", () => {
    const audit = audited({
      registry: registry([
        seam(DOCTOR, refusalOutcome("evidence-gap")),
        seam(POLICY, findingsOutcome()),
      ]),
    });
    const guide = renderGovernanceDoctorGuideV1({ audit, profile: profile() });
    if (guide.kind !== "available") throw new Error("expected an available guide");
    expect(guide.refusals).toEqual([{ diagnosticId: DOCTOR, state: "evidence-gap" }]);
    expect(guide.findings.map((item) => item.diagnosticId)).toEqual([POLICY]);
  });

  it("refuses a forged audit, a mismatched profile, and unknown input fields", () => {
    const audit = audited();
    const forgedAudit = JSON.parse(JSON.stringify(audit));
    expect(() => renderGovernanceDoctorGuideV1({ audit: forgedAudit, profile: profile() })).toThrow(
      TypeError,
    );
    expect(() =>
      renderGovernanceDoctorGuideV1({ audit: { ...audit }, profile: profile() }),
    ).toThrow(TypeError);
    expect(() =>
      renderGovernanceDoctorGuideV1({
        audit,
        profile: profile({ surfaceId: "surface:aih.other" }),
      }),
    ).toThrow(TypeError);
    expect(() => renderGovernanceDoctorGuideV1({ audit, extra: 1, profile: profile() })).toThrow(
      TypeError,
    );
    expect(() =>
      renderGovernanceDoctorGuideV1(new Proxy({ audit, profile: profile() }, {})),
    ).toThrow(TypeError);
    expect(() => renderGovernanceDoctorGuideV1(null)).toThrow(TypeError);
  });

  it("is deterministic and byte-stable across repeated renders", () => {
    const audit = audited();
    const first = renderGovernanceDoctorGuideV1({ audit, profile: profile() });
    const second = renderGovernanceDoctorGuideV1({ audit, profile: profile() });
    expect(second.guideSha256).toBe(first.guideSha256);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("reads no diagnostic callback while rendering", () => {
    const audit = runGovernanceDoctorAuditV1(
      auditInput({
        registry: registry([seam(DOCTOR, findingsOutcome()), seam(POLICY, findingsOutcome())]),
      }),
    );
    renderGovernanceDoctorGuideV1({ audit, profile: profile() });
    renderGovernanceDoctorGuideV1({ audit, profile: profile() });
    expect(auditSource).not.toMatch(/\.(?:run|invoke)\s*\(/);
  });
});

describe("GovernanceDoctorGuideV1 canonical transport", () => {
  it("binds every available and withheld semantic field into the guide identity", () => {
    const available = renderGovernanceDoctorGuideV1({ audit: audited(), profile: profile() });
    if (available.kind !== "available") throw new Error("expected available");
    const original = JSON.parse(
      canonicalGovernanceDoctorGuideV1Bytes(available).toString("utf8"),
    ) as MutableJson;
    delete original.guideSha256;
    const base = governanceDoctorSha256V1("aih.governance-doctor-guide-v1", original);
    const mutations: MutableJsonMutation[] = [
      (b) => (b.auditSha256 = "1".repeat(64)),
      (b) => (b.profileSha256 = "2".repeat(64)),
      (b) => (b.conflicts[0].conflictId = "other-conflict"),
      (b) => (b.conflicts[0].conflictsWithSurfaceId = "surface:aih.other"),
      (b) => (b.conflicts[0].note.attribution = "catalog:aih/other"),
      (b) => (b.conflicts[0].note.quoted = '"Other conflict."'),
      (b) => (b.findings[0].code = "OTHER_CODE"),
      (b) => (b.findings[0].diagnosticId = POLICY),
      (b) => (b.findings[0].severity = "low"),
      (b) => (b.findings[0].summary.attribution = "detector:aih/other"),
      (b) => (b.findings[0].summary.quoted = '"Other finding."'),
      (b) => (b.guidance.attribution = "catalog:aih/other"),
      (b) => (b.guidance.quoted = '"Other guidance."'),
      (b) => (b.nextAction.actionId = DOCTOR),
      (b) => (b.policy.revisionSha256 = "3".repeat(64)),
      (b) => (b.prerequisites[0].prerequisiteId = "other-policy"),
      (b) => (b.prerequisites[0].satisfiedBy = "operator"),
      (b) => (b.prerequisites[0].note.attribution = "catalog:aih/other"),
      (b) => (b.prerequisites[0].note.quoted = '"Other prerequisite."'),
      (b) => (b.refusals = [{ diagnosticId: "aih.status.root", state: "evidence-gap" }]),
      (b) => (b.repairPosture = "unavailable"),
      (b) => (b.roles[0].roleId = "other-owner"),
      (b) => (b.roles[0].owner = "operator"),
      (b) => (b.roles[0].summary.attribution = "catalog:aih/other"),
      (b) => (b.roles[0].summary.quoted = '"Other role."'),
      (b) => (b.surfaceId = "surface:aih.other"),
      (b) => (b.targetId = "target:aih.other"),
    ];
    for (const mutate of mutations) {
      const body = structuredClone(original);
      mutate(body);
      expect(parseGovernanceDoctorGuideV1Json(canonicalGuideTransport(body)).guideSha256).not.toBe(
        base,
      );
    }
    const denied = runGovernanceDoctorAuditV1(
      auditInput({ policy: { decision: "denied", revisionSha256: policyRevision } }),
    );
    const withheld = renderGovernanceDoctorGuideV1({ audit: denied, profile: profile() });
    const withheldBody = JSON.parse(
      canonicalGovernanceDoctorGuideV1Bytes(withheld).toString("utf8"),
    ) as MutableJson;
    delete withheldBody.guideSha256;
    const withheldBase = governanceDoctorSha256V1("aih.governance-doctor-guide-v1", withheldBody);
    const withheldMutations: MutableJsonMutation[] = [
      (b) => (b.policyRevisionSha256 = "4".repeat(64)),
      (b) => (b.profileSha256 = "5".repeat(64)),
      (b) => (b.state = "compatibility-required"),
    ];
    for (const mutate of withheldMutations) {
      const body = structuredClone(withheldBody);
      mutate(body);
      expect(parseGovernanceDoctorGuideV1Json(canonicalGuideTransport(body)).guideSha256).not.toBe(
        withheldBase,
      );
    }
  });
  it("rejects rehashed overlap, per-diagnostic bypasses, and absent profile collections", () => {
    const available = renderGovernanceDoctorGuideV1({ audit: audited(), profile: profile() });
    if (available.kind !== "available") throw new Error("expected an available guide");
    const body = JSON.parse(
      canonicalGovernanceDoctorGuideV1Bytes(available).toString("utf8"),
    ) as Record<string, unknown>;
    delete body.guideSha256;
    body.refusals = [{ diagnosticId: DOCTOR, state: "evidence-gap" }];
    expect(() => parseGovernanceDoctorGuideV1Json(canonicalGuideTransport(body))).toThrow(
      TypeError,
    );
    body.refusals = [];
    body.roles = [];
    expect(() => parseGovernanceDoctorGuideV1Json(canonicalGuideTransport(body))).toThrow(
      TypeError,
    );
  });

  it("round-trips available and withheld records only through their exact canonical bytes", () => {
    const available = renderGovernanceDoctorGuideV1({ audit: audited(), profile: profile() });
    const refused = runGovernanceDoctorAuditV1(
      auditInput({ policy: { decision: "denied", revisionSha256: policyRevision } }),
    );
    const withheld = renderGovernanceDoctorGuideV1({ audit: refused, profile: profile() });
    for (const record of [available, withheld]) {
      const bytes = canonicalGovernanceDoctorGuideV1Bytes(record);
      const parsed = parseGovernanceDoctorGuideV1Json(bytes);
      expect(canonicalGovernanceDoctorGuideV1Bytes(parsed).equals(bytes)).toBe(true);
      expect(parsed.guideSha256).toBe(record.guideSha256);
    }
    expect(canonicalGovernanceDoctorGuideV1Bytes(available).toString("base64")).toBe(
      "eyJhdWRpdFNoYTI1NiI6Ijg2YTc5NGRhMGEzYTBlYjdiZjNmZDVjNWRhNjExOWJiZGIxMzY1NTBiOGZjNWNhNzg0YmIxYzdlMDUzNTA4MDMiLCJjb25mbGljdHMiOlt7ImNvbmZsaWN0SWQiOiJtY3AtY29udHJvbHMiLCJjb25mbGljdHNXaXRoU3VyZmFjZUlkIjoic3VyZmFjZTphaWgubWNwLWNvbnRyb2xzIiwibm90ZSI6eyJhdHRyaWJ1dGlvbiI6ImNhdGFsb2c6YWloL2dvdmVybmFuY2UtZG9jdG9yIiwiYXV0aG9yaXR5Ijoibm9uZSIsInF1b3RlZCI6IlwiU2hhcmVkIE1DUCB0YXJnZXQuXCIifX1dLCJmaW5kaW5ncyI6W3siY29kZSI6IkNBTk9OX1JPVVRFUl9QUkVTRU5UIiwiZGlhZ25vc3RpY0lkIjoiYWloLmRvY3Rvci5yb290Iiwic2V2ZXJpdHkiOiJpbmZvIiwic3VtbWFyeSI6eyJhdHRyaWJ1dGlvbiI6ImRldGVjdG9yOmFpaC9kb2N0b3IiLCJhdXRob3JpdHkiOiJub25lIiwicXVvdGVkIjoiXCJUaGUgcmVwb3NpdG9yeSBjYW5vbiByb3V0ZXIgaXMgcHJlc2VudCBhbmQgbG9hZGFibGUuXCIifX0seyJjb2RlIjoiUE9MSUNZX0VGRkVDVElWRSIsImRpYWdub3N0aWNJZCI6ImFpaC5wb2xpY3kuZXZhbHVhdGUiLCJzZXZlcml0eSI6ImluZm8iLCJzdW1tYXJ5Ijp7ImF0dHJpYnV0aW9uIjoiZGV0ZWN0b3I6YWloL2RvY3RvciIsImF1dGhvcml0eSI6Im5vbmUiLCJxdW90ZWQiOiJcIlRoZSByZXBvc2l0b3J5IGNhbm9uIHJvdXRlciBpcyBwcmVzZW50IGFuZCBsb2FkYWJsZS5cIiJ9fV0sImd1aWRhbmNlIjp7ImF0dHJpYnV0aW9uIjoiY2F0YWxvZzphaWgvZ292ZXJuYW5jZS1kb2N0b3IiLCJhdXRob3JpdHkiOiJub25lIiwicXVvdGVkIjoiXCJSZWFkIHRoZSBjb2RlZCBmaW5kaW5ncyBiZWZvcmUgZGVjaWRpbmcgYW55dGhpbmcuXCIifSwiZ3VpZGVTaGEyNTYiOiIyMjRhNTMwMmUxMTkzZTczZjhmMjZkNmY3YTM5NGJjZTJkNjEzZTEyOWM4ZTFjNTVhMzdiNzU4OWRkMmU2NDYwIiwia2luZCI6ImF2YWlsYWJsZSIsIm5leHRBY3Rpb24iOnsiYWN0aW9uSWQiOiJhaWguc3RhdHVzLnJvb3QiLCJleGVjdXRhYmxlIjpmYWxzZSwib3duZXIiOiJhaWgifSwicG9saWN5Ijp7ImRlY2lzaW9uIjoiYWxsb3dlZCIsInJldmlzaW9uU2hhMjU2IjoiYTUzNDlmNjRlM2VlNTRkNDQ1YmJlYzNhNDdiYTJkYmUxNzlmOGI0MDU5YjIwYzQ3ZDVjM2VkNWY0NGZhMjA2OSJ9LCJwcmVyZXF1aXNpdGVzIjpbeyJub3RlIjp7ImF0dHJpYnV0aW9uIjoiY2F0YWxvZzphaWgvZ292ZXJuYW5jZS1kb2N0b3IiLCJhdXRob3JpdHkiOiJub25lIiwicXVvdGVkIjoiXCJQb2xpY3kgbXVzdCBleGlzdC5cIiJ9LCJwcmVyZXF1aXNpdGVJZCI6ImVmZmVjdGl2ZS1wb2xpY3kiLCJzYXRpc2ZpZWRCeSI6Im9yZy1wb2xpY3kifV0sInByb2ZpbGVTaGEyNTYiOiJjODc5YjlkNTQ4ZWFiNzI2ZjE5YjVkMTMzZmE4ZjRhNDZkZDJmZTMxMjVhNzMxOTBjMjhmODNjMTNmNzZiYTBkIiwicHJvdG9jb2wiOiJHb3Zlcm5hbmNlRG9jdG9yR3VpZGVWMSIsInJlZnVzYWxzIjpbXSwicmVwYWlyUG9zdHVyZSI6Imd1aWRlZC1vbmx5Iiwicm9sZXMiOlt7Im93bmVyIjoiYWloIiwicm9sZUlkIjoicG9saWN5LW93bmVyIiwic3VtbWFyeSI6eyJhdHRyaWJ1dGlvbiI6ImNhdGFsb2c6YWloL2dvdmVybmFuY2UtZG9jdG9yIiwiYXV0aG9yaXR5Ijoibm9uZSIsInF1b3RlZCI6IlwiQUlIIGRlY2lkZXMuXCIifX1dLCJzdXJmYWNlSWQiOiJzdXJmYWNlOmFpaC5nb3Zlcm5hbmNlLWRvY3RvciIsInRhcmdldElkIjoidGFyZ2V0OmFpaC53b3Jrc3RhdGlvbiJ9",
    );
  });

  it("rejects noncanonical, BOM-prefixed, duplicate, malformed, and forged guide transport", () => {
    const bytes = canonicalGovernanceDoctorGuideV1Bytes(
      renderGovernanceDoctorGuideV1({ audit: audited(), profile: profile() }),
    );
    const text = bytes.toString("utf8");
    const duplicate = text.replace("{", '{"kind":"available",');
    const forged = JSON.parse(text) as Record<string, unknown>;
    forged.guideSha256 = "0".repeat(64);
    for (const candidate of [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
      Buffer.from(` ${text}`, "utf8"),
      Buffer.from(duplicate, "utf8"),
      Buffer.from("{", "utf8"),
      Buffer.from(JSON.stringify(forged), "utf8"),
    ])
      expect(() => parseGovernanceDoctorGuideV1Json(candidate)).toThrow(TypeError);
  });
});
