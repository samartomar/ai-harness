import { describe, expect, it } from "vitest";
import {
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
  PolicyAuthorityReceiptV3Schema,
} from "../../src/index.js";

// The published @aihq/catalog identity for agent.aih.governance-quality. Core
// derives both digests rather than trusting the index's copies.
const source = {
  type: "aih" as const,
  release: "0.6.0",
  revision: "sha256:32ce6e9dea74ba84fe56b71ba6516e032f18aa4132e6ef7ebca507512d8735f7",
};
const sourceDigest = governanceDecisionSourceDigestV2(source);
const subjectDigest = governanceDecisionSubjectDigestV2({
  kind: "agent",
  id: "governance-quality",
  sourceDigest,
});
const evidenceDigest = `sha256:${"d".repeat(64)}`;
const attestor = "test-organization";

const decision = {
  format: "aih-governance-decision" as const,
  version: 2 as const,
  id: "decision-observe-governance-quality",
  disposition: "approved" as const,
  qualificationBasis: { kind: "organization-qualified" as const, evidenceDigest, attestor },
  subject: {
    kind: "agent" as const,
    id: "governance-quality",
    source,
    sourceDigest,
    subjectDigest,
  },
  targets: ["claude"],
  allowedEffects: ["observe"],
  policy: { id: "test-policy", version: "1", digest: `sha256:${"e".repeat(64)}` },
  control: { id: "test-control", digest: `sha256:${"f".repeat(64)}` },
  evidence: { id: "scanner-evidence-v2", digest: evidenceDigest, attestor },
  issuer: "test-issuer",
  actor: "test-operator",
  reason: "Validation example only; operator-provided authority, not production approval.",
  issuedAt: "2026-09-20T00:00:00.000Z",
  notBefore: "2026-09-20T00:00:00.000Z",
  expiresAt: "2026-09-27T00:00:00.000Z",
  acceptedFindings: [],
  acceptedGaps: [],
  conditions: [],
};

const receipt = {
  format: "aih-policy-authority-receipt" as const,
  version: 3 as const,
  issuerRepository: "example-org/policy-authority",
  issuedAt: "2026-09-20T00:00:00.000Z",
  expiresAt: "2026-09-27T00:00:00.000Z",
  trustedIssuers: [{ id: "test-issuer", githubRepository: "example-org/policy-authority" }],
  targets: ["claude"],
  decisions: [decision],
  decisionRevocations: [],
};

describe("public policy authority receipt V3 schema", () => {
  it("parses a V3 receipt whose decision binds Core-derived subject digests", () => {
    const parsed = PolicyAuthorityReceiptV3Schema.parse(receipt);
    expect(parsed.decisions[0]?.subject.sourceDigest).toBe(sourceDigest);
    expect(parsed.decisions[0]?.subject.subjectDigest).toBe(subjectDigest);
  });

  it("fails closed on an unknown version and on a decision outside receipt scope", () => {
    expect(PolicyAuthorityReceiptV3Schema.safeParse({ ...receipt, version: 4 }).success).toBe(
      false,
    );
    expect(
      PolicyAuthorityReceiptV3Schema.safeParse({
        ...receipt,
        decisions: [{ ...decision, targets: ["codex"] }],
      }).success,
    ).toBe(false);
    expect(
      PolicyAuthorityReceiptV3Schema.safeParse({
        ...receipt,
        trustedIssuers: [{ id: "other-issuer", githubRepository: "example-org/policy-authority" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a subject digest the caller asserts instead of deriving", () => {
    expect(
      PolicyAuthorityReceiptV3Schema.safeParse({
        ...receipt,
        decisions: [
          {
            ...decision,
            subject: { ...decision.subject, subjectDigest: `sha256:${"0".repeat(64)}` },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
