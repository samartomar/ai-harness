import { describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import type { Check } from "../../src/internals/verify.js";
import { applyTrustAcknowledgements } from "../../src/trust/acknowledge.js";

// Minimal PlanContext for the acknowledgement engine: it only reads
// options.acknowledge / options.reason / options.acknowledgeAll and env.*.
function ctx(options: Record<string, unknown>): PlanContext {
  return { options, env: { USER: "reviewer" } } as unknown as PlanContext;
}

function metadataLicenseCheck(): Check {
  return {
    name: "trust.skill-metadata-license",
    verdict: "fail",
    code: "trust.skill-metadata-license",
    detail: "skills/x/SKILL.md:1 — Cisco AI Defense skill-scanner: missing license field",
    fingerprint: `trust-skill-metadata-license:skills/x/SKILL.md:${"a".repeat(64)}`,
  };
}

describe("applyTrustAcknowledgements — reclassified Cisco missing-license", () => {
  it("acknowledges the trust-origin missing-license finding with a fingerprint and reason", () => {
    const check = metadataLicenseCheck();
    const result = applyTrustAcknowledgements(
      [check],
      ctx({
        acknowledge: check.fingerprint,
        reason: "reviewed upstream skill; license tracked in catalog",
      }),
    );
    expect(result.acceptedFingerprints).toEqual([check.fingerprint]);
    expect(result.checks[0]).toEqual(
      expect.objectContaining({
        verdict: "skip",
        detail: expect.stringContaining("acknowledged by"),
      }),
    );
  });

  it("still requires a reason to acknowledge the origin finding", () => {
    const check = metadataLicenseCheck();
    expect(() =>
      applyTrustAcknowledgements([check], ctx({ acknowledge: check.fingerprint })),
    ).toThrowError(/--acknowledge requires --reason/);
  });

  it("never acknowledges a prompt-injection danger finding (danger floor intact)", () => {
    const danger: Check = {
      name: "trust.prompt-injection",
      verdict: "fail",
      code: "trust.prompt-injection",
      detail: "agents/x.md:11 — prompt-injection.secret-exfil",
      fingerprint: `trust-prompt-injection:agents/x.md:${"b".repeat(64)}`,
    };
    expect(() =>
      applyTrustAcknowledgements(
        [danger],
        ctx({ acknowledge: danger.fingerprint, reason: "please" }),
      ),
    ).toThrowError(/trust-danger findings must be fixed/);
  });
});
