import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  isVerifiedPolicyAuthority,
  verifyPolicyAuthorityReceipt,
} from "../../src/org-policy/authority.js";
import {
  governanceDecisionDigestV2,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../src/org-policy/governance-decision-v2.js";
import {
  canonicalOrganizationEvidenceEnvelopeV1,
  isVerifiedQualificationV1,
  MAX_ORGANIZATION_EVIDENCE_ENVELOPE_BYTES_V1,
  organizationEvidenceEnvelopeDigestV1,
  parseOrganizationEvidenceEnvelopeV1Bytes,
  verifyOrganizationQualificationV1,
} from "../../src/org-policy/qualification-v1.js";
import {
  resolveObservedEffect,
  verifyUpstreamObservationV1,
} from "../../src/org-policy/upstream-observation-receipt-v1.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let dir: string;
let authorityBin: string;
let trustedGh: string;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-02T12:00:00+00:00"));
  dir = mkdtempSync(join(tmpdir(), "aih-organization-qualification-"));
  authorityBin = mkdtempSync(join(tmpdir(), "aih-organization-qualification-gh-"));
  const gh = join(authorityBin, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(gh, "trusted gh fixture\n", { mode: 0o755 });
  trustedGh = realpathSync.native(gh);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
  rmSync(authorityBin, { recursive: true, force: true });
});

function decision(overrides: Record<string, unknown> = {}) {
  const source = {
    type: "github" as const,
    repository: "acme/review-tool",
    commit: "a".repeat(40),
    path: "tool.json",
  };
  const sourceDigest = governanceDecisionSourceDigestV2(source);
  return {
    format: "aih-governance-decision",
    version: 2,
    id: "decision-platform-tool",
    qualificationBasis: {
      kind: "organization-qualified",
      evidenceDigest: `sha256:${"e".repeat(64)}`,
      attestor: "scanner-service",
    },
    subject: {
      kind: "tool" as const,
      id: "platform-review-tool",
      source,
      sourceDigest,
      subjectDigest: governanceDecisionSubjectDigestV2({
        kind: "tool",
        id: "platform-review-tool",
        sourceDigest,
      }),
    },
    targets: ["claude"],
    allowedEffects: ["configure"],
    policy: { id: "platform-policy", version: "2026.08", digest: `sha256:${"c".repeat(64)}` },
    control: { id: "review-control", digest: `sha256:${"d".repeat(64)}` },
    evidence: {
      id: "scan-record",
      digest: `sha256:${"e".repeat(64)}`,
      attestor: "scanner-service",
    },
    issuer: "platform-security",
    actor: "security-admin",
    reason: "The exact pinned subject passed the reviewed control.",
    issuedAt: "2026-08-01T00:00:00+00:00",
    notBefore: "2026-08-01T00:00:00+00:00",
    expiresAt: "2026-08-10T00:00:00+00:00",
    disposition: "approved",
    acceptedFindings: [],
    acceptedGaps: [],
    conditions: [],
    ...overrides,
  };
}

function envelope(value: ReturnType<typeof decision>, overrides: Record<string, unknown> = {}) {
  return {
    format: "aih-organization-evidence",
    version: 1,
    subjectDigest: value.subject.subjectDigest,
    evidence: {
      kind: "assessment",
      id: value.evidence.id,
      summary: "The named organization assessment approved this exact subject.",
      payloadDigest: `sha256:${"1".repeat(64)}`,
      artifactDigests: [`sha256:${"2".repeat(64)}`],
    },
    attestor: value.evidence.attestor,
    issuedAt: "2026-08-01T00:00:00+00:00",
    notBefore: "2026-08-01T00:00:00+00:00",
    expiresAt: "2026-08-05T00:00:00+00:00",
    ...overrides,
  };
}

function canonicalBytes(value: ReturnType<typeof envelope>): Buffer {
  return Buffer.from(canonicalOrganizationEvidenceEnvelopeV1(value as never), "utf8");
}

