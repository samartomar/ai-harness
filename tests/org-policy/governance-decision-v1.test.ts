import { describe, expect, it } from "vitest";
import {
  canonicalGovernanceDecisionRevocationV1,
  canonicalGovernanceDecisionV1,
  governanceDecisionDigestV1,
  governanceDecisionRevocationDigestV1,
  parseGovernanceDecisionRevocationV1,
  parseGovernanceDecisionV1,
} from "../../src/org-policy/governance-decision-v1.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function accepted(overrides: Record<string, unknown> = {}) {
  return {
    format: "aih-governance-decision",
    version: 1,
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

  it("pins domain-separated canonical byte and digest vectors independent of input key order", () => {
    const input = accepted();
    const decision = parseGovernanceDecisionV1(input);
    const permuted = parseGovernanceDecisionV1(Object.fromEntries(Object.entries(input).reverse()));
    const revocation = parseGovernanceDecisionRevocationV1({
      format: "aih-governance-decision-revocation",
      version: 1,
      decision: "decision-managed-mcp",
      issuer: "platform-security",
      revokedAt: "2026-08-02T00:00:00+00:00",
      reason: "The control no longer satisfies the review conditions.",
    });
    expect(canonicalGovernanceDecisionV1(decision)).toBe(
      '{"acceptedFindings":["prompt-injection"],"acceptedGaps":["evidence-gap"],"actor":"security-admin","candidate":"catalog-mcp","conditions":["Use the managed settings projector only."],"disposition":"accepted-with-conditions","effects":["managed-settings"],"evidenceDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expiresAt":"2026-08-31T00:00:00+00:00","format":"aih-governance-decision","id":"decision-managed-mcp","issuedAt":"2026-08-01T00:00:00+00:00","issuer":"platform-security","kind":"mcp","notBefore":"2026-08-01T00:00:00+00:00","policyVersion":"2026.08.0","reason":"Reviewed residual risk has bounded controls.","reviewBy":"2026-08-15T00:00:00+00:00","reviewedControlDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sourceDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","targets":["claude"],"version":1}',
    );
    expect(governanceDecisionDigestV1(decision)).toBe(
      "sha256:5706767eff1a25fca028ee6604695697d6c3176fba9091b470480c2f7a090a98",
    );
    expect(canonicalGovernanceDecisionV1(permuted)).toBe(canonicalGovernanceDecisionV1(decision));
    expect(governanceDecisionDigestV1(permuted)).toBe(governanceDecisionDigestV1(decision));
    expect(canonicalGovernanceDecisionRevocationV1(revocation)).toBe(
      '{"decision":"decision-managed-mcp","format":"aih-governance-decision-revocation","issuer":"platform-security","reason":"The control no longer satisfies the review conditions.","revokedAt":"2026-08-02T00:00:00+00:00","version":1}',
    );
    expect(governanceDecisionRevocationDigestV1(revocation)).toBe(
      "sha256:ebdcb7c071b07464c2e79fb86ed1042d1830ef6561055a2420dd8064932b2afb",
    );
    expect(canonicalGovernanceDecisionV1(decision)).not.toBe(
      canonicalGovernanceDecisionRevocationV1(revocation),
    );
  });

  it.each([
    ["inline revoked state", { disposition: "revoked" }],
    ["approval id", { id: "approval-managed-mcp" }],
    ["unqualified timestamp", { issuedAt: "2026-08-01T00:00:00" }],
    ["invalid calendar timestamp", { issuedAt: "2026-02-30T00:00:00+00:00" }],
    ["overlong validity", { expiresAt: "2026-11-01T00:00:00+00:00" }],
    ["unsorted coverage", { acceptedFindings: ["secrets", "prompt-injection"] }],
    ["duplicate coverage", { acceptedFindings: ["prompt-injection", "prompt-injection"] }],
    ["overlapping coverage", { acceptedGaps: ["prompt-injection"] }],
    ["missing conditions", { conditions: [] }],
    ["empty targets", { targets: [] }],
    ["empty effects", { effects: [] }],
    ["trimmed text", { reason: " trailing" }],
    ["control text", { reason: "unsafe\ntext" }],
    ["uppercase identifier", { candidate: "Catalog-mcp" }],
    ["overlong identifier", { candidate: `a${"a".repeat(64)}` }],
    ["unknown field", { unexpected: true }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => parseGovernanceDecisionV1(accepted(overrides))).toThrow();
  });

  it("allows approved only with empty coverage and no conditions", () => {
    const clean = accepted();
    delete (clean as Record<string, unknown>).reviewBy;
    expect(() =>
      parseGovernanceDecisionV1({
        ...clean,
        disposition: "approved",
        acceptedFindings: [],
        acceptedGaps: [],
        conditions: [],
      }),
    ).not.toThrow();
    expect(() => parseGovernanceDecisionV1(accepted({ disposition: "approved" }))).toThrow();
    expect(() =>
      parseGovernanceDecisionV1({
        ...clean,
        disposition: "approved",
        reviewBy: "2026-08-15T00:00:00+00:00",
      }),
    ).toThrow();
  });

  it.each([
    ["findings only", { acceptedGaps: [] }],
    ["gaps only", { acceptedFindings: [] }],
  ])("allows accepted coverage with %s", (_label, overrides) => {
    expect(() => parseGovernanceDecisionV1(accepted(overrides))).not.toThrow();
  });

  it("rejects accepted decisions with no findings or gaps", () => {
    expect(() =>
      parseGovernanceDecisionV1(accepted({ acceptedFindings: [], acceptedGaps: [] })),
    ).toThrow();
  });

  it("allows rejected records only with empty coverage and conditions", () => {
    const rejected = accepted();
    delete (rejected as Record<string, unknown>).reviewBy;
    expect(() =>
      parseGovernanceDecisionV1({
        ...rejected,
        disposition: "rejected",
        acceptedFindings: [],
        acceptedGaps: [],
        conditions: [],
      }),
    ).not.toThrow();
    expect(() => parseGovernanceDecisionV1({ ...rejected, disposition: "rejected" })).toThrow();
    expect(() =>
      parseGovernanceDecisionV1({
        ...rejected,
        disposition: "rejected",
        reviewBy: "2026-08-15T00:00:00+00:00",
      }),
    ).toThrow();
  });

  it.each([
    ["notBefore before issuedAt", { notBefore: "2026-07-31T00:00:00+00:00" }],
    ["expiresAt at notBefore", { expiresAt: "2026-08-01T00:00:00+00:00" }],
    ["reviewBy before notBefore", { reviewBy: "2026-07-31T00:00:00+00:00" }],
    ["reviewBy after expiresAt", { reviewBy: "2026-09-01T00:00:00+00:00" }],
  ])("rejects invalid decision ordering: %s", (_label, overrides) => {
    expect(() => parseGovernanceDecisionV1(accepted(overrides))).toThrow();
  });

  it("uses ordinal ordering for non-ASCII canonical condition bytes", () => {
    const decision = parseGovernanceDecisionV1(
      accepted({ conditions: ["a condition", "ä condition"] }),
    );
    expect(canonicalGovernanceDecisionV1(decision)).toContain(
      '"conditions":["a condition","ä condition"]',
    );
  });

  it("parses only separately signed decision revocations", () => {
    const revocation = parseGovernanceDecisionRevocationV1({
      format: "aih-governance-decision-revocation",
      version: 1,
      decision: "decision-managed-mcp",
      issuer: "platform-security",
      revokedAt: "2026-08-02T00:00:00+00:00",
      reason: "The control no longer satisfies the review conditions.",
    });
    expect(revocation).toMatchObject({ decision: "decision-managed-mcp" });
    expect(canonicalGovernanceDecisionRevocationV1(revocation)).toContain(
      '"decision":"decision-managed-mcp"',
    );
    expect(governanceDecisionRevocationDigestV1(revocation)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ["non-decision id", { decision: "approval-managed-mcp" }],
    ["unknown field", { extra: true }],
    ["unqualified timestamp", { revokedAt: "2026-08-02T00:00:00" }],
    ["impossible timestamp", { revokedAt: "2026-02-30T00:00:00+00:00" }],
  ])("rejects invalid revocation: %s", (_label, overrides) => {
    expect(() =>
      parseGovernanceDecisionRevocationV1({
        format: "aih-governance-decision-revocation",
        version: 1,
        decision: "decision-managed-mcp",
        issuer: "platform-security",
        revokedAt: "2026-08-02T00:00:00+00:00",
        reason: "The control no longer satisfies the review conditions.",
        ...overrides,
      }),
    ).toThrow();
  });

  it("uses proleptic Gregorian leap years for offset-qualified revocations", () => {
    expect(() =>
      parseGovernanceDecisionRevocationV1({
        format: "aih-governance-decision-revocation",
        version: 1,
        decision: "decision-managed-mcp",
        issuer: "platform-security",
        revokedAt: "0000-02-29T00:00:00+00:00",
        reason: "A valid low-year leap date remains valid.",
      }),
    ).not.toThrow();
    expect(() =>
      parseGovernanceDecisionRevocationV1({
        format: "aih-governance-decision-revocation",
        version: 1,
        decision: "decision-managed-mcp",
        issuer: "platform-security",
        revokedAt: "0099-02-29T00:00:00+00:00",
        reason: "A non-leap low-year date must fail closed.",
      }),
    ).toThrow();
  });
});
