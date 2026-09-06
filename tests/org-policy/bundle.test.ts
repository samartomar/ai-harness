import { describe, expect, it } from "vitest";
import { parsePolicyBundle as parsePublishedPolicyBundle } from "../../src/index.js";
import { PolicyBundleSchema, parsePolicyBundle } from "../../src/org-policy/bundle.js";
import { WORKBENCH_MINIMUM_CORE_VERSION } from "../../src/org-policy/workbench/contracts.js";

/** A minimal valid embedded org policy (the local `aih-org-policy.json` shape). */
function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minimumPosture: "vibe",
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

function authorityBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...bundle(),
    schemaVersion: 2,
    policy: policy({
      minimumPosture: "enterprise",
      governance: {
        policyVersion: "2026.08",
        catalog: { reviewed: [], custom: [] },
        supportedClis: ["claude"],
      },
    }),
    authorityReceipt: {
      format: "aih-policy-authority-receipt",
      version: 3,
      issuerRepository: "acme/governance",
      issuedAt: "2026-07-01T00:00:00Z",
      expiresAt: "2026-07-08T00:00:00Z",
      trustedIssuers: [{ id: "platform-security", githubRepository: "acme/governance" }],
      targets: ["claude"],
      decisions: [],
      decisionRevocations: [],
    },
    ...overrides,
  };
}

describe("PolicyBundleSchema", () => {
  it("publishes the exact PolicyBundle parser from the Core package surface", () => {
    expect(parsePublishedPolicyBundle(authorityBundle())).toMatchObject({ ok: true });
  });

  it("parses a valid envelope embedding the org-policy shape", () => {
    const result = parsePolicyBundle(bundle({ rings: [{ name: "canary" }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundle.issuer).toBe("platform-team");
    expect(result.bundle.policy.minimumPosture).toBe("vibe");
    expect(result.bundle.rings?.[0]?.name).toBe("canary");
  });

  it("accepts an offset ISO-8601 issuedAt and rejects a date-only stamp", () => {
    expect(parsePolicyBundle(bundle({ issuedAt: "2026-07-01T10:00:00+02:00" })).ok).toBe(true);
    expect(parsePolicyBundle(bundle({ issuedAt: "2026-07-01" })).ok).toBe(false);
    expect(parsePolicyBundle(bundle({ issuedAt: "not-a-date" })).ok).toBe(false);
  });

  it("accepts the authority-bearing V2 envelope and rejects unknown versions", () => {
    const parsed = parsePolicyBundle(authorityBundle());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected authority bundle");
    expect(parsed.bundle.schemaVersion).toBe(2);
    if (parsed.bundle.schemaVersion !== 2) throw new Error("expected V2 bundle");
    expect(parsed.bundle.authorityReceipt.version).toBe(3);
    expect(PolicyBundleSchema.safeParse(bundle({ schemaVersion: 3 })).success).toBe(false);
  });

  it("keeps the authority envelope at V2 while allowing an embedded V3 policy", () => {
    const v3Policy = {
      ...(authorityBundle().policy as Record<string, unknown>),
      schemaVersion: 3,
      minimumCoreVersion: WORKBENCH_MINIMUM_CORE_VERSION,
      authoringSelections: {
        selectionVersion: "workbench-selection/v1",
        roots: [],
        exclusions: [],
        requests: [],
        drafts: [],
      },
    };
    expect(parsePolicyBundle(authorityBundle({ policy: v3Policy }))).toMatchObject({ ok: true });
    expect(parsePolicyBundle(authorityBundle({ schemaVersion: 3, policy: v3Policy })).ok).toBe(
      false,
    );
  });
  it("rejects a V2 envelope without its exact V3 decision authority", () => {
    const { authorityReceipt: _dropped, ...withoutAuthority } = authorityBundle();
    expect(parsePolicyBundle(withoutAuthority).ok).toBe(false);
    expect(
      parsePolicyBundle(
        authorityBundle({
          authorityReceipt: {
            ...(authorityBundle().authorityReceipt as Record<string, unknown>),
            version: 2,
          },
        }),
      ).ok,
    ).toBe(false);
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
    const result = parsePolicyBundle(bundle({ issuer: "", policy: { schemaVersion: 2 } }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("bundle envelope is invalid");
    expect(result.error).toContain("embedded org policy is invalid");
  });
});