function qualifiedDecision(overrides: Record<string, unknown> = {}) {
  const base = decision(overrides);
  const evidenceDigest = organizationEvidenceEnvelopeDigestV1(envelope(base) as never);
  return decision({
    ...overrides,
    qualificationBasis: {
      kind: "organization-qualified",
      evidenceDigest,
      attestor: "scanner-service",
    },
    evidence: { id: "scan-record", digest: evidenceDigest, attestor: "scanner-service" },
  });
}

function qualifiedDecisionWithEnvelope(envelopeOverrides: Record<string, unknown>) {
  const base = decision();
  const evidence = envelope(base, envelopeOverrides);
  const evidenceDigest = organizationEvidenceEnvelopeDigestV1(evidence as never);
  return decision({
    qualificationBasis: {
      kind: "organization-qualified",
      evidenceDigest,
      attestor: "scanner-service",
    },
    evidence: { id: "scan-record", digest: evidenceDigest, attestor: "scanner-service" },
  });
}

function qualifiedDecisionForOtherSubject() {
  const base = decision();
  const subject = {
    ...base.subject,
    id: "other-review-tool",
    subjectDigest: governanceDecisionSubjectDigestV2({
      kind: "tool",
      id: "other-review-tool",
      sourceDigest: base.subject.sourceDigest,
    }),
  };
  return qualifiedDecision({ id: "decision-secondary-tool", subject });
}

function unsupportedDecision() {
  const base = decision();
  return decision({
    qualificationBasis: {
      kind: "aih-supported",
      catalogSignerIdentity: "aih-catalog-service",
      catalogDigest: `sha256:${"3".repeat(64)}`,
      catalogHeadDigest: `sha256:${"4".repeat(64)}`,
      catalogMemberDigest: `sha256:${"5".repeat(64)}`,
      subjectKind: base.subject.kind,
      subjectDigest: base.subject.subjectDigest,
    },
  });
}

function ctx(): PlanContext {
  const run = fakeRunner((argv) =>
    argv[0] === trustedGh && argv[1] === "attestation" && argv[2] === "verify"
      ? { code: 0 }
      : { code: 1 },
  );
  return {
    root: dir,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { AIH_POLICY_AUTHORITY_REPOSITORY: "acme/governance", PATH: authorityBin },
    options: {},
  };
}

async function authority(...values: ReturnType<typeof decision>[]) {
  mkdirSync(join(dir, ".aih"), { recursive: true });
  writeFileSync(
    join(dir, ".aih", "policy-authority-receipt.json"),
    JSON.stringify({
      format: "aih-policy-authority-receipt",
      version: 3,
      issuerRepository: "acme/governance",
      issuedAt: "2026-08-01T00:00:00+00:00",
      expiresAt: "2026-08-10T00:00:00+00:00",
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
      targets: ["claude"],
      decisions: [...values].sort((left, right) => left.id.localeCompare(right.id)),
      decisionRevocations: [],
    }),
  );
  const verification = await verifyPolicyAuthorityReceipt(ctx());
  if (verification.authority === undefined) throw new Error(verification.problem);
  return verification.authority;
}

function observation(value: ReturnType<typeof decision>) {
  return {
    format: "aih-upstream-observation-receipt",
    version: 1,
    id: "observation-platform-tool",
    decision: { id: value.id, digest: governanceDecisionDigestV2(value as never) },
    subject: {
      kind: value.subject.kind,
      id: value.subject.id,
      sourceDigest: value.subject.sourceDigest,
      subjectDigest: value.subject.subjectDigest,
    },
    targets: ["claude"],
    allowedEffects: ["configure"],
    integration: { mode: "upstream-managed", owner: "upstream-admin", version: "1.0.0" } as const,
    installed: { id: "platform-review-tool", digest: `sha256:${"d".repeat(64)}` },
    verifier: { id: "upstream-admin", version: "1.0.0", digest: `sha256:${"f".repeat(64)}` },
    observedAt: "2026-08-02T00:00:00+00:00",
    validUntil: "2026-08-03T00:00:00+00:00",
    outcome: "observed-success",
  };
}

