import { describe, expect, it } from "vitest";
import { PolicyBundleSchema, parsePolicyBundle } from "../../src/org-policy/bundle.js";

/** A minimal valid embedded org policy (the local `aih-org-policy.json` shape). */
function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    minimumPosture: "team",
    references: { repoContract: "ai-coding/project.json" },
    ...overrides,
  };
}

function bundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    bundleVersion: "2026.07",
    issuer: "platform-team",
    issuedAt: "2026-07-01T00:00:00Z",
    policy: policy(),
    ...overrides,
  };
}

describe("PolicyBundleSchema", () => {
  it("parses a valid envelope embedding the org-policy shape", () => {
    const result = parsePolicyBundle(bundle({ rings: [{ name: "canary" }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundle.issuer).toBe("platform-team");
    expect(result.bundle.policy.minimumPosture).toBe("team");
    expect(result.bundle.rings?.[0]?.name).toBe("canary");
  });

  it("accepts an offset ISO-8601 issuedAt and rejects a date-only stamp", () => {
    expect(parsePolicyBundle(bundle({ issuedAt: "2026-07-01T10:00:00+02:00" })).ok).toBe(true);
    expect(parsePolicyBundle(bundle({ issuedAt: "2026-07-01" })).ok).toBe(false);
    expect(parsePolicyBundle(bundle({ issuedAt: "not-a-date" })).ok).toBe(false);
  });

  it("rejects a wrong schemaVersion", () => {
    expect(PolicyBundleSchema.safeParse(bundle({ schemaVersion: 2 })).success).toBe(false);
  });

  it("rejects unknown envelope keys (strict)", () => {
    expect(parsePolicyBundle(bundle({ signature: "abc" })).ok).toBe(false);
  });

  it("rejects unknown ring keys (strict)", () => {
    expect(parsePolicyBundle(bundle({ rings: [{ name: "canary", rollout: "10%" }] })).ok).toBe(
      false,
    );
  });

  it("rejects missing envelope fields", () => {
    const { issuer: _dropped, ...withoutIssuer } = bundle();
    expect(parsePolicyBundle(withoutIssuer).ok).toBe(false);
    expect(parsePolicyBundle(bundle({ bundleVersion: "" })).ok).toBe(false);
  });
});

describe("parsePolicyBundle layer attribution", () => {
  it("names the envelope layer for envelope-level issues", () => {
    const result = parsePolicyBundle(bundle({ issuer: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("bundle envelope is invalid");
    expect(result.error).toContain("issuer");
    expect(result.error).not.toContain("embedded org policy");
  });

  it("names the embedded org-policy layer for policy-level issues", () => {
    const result = parsePolicyBundle(bundle({ policy: policy({ minimumPosture: "wild" }) }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("embedded org policy is invalid");
    expect(result.error).toContain("policy.minimumPosture");
    expect(result.error).not.toContain("bundle envelope");
  });

  it("reports both layers when both fail", () => {
    const result = parsePolicyBundle(bundle({ issuer: "", policy: { schemaVersion: 1 } }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("bundle envelope is invalid");
    expect(result.error).toContain("embedded org policy is invalid");
  });
});
