import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  governanceDecisionDigestV2,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "../../src/org-policy/governance-decision-v2.js";
import {
  MAX_UPSTREAM_OBSERVATION_WINDOW_MS,
  resolveObservedEffect,
  UpstreamObservationReceiptV1Schema,
  upstreamObservationReceiptDigestV1,
  verifyUpstreamObservationV1,
} from "../../src/org-policy/upstream-observation-receipt-v1.js";

const root = join(import.meta.dirname, "../..");

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
    integration: {
      mode: "upstream-managed",
      owner: "upstream-admin",
      version: "1.0.0",
    } as const,
    installed: { id: "platform-review-tool", digest: `sha256:${"d".repeat(64)}` },
    verifier: { id: "upstream-admin", version: "1.0.0", digest: `sha256:${"f".repeat(64)}` },
    observedAt: "2026-08-02T00:00:00+00:00",
    validUntil: "2026-08-03T00:00:00+00:00",
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
      {
        ...valid,
        integration: { mode: "upstream-managed", owner: "upstream-admin", version: "01.2.3" },
      },
      { ...valid, approved: true },
      { ...valid, integration: { mode: "aih-managed", owner: "upstream-admin", version: "1.0.0" } },
      { ...valid, integration: { mode: "upstream-managed", version: "1.0.0" } },
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
      expectedInstalled: currentObservation.installed,
      expectedIntegration: currentObservation.integration,
      now: "2026-08-02T12:00:00+00:00",
    };
    // A schema-valid receipt is untrusted data. Only the code-owned observation
    // verifier may mint the opaque value accepted by the resolver.
    expect(resolveObservedEffect(input)).toMatchObject({ state: "authority-unverified" });
    const verified = verifyUpstreamObservationV1({
      ...input,
      receipt: currentObservation,
      verify: () => true,
    });
    expect(verified).toBeDefined();
    if (verified === undefined) throw new Error("expected verified observation");
    const effectiveInput = { ...input, observation: verified };
    expect(resolveObservedEffect(effectiveInput)).toMatchObject({ state: "authority-unverified" });
    expect(verified).not.toHaveProperty("receipt");
    expect(() => Object.assign(verified as object, { receipt: currentObservation })).toThrow();
    expect(resolveObservedEffect(effectiveInput)).toMatchObject({ state: "authority-unverified" });
    const callbackMutation = verifyUpstreamObservationV1({
      ...input,
      receipt: currentObservation,
      verify: (callbackReceipt) => {
        try {
          callbackReceipt.installed.digest = `sha256:${"0".repeat(64)}`;
          callbackReceipt.targets.push("codex");
        } catch {
          // The callback gets an immutable detached snapshot.
        }
        return true;
      },
    });
    expect(callbackMutation).toBeDefined();
    expect(resolveObservedEffect({ ...input, observation: callbackMutation })).toMatchObject({
      state: "authority-unverified",
    });
    const registeredDecision = { ...currentDecision, targets: ["custom-host"] };
    const registeredObservation = observation({
      decision: {
        id: registeredDecision.id,
        digest: governanceDecisionDigestV2(registeredDecision as never),
      },
      targets: ["custom-host"],
    });
    const registeredVerified = verifyUpstreamObservationV1({
      ...input,
      receipt: registeredObservation,
      subject: registeredDecision.subject as never,
      target: "custom-host",
      supportedTargets: ["custom-host"],
      verify: () => true,
    });
    expect(registeredVerified).toBeDefined();
    expect(
      resolveObservedEffect({
        ...input,
        decision: registeredDecision,
        observation: registeredVerified,
        subject: registeredDecision.subject as never,
        target: "custom-host",
        supportedTargets: ["custom-host"],
      } as unknown as Parameters<typeof resolveObservedEffect>[0]),
    ).toMatchObject({ state: "authority-unverified" });
    for (const untrusted of [
      currentObservation,
      { ...verified },
      structuredClone(verified),
      { ...currentObservation, verifier: currentObservation.verifier, outcome: "observed-success" },
    ]) {
      expect(resolveObservedEffect({ ...input, observation: untrusted })).toMatchObject({
        state: "authority-unverified",
      });
    }
    expect(
      verifyUpstreamObservationV1({ ...input, receipt: currentObservation, verify: () => false }),
    ).toBeUndefined();
    expect(
      verifyUpstreamObservationV1({
        ...input,
        receipt: currentObservation,
        verify: (() => Promise.resolve(true)) as never,
      }),
    ).toBeUndefined();
    expect(
      verifyUpstreamObservationV1({
        ...input,
        receipt: currentObservation,
        expectedInstalled: { ...currentObservation.installed, digest: `sha256:${"0".repeat(64)}` },
        verify: () => true,
      }),
    ).toBeUndefined();
    expect(
      verifyUpstreamObservationV1({
        ...input,
        receipt: currentObservation,
        expectedIntegration: { ...currentObservation.integration, owner: "aih-materializer" },
        verify: () => true,
      }),
    ).toBeUndefined();
    const acceptedDecision = decision({
      disposition: "accepted-with-conditions",
      acceptedFindings: ["bounded-gap"],
      acceptedGaps: [],
      conditions: ["Revalidate before review deadline."],
      reviewBy: "2026-08-02T12:00:00+00:00",
    });
    const acceptedObservation = observation({
      decision: {
        id: acceptedDecision.id,
        digest: governanceDecisionDigestV2(acceptedDecision as never),
      },
    });
    const acceptedVerified = verifyUpstreamObservationV1({
      ...input,
      receipt: acceptedObservation,
      subject: acceptedDecision.subject as never,
      now: "2026-08-02T11:00:00+00:00",
      verify: () => true,
    });
    expect(
      resolveObservedEffect({
        ...input,
        decision: acceptedDecision,
        observation: acceptedVerified,
        subject: acceptedDecision.subject as never,
        now: "2026-08-02T12:00:00+00:00",
      } as unknown as Parameters<typeof resolveObservedEffect>[0]),
    ).toMatchObject({ state: "authority-unverified" });
    expect(
      upstreamObservationReceiptDigestV1(
        UpstreamObservationReceiptV1Schema.parse(currentObservation),
      ),
    ).toBe(
      upstreamObservationReceiptDigestV1(
        UpstreamObservationReceiptV1Schema.parse(structuredClone(currentObservation)),
      ),
    );
  });

  it("bounds live observation freshness at exactly 24 hours", () => {
    const base = observation();
    const observedAt = Date.parse(base.observedAt);
    expect(
      UpstreamObservationReceiptV1Schema.safeParse({
        ...base,
        validUntil: new Date(observedAt + MAX_UPSTREAM_OBSERVATION_WINDOW_MS - 1).toISOString(),
      }).success,
    ).toBe(true);
    expect(
      UpstreamObservationReceiptV1Schema.safeParse({
        ...base,
        validUntil: new Date(observedAt + MAX_UPSTREAM_OBSERVATION_WINDOW_MS).toISOString(),
      }).success,
    ).toBe(true);
    expect(
      UpstreamObservationReceiptV1Schema.safeParse({
        ...base,
        validUntil: new Date(observedAt + MAX_UPSTREAM_OBSERVATION_WINDOW_MS + 1).toISOString(),
      }).success,
    ).toBe(false);
    expect(
      verifyUpstreamObservationV1({
        receipt: observation({ observedAt: "2026-08-02T12:01:00+00:00" }),
        expectedVerifier: base.verifier,
        expectedInstalled: base.installed,
        expectedIntegration: base.integration,
        subject: decision().subject as never,
        target: "claude",
        effect: "configure",
        supportedTargets: ["claude"],
        now: "2026-08-02T12:00:00+00:00",
        verify: () => true,
      }),
    ).toBeUndefined();
  });
});