describe("OrganizationEvidenceEnvelopeV1", () => {
  it("requires canonical bounded evidence bytes and rejects hostile substitutions", () => {
    const value = decision();
    const valid = envelope(value);
    const bytes = canonicalBytes(valid);
    expect(parseOrganizationEvidenceEnvelopeV1Bytes(bytes)).toEqual(valid);
    expect(parseOrganizationEvidenceEnvelopeV1Bytes(bytes)?.attestor).toBe("scanner-service");
    expect(organizationEvidenceEnvelopeDigestV1(valid as never)).toMatch(/^sha256:[0-9a-f]{64}$/);

    for (const invalid of [
      Buffer.from(JSON.stringify(valid)),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
      Buffer.concat([Buffer.from(" "), bytes]),
      Buffer.concat([bytes, Buffer.from("\n")]),
      Buffer.from(canonicalOrganizationEvidenceEnvelopeV1({ ...valid, unexpected: true } as never)),
      canonicalBytes({ ...valid, evidence: { ...valid.evidence, payloadDigest: "not-a-digest" } }),
      canonicalBytes({ ...valid, evidence: { ...valid.evidence, artifactDigests: [] } }),
      canonicalBytes({
        ...valid,
        evidence: {
          ...valid.evidence,
          artifactDigests: [`sha256:${"2".repeat(64)}`, `sha256:${"2".repeat(64)}`],
        },
      }),
      canonicalBytes({
        ...valid,
        evidence: {
          ...valid.evidence,
          artifactDigests: [`sha256:${"3".repeat(64)}`, `sha256:${"2".repeat(64)}`],
        },
      }),
      canonicalBytes({
        ...valid,
        evidence: {
          ...valid.evidence,
          artifactDigests: Array.from(
            { length: 17 },
            (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`,
          ),
        },
      }),
      canonicalBytes({ ...valid, evidence: { ...valid.evidence, summary: " ".repeat(501) } }),
      canonicalBytes({ ...valid, issuedAt: "not-a-timestamp" }),
      canonicalBytes({ ...valid, issuedAt: "2026-08-02T00:00:00+00:00" }),
      canonicalBytes({ ...valid, expiresAt: "2027-01-01T00:00:00+00:00" }),
    ]) {
      expect(parseOrganizationEvidenceEnvelopeV1Bytes(invalid)).toBeUndefined();
    }
    const maximumShape = canonicalBytes({
      ...valid,
      subjectDigest: `sha256:${"a".repeat(64)}`,
      attestor: "a".repeat(256),
      issuedAt: "9999-01-01T00:00:00.000+00:00",
      notBefore: "9999-01-01T00:00:00.000+00:00",
      expiresAt: "9999-03-31T00:00:00.000+00:00",
      evidence: {
        kind: "k".repeat(64),
        id: "i".repeat(64),
        summary: "x".repeat(500),
        payloadDigest: `sha256:${"b".repeat(64)}`,
        artifactDigests: Array.from(
          { length: 16 },
          (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`,
        ),
      },
    });
    expect(maximumShape.byteLength).toBeLessThanOrEqual(
      MAX_ORGANIZATION_EVIDENCE_ENVELOPE_BYTES_V1,
    );
    expect(parseOrganizationEvidenceEnvelopeV1Bytes(maximumShape)).toBeDefined();
    expect(
      parseOrganizationEvidenceEnvelopeV1Bytes(
        Buffer.alloc(MAX_ORGANIZATION_EVIDENCE_ENVELOPE_BYTES_V1 + 1),
      ),
    ).toBeUndefined();
  });

  it("mints opaque qualification only for a current V3 organization-qualified decision", async () => {
    const value = qualifiedDecision();
    const verifiedAuthority = await authority(value);
    expect(isVerifiedPolicyAuthority(verifiedAuthority)).toBe(true);
    const evidence = envelope(value);
    const input = {
      authority: verifiedAuthority,
      decisionReference: { id: value.id, digest: governanceDecisionDigestV2(value as never) },
      bytes: canonicalBytes(evidence),
      subject: value.subject,
      target: "claude",
      effect: "configure" as const,
      supportedTargets: ["claude"],
      now: "2026-08-02T12:00:00+00:00",
    };

    const verified = verifyOrganizationQualificationV1(input);
    expect(verified).toBeDefined();
    if (verified === undefined) throw new Error("expected verified qualification");
    expect(isVerifiedQualificationV1(verified)).toBe(true);
    expect(verified).not.toHaveProperty("envelope");
    expect(verified).not.toHaveProperty("attestor");
    expect(isVerifiedQualificationV1({ ...verified })).toBe(false);
    expect(isVerifiedQualificationV1(structuredClone(verified))).toBe(false);

    for (const changed of [
      { ...evidence, attestor: "other-attestor" },
      { ...evidence, evidence: { ...evidence.evidence, id: "other-evidence" } },
      {
        ...evidence,
        evidence: { ...evidence.evidence, payloadDigest: `sha256:${"3".repeat(64)}` },
      },
      {
        ...evidence,
        evidence: {
          ...evidence.evidence,
          artifactDigests: [`sha256:${"4".repeat(64)}`],
        },
      },
      { ...evidence, subjectDigest: `sha256:${"0".repeat(64)}` },
      { ...evidence, expiresAt: "2026-08-02T12:00:00+00:00" },
    ]) {
      expect(
        verifyOrganizationQualificationV1({ ...input, bytes: canonicalBytes(changed) }),
      ).toBeUndefined();
    }
    for (const changed of [
      { target: "codex" },
      { effect: "use" as const },
      { supportedTargets: ["codex"] },
    ]) {
      expect(verifyOrganizationQualificationV1({ ...input, ...changed })).toBeUndefined();
    }
  });

  it("accepts a bounded organization-defined evidence kind without a Core allowlist", async () => {
    const base = decision();
    const customEvidence = envelope(base, {
      evidence: { ...envelope(base).evidence, kind: "vendor-posture-report" },
    });
    const evidenceDigest = organizationEvidenceEnvelopeDigestV1(customEvidence as never);
    const value = decision({
      qualificationBasis: {
        kind: "organization-qualified",
        evidenceDigest,
        attestor: customEvidence.attestor,
      },
      evidence: {
        id: customEvidence.evidence.id,
        digest: evidenceDigest,
        attestor: customEvidence.attestor,
      },
    });
    const verifiedAuthority = await authority(value);

    expect(
      verifyOrganizationQualificationV1({
        authority: verifiedAuthority,
        decisionReference: { id: value.id, digest: governanceDecisionDigestV2(value as never) },
        bytes: canonicalBytes(customEvidence),
        subject: value.subject,
        target: "claude",
        effect: "configure",
        supportedTargets: ["claude"],
        now: "2026-08-02T12:00:00+00:00",
      }),
    ).toBeDefined();
  });

  it("requires the opaque organization qualification before an observed effect and never performs it", async () => {
    const value = qualifiedDecision();
    const other = qualifiedDecisionForOtherSubject();
    const verifiedAuthority = await authority(value, other);
    const currentObservation = observation(value);
    const verifiedObservation = verifyUpstreamObservationV1({
      receipt: currentObservation,
      expectedVerifier: currentObservation.verifier,
      expectedInstalled: currentObservation.installed,
      expectedIntegration: currentObservation.integration,
      subject: value.subject,
      target: "claude",
      effect: "configure",
      supportedTargets: ["claude"],
      now: "2026-08-02T12:00:00+00:00",
      verify: () => true,
    });
    if (verifiedObservation === undefined) throw new Error("expected verified observation");
    const input = {
      authority: verifiedAuthority,
      decisionReference: { id: value.id, digest: governanceDecisionDigestV2(value as never) },
      observation: verifiedObservation,
      subject: value.subject,
      target: "claude",
      effect: "configure" as const,
      supportedTargets: ["claude"],
      expectedVerifier: currentObservation.verifier,
      expectedInstalled: currentObservation.installed,
      expectedIntegration: currentObservation.integration,
      now: "2026-08-02T12:00:00+00:00",
    };

    expect(resolveObservedEffect(input)).toMatchObject({ state: "qualification-missing" });
    expect(resolveObservedEffect({ ...input, qualification: {} })).toMatchObject({
      state: "qualification-unverified",
    });

    const qualification = verifyOrganizationQualificationV1({
      authority: verifiedAuthority,
      decisionReference: input.decisionReference,
      bytes: canonicalBytes(envelope(value)),
      subject: value.subject,
      target: input.target,
      effect: input.effect,
      supportedTargets: input.supportedTargets,
      now: input.now,
    });
    expect(qualification).toBeDefined();
    expect(resolveObservedEffect({ ...input, qualification })).toEqual({
      state: "observed-effective",
      decisionDigest: input.decisionReference.digest,
    });
    expect(resolveObservedEffect({ ...input, qualification: { ...qualification } })).toMatchObject({
      state: "qualification-unverified",
    });

    const otherQualification = verifyOrganizationQualificationV1({
      authority: verifiedAuthority,
      decisionReference: { id: other.id, digest: governanceDecisionDigestV2(other as never) },
      bytes: canonicalBytes(envelope(other)),
      subject: other.subject,
      target: input.target,
      effect: input.effect,
      supportedTargets: input.supportedTargets,
      now: input.now,
    });
    expect(otherQualification).toBeDefined();
    expect(resolveObservedEffect({ ...input, qualification: otherQualification })).toMatchObject({
      state: "qualification-mismatch",
    });
    expect(
      resolveObservedEffect({ ...input, qualification, now: "2026-08-03T00:00:00+00:00" }),
    ).toMatchObject({ state: "observation-stale" });
  });

  it("refuses a qualification token after its authority receipt is substituted", async () => {
    const value = qualifiedDecision();
    const other = qualifiedDecisionForOtherSubject();
    const mintingAuthority = await authority(value);
    const replacementAuthority = await authority(value, other);
    expect(replacementAuthority.receiptDigest).not.toBe(mintingAuthority.receiptDigest);

    const currentObservation = observation(value);
    const verifiedObservation = verifyUpstreamObservationV1({
      receipt: currentObservation,
      expectedVerifier: currentObservation.verifier,
      expectedInstalled: currentObservation.installed,
      expectedIntegration: currentObservation.integration,
      subject: value.subject,
      target: "claude",
      effect: "configure",
      supportedTargets: ["claude"],
      now: "2026-08-02T12:00:00+00:00",
      verify: () => true,
    });
    if (verifiedObservation === undefined) throw new Error("expected verified observation");

    const qualification = verifyOrganizationQualificationV1({
      authority: mintingAuthority,
      decisionReference: { id: value.id, digest: governanceDecisionDigestV2(value as never) },
      bytes: canonicalBytes(envelope(value)),
      subject: value.subject,
      target: "claude",
      effect: "configure",
      supportedTargets: ["claude"],
      now: "2026-08-02T12:00:00+00:00",
    });
    expect(qualification).toBeDefined();

    expect(
      resolveObservedEffect({
        authority: replacementAuthority,
        decisionReference: { id: value.id, digest: governanceDecisionDigestV2(value as never) },
        qualification,
        observation: verifiedObservation,
        subject: value.subject,
        target: "claude",
        effect: "configure",
        supportedTargets: ["claude"],
        expectedVerifier: currentObservation.verifier,
        expectedInstalled: currentObservation.installed,
        expectedIntegration: currentObservation.integration,
        now: "2026-08-02T12:00:00+00:00",
      }),
    ).toMatchObject({ state: "qualification-mismatch" });
  });

  it("refuses a qualification token after its evidence expires before observation", async () => {
    const value = qualifiedDecisionWithEnvelope({ expiresAt: "2026-08-02T13:00:00+00:00" });
    const verifiedAuthority = await authority(value);
    const currentObservation = observation(value);
    const verifiedObservation = verifyUpstreamObservationV1({
      receipt: currentObservation,
      expectedVerifier: currentObservation.verifier,
      expectedInstalled: currentObservation.installed,
      expectedIntegration: currentObservation.integration,
      subject: value.subject,
      target: "claude",
      effect: "configure",
      supportedTargets: ["claude"],
      now: "2026-08-02T12:00:00+00:00",
      verify: () => true,
    });
    if (verifiedObservation === undefined) throw new Error("expected verified observation");

    const qualification = verifyOrganizationQualificationV1({
      authority: verifiedAuthority,
      decisionReference: { id: value.id, digest: governanceDecisionDigestV2(value as never) },
      bytes: canonicalBytes(envelope(value, { expiresAt: "2026-08-02T13:00:00+00:00" })),
      subject: value.subject,
      target: "claude",
      effect: "configure",
      supportedTargets: ["claude"],
      now: "2026-08-02T12:00:00+00:00",
    });
    expect(qualification).toBeDefined();

    expect(
      resolveObservedEffect({
        authority: verifiedAuthority,
        decisionReference: { id: value.id, digest: governanceDecisionDigestV2(value as never) },
        qualification,
        observation: verifiedObservation,
        subject: value.subject,
        target: "claude",
        effect: "configure",
        supportedTargets: ["claude"],
        expectedVerifier: currentObservation.verifier,
        expectedInstalled: currentObservation.installed,
        expectedIntegration: currentObservation.integration,
        now: "2026-08-02T14:00:00+00:00",
      }),
    ).toMatchObject({ state: "qualification-mismatch" });
  });

  it("refuses aih-supported provenance and refuses a token rewound before its validity window", async () => {
    const unsupported = unsupportedDecision();
    const unsupportedAuthority = await authority(unsupported);
    const unsupportedObservation = observation(unsupported);
    expect(
      resolveObservedEffect({
        authority: unsupportedAuthority,
        decisionReference: {
          id: unsupported.id,
          digest: governanceDecisionDigestV2(unsupported as never),
        },
        observation: undefined,
        subject: unsupported.subject,
        target: "claude",
        effect: "configure",
        supportedTargets: ["claude"],
        expectedVerifier: unsupportedObservation.verifier,
        expectedInstalled: unsupportedObservation.installed,
        expectedIntegration: unsupportedObservation.integration,
        now: "2026-08-02T12:00:00+00:00",
      }),
    ).toMatchObject({ state: "qualification-mismatch" });

    const bounded = qualifiedDecisionWithEnvelope({ notBefore: "2026-08-02T12:00:00+00:00" });
    const boundedAuthority = await authority(bounded);
    const qualification = verifyOrganizationQualificationV1({
      authority: boundedAuthority,
      decisionReference: { id: bounded.id, digest: governanceDecisionDigestV2(bounded as never) },
      bytes: canonicalBytes(envelope(bounded, { notBefore: "2026-08-02T12:00:00+00:00" })),
      subject: bounded.subject,
      target: "claude",
      effect: "configure",
      supportedTargets: ["claude"],
      now: "2026-08-02T12:00:00+00:00",
    });
    const boundedObservation = observation(bounded);
    expect(
      resolveObservedEffect({
        authority: boundedAuthority,
        decisionReference: { id: bounded.id, digest: governanceDecisionDigestV2(bounded as never) },
        qualification,
        subject: bounded.subject,
        target: "claude",
        effect: "configure",
        supportedTargets: ["claude"],
        expectedVerifier: boundedObservation.verifier,
        expectedInstalled: boundedObservation.installed,
        expectedIntegration: boundedObservation.integration,
        now: "2026-08-02T11:59:59+00:00",
      }),
    ).toMatchObject({ state: "qualification-mismatch" });
  });
});
