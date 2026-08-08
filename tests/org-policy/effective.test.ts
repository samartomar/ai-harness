import { describe, expect, it } from "vitest";
import {
  POLICY_AUTHORITY_RECEIPT_FIELD_CONSUMERS,
  policyAuthorityReceiptLeafPaths,
} from "../../src/org-policy/authority.js";
import {
  approvalAttestationDigest,
  candidateIdentityDigest,
  DISPOSITIONABLE_POLICY_FINDING_CODES,
  FENCED_POLICY_PREREQUISITE_CODES,
  isDispositionableFinding,
  isFencedPrerequisite,
  POLICY_ENGINE_FIELD_CONSUMERS,
  resolveEffectiveOrgPolicy,
  reviewedControlDigest,
  UNWAIVABLE_POLICY_DANGER_CODES,
} from "../../src/org-policy/effective.js";
import {
  PolicyDangerCodeSchema,
  parseOrgPolicy,
  policyGovernanceLeafPaths,
} from "../../src/org-policy/schema.js";

const SUBJECT = `mcp-server-sha256:${"a".repeat(64)}`;
const DIGEST = `sha256:${"b".repeat(64)}`;

function candidate(overrides: Record<string, unknown> = {}) {
  const source = { type: "mcp" as const, server: "catalog-mcp", subject: SUBJECT };
  return {
    id: "catalog-mcp",
    kind: "mcp",
    description: "AIH catalog MCP",
    capabilities: [],
    risks: [],
    source,
    targets: ["claude"] as ("claude" | "codex")[],
    projector: "mcp-managed-settings",
    lifecycle: "supported",
    evidence: { record: "catalog-evidence" },
    ...overrides,
  };
}

function policy(overrides: Record<string, unknown> = {}) {
  return parseOrgPolicy({
    schemaVersion: 2,
    minimumPosture: "enterprise",
    references: { repoContract: "ai-coding/project.json" },
    mcp: { allowManagedOnly: true },
    governance: {
      policyVersion: "2026.08.0",
      catalog: { reviewed: [candidate()], custom: [] },
      activations: [{ candidate: "catalog-mcp", state: "active", targets: ["claude"] }],
      authority: { approvals: [] },
    },
    ...overrides,
  });
}

function approval(overrides: Record<string, unknown> = {}) {
  const source = candidate().source;
  const value = {
    id: "security-approval",
    candidate: "catalog-mcp",
    kind: "mcp",
    source,
    issuer: "platform-security",
    sourceDigest: candidateIdentityDigest({ source } as never),
    evidenceDigest: DIGEST,
    projector: "mcp-managed-settings",
    policyVersion: "2026.08.0",
    reason: "An accountable signer approved the waivable evidence gap.",
    scope: ["claude"],
    notBefore: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-31T00:00:00.000Z",
    github: {
      repository: "acme/governance",
      attestationId: "transport-locator-after-signing",
      subjectDigest: DIGEST,
    },
    ...overrides,
  };
  return {
    ...value,
    github: { ...value.github, subjectDigest: approvalAttestationDigest(value as never) },
  };
}

function reviewedControls() {
  const control = {
    id: "catalog-mcp",
    kind: "mcp" as const,
    source: { type: "mcp" as const, server: "catalog-mcp", subject: SUBJECT },
    targets: ["claude"] as ("claude" | "codex")[],
    projector: "mcp-managed-settings" as const,
    lifecycle: "supported" as const,
  };
  return {
    "catalog-mcp": { control, controlDigest: reviewedControlDigest(control as never) },
  };
}

