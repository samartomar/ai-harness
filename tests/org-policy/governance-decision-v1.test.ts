import { describe, expect, it } from "vitest";
import {
  canonicalGovernanceDecisionV1,
  governanceDecisionDigestV1,
  parseGovernanceDecisionRevocationV1,
  parseGovernanceDecisionV1,
} from "../../src/org-policy/governance-decision-v1.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function accepted(overrides: Record<string, unknown> = {}) {
  return {
    id: "decision-managed-mcp",
    disposition: "accepted-with-conditions",
    candidate: "catalog-mcp",
    kind: "mcp",
    targets: ["claude"],
    effects: ["managed-settings"],
    policyVersion: "2026.08.0",
    sourceDigest: DIGEST,
    evidenceDigest: DIGEST,
    reviewedControlDigest: DIGEST,
    issuer: "platform-security",
    actor: "security-admin",
    reason: "Reviewed residual risk has bounded controls.",
    issuedAt: "2026-08-01T00:00:00+00:00",
    notBefore: "2026-08-01T00:00:00+00:00",
    expiresAt: "2026-08-31T00:00:00+00:00",
    reviewBy: "2026-08-15T00:00:00+00:00",
    acceptedFindings: ["prompt-injection"],
    acceptedGaps: ["evidence-gap"],
    conditions: ["Use the managed settings projector only."],
    ...overrides,
  };
}

describe("GovernanceDecisionV1", () => {
  it("canonicalizes an accepted decision to deterministic bytes and digest", () => {
    const decision = parseGovernanceDecisionV1(accepted());
    expect(canonicalGovernanceDecisionV1(decision)).toBe(
      canonicalGovernanceDecisionV1(parseGovernanceDecisionV1(accepted())),
    );
    expect(governanceDecisionDigestV1(decision)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ["inline revoked state", { disposition: "revoked" }],
    ["approval id", { id: "approval-managed-mcp" }],
    ["unqualified timestamp", { issuedAt: "2026-08-01T00:00:00" }],
    ["overlong validity", { expiresAt: "2026-11-01T00:00:00+00:00" }],
    ["unsorted coverage", { acceptedFindings: ["secrets", "prompt-injection"] }],
    ["duplicate coverage", { acceptedFindings: ["prompt-injection", "prompt-injection"] }],
    ["missing conditions", { conditions: [] }],
    ["unknown field", { unexpected: true }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => parseGovernanceDecisionV1(accepted(overrides))).toThrow();
  });

  it("allows approved only with empty coverage and no conditions", () => {
    expect(() =>
      parseGovernanceDecisionV1(
        accepted({
          disposition: "approved",
          acceptedFindings: [],
          acceptedGaps: [],
          conditions: [],
          reviewBy: undefined,
        }),
      ),
    ).not.toThrow();
    expect(() => parseGovernanceDecisionV1(accepted({ disposition: "approved" }))).toThrow();
  });

  it("parses only separately signed decision revocations", () => {
    expect(
      parseGovernanceDecisionRevocationV1({
        decision: "decision-managed-mcp",
        issuer: "platform-security",
        revokedAt: "2026-08-02T00:00:00+00:00",
        reason: "The control no longer satisfies the review conditions.",
      }),
    ).toMatchObject({ decision: "decision-managed-mcp" });
  });
});
