import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  isVerifiedOrganizationQualificationV1,
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
  dir = mkdtempSync(join(tmpdir(), "aih-organization-qualification-"));
  authorityBin = mkdtempSync(join(tmpdir(), "aih-organization-qualification-gh-"));
  const gh = join(authorityBin, process.platform === "win32" ? "gh.exe" : "gh");
  writeFileSync(gh, "trusted gh fixture\n", { mode: 0o755 });
  trustedGh = realpathSync.native(gh);
});

afterEach(() => {
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
      kind: "tool",
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
      artifactDigest: `sha256:${"2".repeat(64)}`,
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

async function authority(value: ReturnType<typeof decision>) {
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
      decisions: [value],
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
    expect(organizationEvidenceEnvelopeDigestV1(valid as never)).toMatch(/^sha256:[0-9a-f]{64}$/);

    for (const invalid of [
      Buffer.from(JSON.stringify(valid)),
      Buffer.from(canonicalOrganizationEvidenceEnvelopeV1({ ...valid, unexpected: true } as never)),
      canonicalBytes({ ...valid, subjectDigest: `sha256:${"0".repeat(64)}` }),
      canonicalBytes({ ...valid, evidence: { ...valid.evidence, payloadDigest: "not-a-digest" } }),
      canonicalBytes({ ...valid, issuedAt: "2026-08-02T00:00:00+00:00" }),
      canonicalBytes({ ...valid, expiresAt: "2027-01-01T00:00:00+00:00" }),
    ]) {
      expect(parseOrganizationEvidenceEnvelopeV1Bytes(invalid)).toBeUndefined();
    }
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
    expect(isVerifiedOrganizationQualificationV1(verified)).toBe(true);
    expect(verified).not.toHaveProperty("envelope");
    expect(isVerifiedOrganizationQualificationV1({ ...verified })).toBe(false);
    expect(isVerifiedOrganizationQualificationV1(structuredClone(verified))).toBe(false);

    for (const changed of [
      { ...evidence, attestor: "other-attestor" },
      { ...evidence, evidence: { ...evidence.evidence, id: "other-evidence" } },
      { ...evidence, subjectDigest: `sha256:${"0".repeat(64)}` },
      { ...evidence, expiresAt: "2026-08-02T12:00:00+00:00" },
    ]) {
      expect(
        verifyOrganizationQualificationV1({ ...input, bytes: canonicalBytes(changed) }),
      ).toBeUndefined();
    }
  });

  it("requires the opaque organization qualification before an observed effect and never performs it", async () => {
    const value = qualifiedDecision();
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
    expect(resolveObservedEffect({ ...input, qualification })).toMatchObject({
      state: "observed-effective",
    });
    expect(resolveObservedEffect({ ...input, qualification: { ...qualification } })).toMatchObject({
      state: "qualification-unverified",
    });
  });
});