describe("headless effective org policy", () => {
  it("does not let policy-authored reviewed/evidence labels activate a candidate", () => {
    const effective = resolveEffectiveOrgPolicy(policy(), {
      targets: ["claude"],
      mcpIdentities: { "catalog-mcp": { subject: SUBJECT, projectable: true } },
    });

    expect(effective.candidates[0]).toMatchObject({
      requested: true,
      effective: false,
      evidence: "missing",
      blockingCodes: expect.arrayContaining(["authority-receipt-unverified", "evidence-missing"]),
    });
  });

  it("rejects policy-authored authority issuers and evidence verdicts instead of treating them as proof", () => {
    const withAuthIssuer = {
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "2026.08.0",
        catalog: { reviewed: [candidate()], custom: [] },
        activations: [{ candidate: "catalog-mcp", state: "active", targets: ["claude"] }],
        authority: {
          approvals: [],
          trustedIssuers: [{ id: "policy-author", githubRepository: "product/team-repo" }],
        },
      },
    };
    expect(() => parseOrgPolicy(withAuthIssuer)).toThrow(/unrecognized key/i);

    const withEvidenceVerdict = {
      ...withAuthIssuer,
      governance: {
        ...withAuthIssuer.governance,
        authority: { approvals: [] },
        catalog: {
          reviewed: [candidate({ evidence: { record: "catalog-evidence", state: "verified" } })],
          custom: [],
        },
      },
    };
    expect(() => parseOrgPolicy(withEvidenceVerdict)).toThrow(/unrecognized key/i);
  });

  it("blocks a requested candidate when the actual invocation has no enabled projector", () => {
    const item = candidate();
    const base = policy();
    if (base.governance === undefined) throw new Error("expected governance fixture");
    const effective = resolveEffectiveOrgPolicy(
      policy({
        governance: { ...base.governance, catalog: { reviewed: [item], custom: [] } },
      }),
      {
        targets: ["claude"],
        projectorsEnabled: false,
        aihReviewedControls: reviewedControls(),
        mcpIdentities: { "catalog-mcp": { subject: SUBJECT, projectable: true } },
      },
    );
    expect(effective.candidates[0]).toMatchObject({
      effective: false,
      dangerCodes: expect.arrayContaining(["missing-projector", "unsupported-target"]),
    });
    expect(effective.blocking).toBe(true);
  });

  it("requires an exact runtime-reviewed control record rather than a copied built-in source", () => {
    const base = policy();
    if (base.governance === undefined) throw new Error("expected governance fixture");
    const resolve = (item: Record<string, unknown>, targets: readonly string[] = ["claude"]) =>
      resolveEffectiveOrgPolicy(
        policy({
          governance: {
            ...base.governance,
            catalog: { reviewed: [item], custom: [] },
            activations: [{ candidate: String(item.id), state: "active", targets: [...targets] }],
          },
        }),
        {
          targets,
          aihReviewedControls: reviewedControls(),
          mcpIdentities: { "catalog-mcp": { subject: SUBJECT, projectable: true } },
        },
      );

    const exact = resolve(candidate());
    expect(exact.candidates[0]).toMatchObject({ effective: true, evidence: "verified" });
    expect(exact.activeMcpServerIds).toEqual(["catalog-mcp"]);

    expect(() => resolve(candidate({ id: "catalog-alias" }))).toThrow(
      /built-in MCP candidate id must exactly match source.server/,
    );
    expect(() => resolve(candidate({ targets: ["codex"] }), ["codex"])).toThrow(
      /MCP managed-settings candidates support Claude targets only/,
    );
    for (const [label, item, targets] of [
      ["projector", candidate({ projector: "usage-hook" }), ["claude"]],
      ["lifecycle", candidate({ lifecycle: "deprecated" }), ["claude"]],
    ] as const) {
      const effective = resolve(item, targets);
      expect(effective.candidates[0]?.effective, label).toBe(false);
      expect(effective.candidates[0]?.evidence, label).not.toBe("verified");
      expect(effective.blocking, label).toBe(true);
    }
  });

  it("rejects framework metadata on non-framework candidates", () => {
    const base = policy();
    if (base.governance === undefined) throw new Error("expected governed policy fixture");
    expect(() =>
      policy({
        governance: {
          ...base.governance,
          catalog: { reviewed: [candidate({ framework: "ecc" })], custom: [] },
        },
      }),
    ).toThrow(/framework is only valid on framework candidates/);
  });

  it("rejects a custom MCP that tries to point at an AIH catalog server instead of a pinned package", () => {
    expect(() =>
      parseOrgPolicy({
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: {
          policyVersion: "2026.08.0",
          catalog: {
            reviewed: [],
            custom: [
              candidate({ source: { type: "mcp", server: "catalog-mcp", subject: SUBJECT } }),
            ],
          },
          activations: [{ candidate: "catalog-mcp", state: "active", targets: ["claude"] }],
          authority: { approvals: [] },
        },
      }),
    ).toThrow(/custom MCP candidates must use a fully pinned stdio package identity/);
  });

  it("rejects custom and aliased hook candidates instead of letting them project an AIH hook", () => {
    const hook = {
      id: "alias-hook",
      kind: "hook",
      description: "Alias the AIH hook",
      capabilities: [],
      risks: [],
      source: { type: "hook", handler: "usage-metering", scriptDigest: DIGEST },
      targets: ["claude"],
      projector: "usage-hook",
      lifecycle: "supported",
      evidence: { record: "hook-evidence" },
    };
    const base = policy();
    if (base.governance === undefined) throw new Error("expected governance fixture");
    expect(() =>
      parseOrgPolicy({
        ...base,
        governance: {
          ...base.governance,
          catalog: { reviewed: [], custom: [hook] },
          activations: [{ candidate: "alias-hook", state: "active", targets: ["claude"] }],
        },
      }),
    ).toThrow(/AIH-owned hook candidate id must exactly match source.handler/);
  });

  it("blocks a reviewed MCP when the managed-settings projector is not explicitly enabled", () => {
    const base = policy({ mcp: { allowManagedOnly: false } });
    const effective = resolveEffectiveOrgPolicy(base, {
      targets: ["claude"],
      aihReviewedControls: reviewedControls(),
      mcpIdentities: { "catalog-mcp": { subject: SUBJECT, projectable: true } },
    });
    expect(effective.candidates[0]).toMatchObject({
      effective: false,
      dangerCodes: expect.arrayContaining(["missing-projector"]),
    });
  });

  it("binds the complete approval subject while excluding the post-signing transport locator", () => {
    const signed = approval({ clarification: "The signed approval includes this clarification." });
    expect(approvalAttestationDigest(signed as never)).toBe(signed.github.subjectDigest);
    expect(
      approvalAttestationDigest({
        ...signed,
        github: { ...signed.github, attestationId: "another-transport-locator" },
      } as never),
    ).toBe(signed.github.subjectDigest);

    for (const change of [
      { candidate: "other-candidate" },
      { kind: "hook" },
      { sourceDigest: `sha256:${"c".repeat(64)}` },
      { evidenceDigest: `sha256:${"d".repeat(64)}` },
      { projector: "usage-hook" },
      { reason: "A changed reason." },
      { clarification: "A changed signed clarification." },
      { scope: ["codex"] },
      { notBefore: "2026-08-02T00:00:00.000Z" },
      { expiresAt: "2026-08-30T00:00:00.000Z" },
      { policyVersion: "2026.09.0" },
    ]) {
      expect(approvalAttestationDigest({ ...signed, ...change } as never)).not.toBe(
        signed.github.subjectDigest,
      );
    }
  });

  // The finding model is a partition, not a new taxonomy: the same 14 codes,
  // separated where they already differ in kind. Locked 2026-08-05.
  it("partitions every danger code into exactly one half", () => {
    const union = [...DISPOSITIONABLE_POLICY_FINDING_CODES, ...FENCED_POLICY_PREREQUISITE_CODES];
    expect([...union].sort()).toStrictEqual([...UNWAIVABLE_POLICY_DANGER_CODES].sort());
    expect(new Set(union).size).toBe(union.length);
    expect(
      DISPOSITIONABLE_POLICY_FINDING_CODES.filter((code) =>
        (FENCED_POLICY_PREREQUISITE_CODES as readonly string[]).includes(code),
      ),
    ).toStrictEqual([]);
  });

  // schema.ts repeats the code list for its enum. Drift between the two would
  // silently un-govern a code, so compare them rather than trusting the copy.
  it("keeps the partition and the schema enum describing the same code set", () => {
    expect([...UNWAIVABLE_POLICY_DANGER_CODES].sort()).toStrictEqual(
      [...PolicyDangerCodeSchema.options].sort(),
    );
  });

  it("pins which codes an administrator may dispose of and which stay fenced", () => {
    expect([...DISPOSITIONABLE_POLICY_FINDING_CODES].sort()).toStrictEqual([
      "auto-executing-hook",
      "dependency-confusion",
      "hidden-unicode",
      "malicious-code",
      "prompt-injection",
      "secrets",
      "unpinned-source",
      "unsafe-path",
    ]);
    expect([...FENCED_POLICY_PREREQUISITE_CODES].sort()).toStrictEqual([
      "evidence-identity-drift",
      "mandatory-detector-failed",
      "missing-projector",
      "normalized-collision",
      "ownership-conflict",
      "unsupported-target",
    ]);
  });

  it("answers both guards for every code, and neither for a code it does not know", () => {
    for (const code of UNWAIVABLE_POLICY_DANGER_CODES) {
      expect(isDispositionableFinding(code)).toBe(!isFencedPrerequisite(code));
    }
    expect(isDispositionableFinding("not-a-code")).toBe(false);
    expect(isFencedPrerequisite("not-a-code")).toBe(false);
  });

  it.each(UNWAIVABLE_POLICY_DANGER_CODES)("keeps authored danger code %s blocking", (danger) => {
    const effective = resolveEffectiveOrgPolicy(
      policy({
        governance: {
          policyVersion: "2026.08.0",
          catalog: { reviewed: [candidate({ findings: [danger] })], custom: [] },
          activations: [{ candidate: "catalog-mcp", state: "active", targets: ["claude"] }],
          authority: { approvals: [] },
        },
      }),
      {
        targets: ["claude"],
        mcpIdentities: { "catalog-mcp": { subject: SUBJECT, projectable: true } },
      },
    );
    expect(effective.candidates[0]?.dangerCodes).toContain(danger);
    expect(effective.candidates[0]?.effective).toBe(false);
  });

  it("does not claim an unimplemented framework contract as effective", () => {
    const source = {
      type: "git" as const,
      repository: "acme/ecc",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
    };
    const effective = resolveEffectiveOrgPolicy(
      policy({
        governance: {
          policyVersion: "2026.08.0",
          catalog: {
            reviewed: [],
            custom: [
              {
                ...candidate({
                  id: "ecc-profile",
                  kind: "framework",
                  source,
                  targets: ["claude"],
                  projector: "framework-contract",
                  framework: "ecc",
                  evidence: { record: "ecc-evidence" },
                }),
              },
            ],
          },
          activations: [{ candidate: "ecc-profile", state: "active", targets: ["claude"] }],
          authority: { approvals: [] },
        },
      }),
      { targets: ["claude"] },
    );
    expect(effective.candidates[0]).toMatchObject({
      effective: false,
      blockingCodes: expect.arrayContaining(["framework-contract-unavailable"]),
    });
    expect(effective.blocking).toBe(true);
  });

  it("mechanically covers every authorable schema leaf with an explicit consumer", () => {
    expect(Object.keys(POLICY_ENGINE_FIELD_CONSUMERS).sort()).toEqual(policyGovernanceLeafPaths());
    expect(Object.keys(POLICY_AUTHORITY_RECEIPT_FIELD_CONSUMERS).sort()).toEqual(
      policyAuthorityReceiptLeafPaths(),
    );
  });
});
