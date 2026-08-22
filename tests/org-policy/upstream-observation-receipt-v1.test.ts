import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { governanceDecisionDigestV2 } from "../../src/org-policy/governance-decision-v2.js";
import {
  resolveObservedEffect,
  UpstreamObservationReceiptV1Schema,
  upstreamObservationReceiptDigestV1,
} from "../../src/org-policy/upstream-observation-receipt-v1.js";

const root = join(import.meta.dirname, "../..");

function decision(overrides: Record<string, unknown> = {}) {
  return {
    format: "aih-governance-decision",
    version: 2,
    id: "decision-platform-tool",
    qualification: "organization-qualified",
    subject: {
      kind: "tool",
      id: "platform-review-tool",
      source: {
        type: "github",
        repository: "acme/review-tool",
        commit: "a".repeat(40),
        path: "tool.json",
      },
      sourceDigest: `sha256:${"a".repeat(64)}`,
      subjectDigest: `sha256:${"b".repeat(64)}`,
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

function observation(overrides: Record<string, unknown> = {}) {
  const value = decision();
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
    installed: { id: "platform-review-tool", digest: `sha256:${"d".repeat(64)}` },
    verifier: { id: "upstream-admin", version: "1.0.0", digest: `sha256:${"f".repeat(64)}` },
    observedAt: "2026-08-02T00:00:00+00:00",
    validUntil: "2026-08-04T00:00:00+00:00",
    outcome: "observed-success",
    ...overrides,
  };
}

describe("UpstreamObservationReceiptV1 public contract", () => {
  it("publishes a strict observation schema that does not turn approval into effective state", () => {
    const schema = JSON.parse(
      readFileSync(join(root, "schemas/aih-upstream-observation-receipt-v1.schema.json"), "utf8"),
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const valid = observation();
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    for (const invalid of [
      { ...valid, id: "not-an-observation" },
      { ...valid, verifier: { id: "upstream-admin", version: "latest" } },
      { ...valid, approved: true },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
    for (const outcome of ["partial", "refused", "drifted", "revoked"] as const) {
      expect(validate({ ...valid, outcome }), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("requires an exact approved decision and successful matching observation", () => {
    const currentDecision = decision();
    const currentObservation = observation();
    const input = {
      decision: currentDecision,
      observation: currentObservation,
      subject: currentDecision.subject as never,
      target: "claude" as const,
      effect: "configure" as const,
      supportedTargets: ["claude"],
      expectedVerifier: currentObservation.verifier,
      now: "2026-08-03T00:00:00+00:00",
    };
    expect(resolveObservedEffect(input)).toMatchObject({ state: "observed-effective" });
    expect(
      upstreamObservationReceiptDigestV1(
        UpstreamObservationReceiptV1Schema.parse(currentObservation),
      ),
    ).toBe(
      upstreamObservationReceiptDigestV1(
        UpstreamObservationReceiptV1Schema.parse(structuredClone(currentObservation)),
      ),
    );
    for (const [expected, changed] of [
      ["observation-missing", { ...input, observation: undefined }],
      ["observation-unsuccessful", { ...input, observation: observation({ outcome: "partial" }) }],
      [
        "observation-mismatch",
        {
          ...input,
          observation: observation({
            decision: { id: currentDecision.id, digest: `sha256:${"0".repeat(64)}` },
          }),
        },
      ],
      [
        "observation-mismatch",
        {
          ...input,
          observation: observation({
            verifier: { ...currentObservation.verifier, version: "2.0.0" },
          }),
        },
      ],
      ["decision-rejected", { ...input, decision: decision({ disposition: "rejected" }) }],
      ["decision-scope-mismatch", { ...input, effect: "use" as const }],
      ["decision-not-current", { ...input, now: "2026-08-11T00:00:00+00:00" }],
      ["observation-stale", { ...input, now: "2026-08-04T00:00:00+00:00" }],
      [
        "decision-revoked",
        {
          ...input,
          revocation: {
            format: "aih-governance-decision-revocation",
            version: 2,
            decisionDigest: governanceDecisionDigestV2(currentDecision as never),
            issuer: currentDecision.issuer,
            revokedAt: "2026-08-02T00:00:00+00:00",
            reason: "Withdrawn.",
          },
        },
      ],
      ["decision-revocation-invalid", { ...input, revocation: { decisionDigest: "bad" } }],
    ] as const) {
      expect(resolveObservedEffect(changed as never)).toMatchObject({ state: expected });
    }
  });
});
