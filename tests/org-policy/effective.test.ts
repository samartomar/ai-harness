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
  policySecurityLeafPaths,
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
      supportedClis: ["claude"],
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

function reviewedControls(targets: ("claude" | "codex" | "kiro")[] = ["claude"]) {
  const control = {
    id: "catalog-mcp",
    kind: "mcp" as const,
    source: { type: "mcp" as const, server: "catalog-mcp", subject: SUBJECT },
    targets,
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
        supportedClis: ["claude"],
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

  it("names vibe posture when it disables the requested projector", () => {
    const item = candidate({ targets: ["kiro"] });
    const base = policy();
    if (base.governance === undefined) throw new Error("expected governance fixture");
    const effective = resolveEffectiveOrgPolicy(
      policy({
        governance: {
          ...base.governance,
          supportedClis: ["kiro"],
          catalog: { reviewed: [item], custom: [] },
          activations: [{ candidate: "catalog-mcp", state: "active", targets: ["kiro"] }],
        },
      }),
      {
        targets: ["kiro"],
        projectorsEnabled: false,
        projectorDisabledReason: "vibe-posture",
        aihReviewedControls: reviewedControls(["kiro"]),
        mcpIdentities: {
          "catalog-mcp": { subject: SUBJECT, projectable: true, kiroProjectable: true },
        },
      },
    );
    expect(effective.candidates[0]).toMatchObject({
      effective: false,
      dangerCodes: expect.arrayContaining(["missing-projector", "unsupported-target"]),
      resolutionReasons: ["projector-disabled-at-vibe-posture"],
      projection: {
        requestedTargets: ["kiro"],
        supportedTargets: ["claude", "kiro"],
        availableTargets: ["kiro"],
        coverage: "blocked",
        ownership: "unavailable",
        receipt: "unavailable",
      },
    });
    expect(effective.blocking).toBe(true);
  });

  /**
   * The multi-target activation trap: an activation declaring `["claude","kiro"]` is
   * all-or-nothing, so selecting one target names the OTHER as not-selected. Naming only
   * the deficit reads as a contradiction — the operator re-runs with the named target and
   * gets the mirror error. The reason must state the full requirement and the actual
   * selection so one run is enough to see that BOTH are needed.
   */
  it("names the full activation requirement and the actual selection, not just the missing target", () => {
    const item = candidate({ targets: ["claude", "kiro"] });
    const base = policy();
    if (base.governance === undefined) throw new Error("expected governance fixture");
    const effective = resolveEffectiveOrgPolicy(
      policy({
        governance: {
          ...base.governance,
          supportedClis: ["claude", "kiro"],
          catalog: { reviewed: [item], custom: [] },
          activations: [{ candidate: "catalog-mcp", state: "active", targets: ["claude", "kiro"] }],
        },
      }),
      {
        targets: ["kiro"],
        aihReviewedControls: reviewedControls(["claude", "kiro"]),
        mcpIdentities: {
          "catalog-mcp": { subject: SUBJECT, projectable: true, kiroProjectable: true },
        },
      },
    );
    const reason = effective.candidates[0]?.resolutionReasons.find((r) =>
      r.startsWith("target-not-selected:"),
    );
    // The stable machine-readable prefix must survive for existing consumers.
    expect(reason).toMatch(/^target-not-selected:claude/);
    expect(reason).toContain("activation requires targets claude,kiro");
    expect(reason).toContain("selected kiro");
  });

  it("explains that a custom Kiro stdio source has no integrity-enforcing materializer", () => {
    const base = policy();
    if (base.governance === undefined) throw new Error("expected governance fixture");
    const custom = candidate({
      id: "custom-kiro",
      source: {
        type: "stdio",
        resolver: "npx",
        registry: "https://registry.npmjs.org",
        package: "example-mcp",
        version: "1.2.3",
        integrity: DIGEST,
      },
      targets: ["kiro"],
      evidence: { record: "custom-kiro-evidence" },
    });
    const effective = resolveEffectiveOrgPolicy(
      policy({
        governance: {
          ...base.governance,
          supportedClis: ["kiro"],
          catalog: { reviewed: [], custom: [custom] },
          activations: [{ candidate: "custom-kiro", state: "active", targets: ["kiro"] }],
        },
      }),
      { targets: ["kiro"], projectorsEnabled: true },
    );

    expect(effective.candidates[0]).toMatchObject({
      effective: false,
      dangerCodes: expect.arrayContaining(["missing-projector", "unsupported-target"]),
      resolutionReasons: ["custom-stdio-source-is-authorable-only"],
    });
  });

  it("requires an exact runtime-reviewed control record rather than a copied built-in source", () => {
    const base = policy();
    if (base.governance === undefined) throw new Error("expected governance fixture");
    const resolve = (item: Record<string, unknown>, targets: readonly string[] = ["claude"]) =>
      resolveEffectiveOrgPolicy(
        policy({
          governance: {
            supportedClis: ["claude"],
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
          supportedClis: ["claude"],
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
          supportedClis: ["claude"],
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
    ).toThrow(
      /custom MCP candidates must use a fully pinned stdio package or fenced remote endpoint identity/,
    );
  });

  it("rejects a Kiro-targeted remote MCP at the policy boundary", () => {
    const source = {
      type: "remote" as const,
      origin: "https://mcp.example.com",
      approval: {
        approvedBy: "security-admin",
        authenticationMode: "oauth",
        allowedDataClasses: ["design-metadata"],
      },
      administrativeStatus: "approved" as const,
      contentScanned: false,
    };
    expect(() =>
      parseOrgPolicy(
        policy({
          governance: {
            policyVersion: "2026.08.0",
            supportedClis: ["kiro"],
            catalog: {
              reviewed: [],
              custom: [
                candidate({
                  id: "remote-kiro",
                  source,
                  targets: ["kiro"],
                  evidence: { record: "remote-kiro-evidence" },
                }),
              ],
            },
            activations: [{ candidate: "remote-kiro", state: "active", targets: ["kiro"] }],
            authority: { approvals: [] },
          },
        }),
      ),
    ).toThrow(/Kiro MCP projection supports stdio catalog entries only/);
  });

  it("blocks a built-in remote catalog MCP before it can reach Kiro projection", () => {
    const base = policy();
    if (base.governance === undefined) throw new Error("expected governance fixture");
    const remote = candidate({ targets: ["kiro"] });
    const effective = resolveEffectiveOrgPolicy(
      policy({
        governance: {
          ...base.governance,
          supportedClis: ["kiro"],
          catalog: { reviewed: [remote], custom: [] },
          activations: [{ candidate: "catalog-mcp", state: "active", targets: ["kiro"] }],
        },
      }),
      {
        targets: ["kiro"],
        aihReviewedControls: reviewedControls(),
        mcpIdentities: {
          "catalog-mcp": { subject: SUBJECT, projectable: true, kiroProjectable: false },
        },
      },
    );

    expect(effective.candidates[0]).toMatchObject({
      requested: true,
      effective: false,
      dangerCodes: expect.arrayContaining(["unsupported-target"]),
    });
    expect(effective.activeMcpServerIds).toEqual([]);
  });

  it("keeps declarative remote governance free of tool-surface drift enforcement", () => {
    const source = {
      type: "remote" as const,
      origin: "https://mcp.figma.com",
      approval: {
        approvedBy: "security-admin",
        authenticationMode: "oauth",
        allowedDataClasses: ["design-metadata"],
      },
      administrativeStatus: "approved" as const,
      contentScanned: false as const,
    };
    const base = policy();
    if (base.governance === undefined) throw new Error("expected governance fixture");
    const effective = resolveEffectiveOrgPolicy(
      policy({
        governance: {
          supportedClis: ["claude"],
          ...base.governance,
          catalog: {
            reviewed: [],
            custom: [
              candidate({
                id: "figma-remote",
                description: "Approved hosted design MCP",
                source,
                evidence: { record: "figma-remote-approval" },
              }),
            ],
          },
          activations: [{ candidate: "figma-remote", state: "active", targets: ["claude"] }],
        },
      }),
      { targets: ["claude"] },
    );

    expect(effective.candidates[0]).toMatchObject({
      id: "figma-remote",
      source,
      effective: false,
      dangerCodes: expect.arrayContaining(["missing-projector"]),
      projection: { coverage: "blocked", ownership: "unavailable" },
    });
    expect(effective.candidates[0]?.dangerCodes).not.toContain("evidence-identity-drift");
    expect(effective.activeMcpServerIds).toEqual([]);
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
          supportedClis: ["claude"],
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
          supportedClis: ["claude"],
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
          supportedClis: ["claude"],
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
    expect(Object.keys(POLICY_ENGINE_FIELD_CONSUMERS).sort()).toEqual(
      [...policyGovernanceLeafPaths(), ...policySecurityLeafPaths()].sort(),
    );
    expect(Object.keys(POLICY_AUTHORITY_RECEIPT_FIELD_CONSUMERS).sort()).toEqual(
      policyAuthorityReceiptLeafPaths(),
    );
    const v3Consumers = Object.entries(POLICY_AUTHORITY_RECEIPT_FIELD_CONSUMERS)
      .filter(([path]) => path.includes("decisions.*.") || path.includes("decisionRevocations.*."))
      .map(([, consumer]) => consumer)
      .filter((consumer) => consumer.startsWith("V3 "));
    expect(v3Consumers).not.toContainEqual(expect.stringContaining("V3 downstream resolver"));
    expect(v3Consumers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("externally verified signed transport/schema validation"),
        expect.stringContaining("current organization-qualified upstream-observation runtime"),
        expect.stringContaining("legacy effective resolver deliberately withholds V3 runtime use"),
      ]),
    );
    for (const leaf of [
      "authorityReceipt.decisions.*.id",
      "authorityReceipt.decisions.*.qualificationBasis.evidenceDigest",
      "authorityReceipt.decisions.*.subject.sourceDigest",
      "authorityReceipt.decisions.*.subject.subjectDigest",
      "authorityReceipt.decisions.*.targets.*",
    ]) {
      expect(POLICY_AUTHORITY_RECEIPT_FIELD_CONSUMERS[leaf]).toContain(
        "current organization-qualified upstream-observation runtime",
      );
    }
    expect(
      POLICY_AUTHORITY_RECEIPT_FIELD_CONSUMERS[
        "authorityReceipt.decisions.*.qualificationBasis.catalogDigest"
      ],
    ).toContain("legacy effective resolver deliberately withholds V3 runtime use");
    expect(
      POLICY_AUTHORITY_RECEIPT_FIELD_CONSUMERS["authorityReceipt.decisionRevocations.*.issuer"],
    ).toContain("legacy effective resolver deliberately withholds V3 runtime use");
    for (const leaf of [
      "authorityReceipt.version",
      "authorityReceipt.issuedAt",
      "authorityReceipt.expiresAt",
    ]) {
      expect(POLICY_AUTHORITY_RECEIPT_FIELD_CONSUMERS[leaf]).toContain(
        "current organization-qualified upstream-observation runtime",
      );
    }
  });
});
