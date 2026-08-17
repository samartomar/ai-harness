import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import { composeAdminSeatDistributionV1 } from "../../src/org-policy/admin-distribution-v1.js";
import {
  canonicalAdminSeatDistributionV1Bytes,
  parseAdminSeatDistributionV1Json,
} from "../../src/org-policy/catalog-binding-v1.js";

const sha = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const headRoot = sha("catalog head signer root");
const adminRoot = sha("admin signer root");

function snapshotMember(overrides: Record<string, unknown> = {}) {
  return {
    candidateIdentitySha256: sha("candidate identity"),
    candidateSha256: sha("candidate"),
    componentId: "skill:catalog-example",
    evidenceSha256: sha("evidence"),
    gitCommitSha256: sha("commit"),
    pinSha256: sha("pin"),
    policyRevisionSha256: sha("policy"),
    profileSha256: sha("profile"),
    promotionDecisionSha256: sha("promotion"),
    qualificationBundleSha256: sha("qualification"),
    recipeSha256: sha("recipe"),
    repository: "github.com/example/catalog-example",
    sourceId: "catalog-example",
    sourceSha256: sha("source"),
    ...overrides,
  };
}

function resolutionInput(overrides: Record<string, unknown> = {}) {
  const snapshotBytes = canonicalStrictJsonBytesV1({
    protocol: "CatalogSnapshotV1",
    members: [snapshotMember()],
  });
  const head = {
    catalogSha256: sha(snapshotBytes),
    compatibleEffectVersions: ["1", "2"],
    compatibleSchemaVersions: ["1", "2"],
    previousCatalogHeadSha256: sha("previous head"),
    promotionDecisionSha256: sha("promotion"),
    protocol: "CatalogHeadV1",
    sequence: 42,
    signerIdentity: "signer:catalog-head-v1",
    validFrom: "2026-08-17T00:00:00Z",
    validUntil: "2026-08-18T00:00:00Z",
  };
  const catalogHeadBytes = canonicalStrictJsonBytesV1(head);
  const statementBytes = canonicalStrictJsonBytesV1({
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      environment: "catalog-release",
      issuer: "https://token.actions.githubusercontent.com",
      protocol: "CatalogHeadEnvelopeV1",
      recordType: "CatalogHeadV1",
      repository: "github.com/aih/supported-catalog",
      signerIdentity: "signer:catalog-head-v1",
      workflowIdentity: "workflow:catalog-release-v1",
    },
    predicateType: "https://aih.dev/CatalogHeadV1",
    subject: [{ digest: { sha256: sha(catalogHeadBytes) }, name: "aih/CatalogHeadV1" }],
  });
  const catalogHeadEnvelopeBytes = canonicalStrictJsonBytesV1({
    payload: statementBytes.toString("base64"),
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ keyid: "head-key-1", sig: "aGVhZC1zaWc=" }],
  });
  const state = {
    protocol: "CachedCatalogStateV1",
    catalogHeadBytes,
    catalogHeadSha256: sha(catalogHeadBytes),
    catalogHeadEnvelopeBytes,
    catalogHeadEnvelopeSha256: sha(catalogHeadEnvelopeBytes),
    catalogSnapshotBytes: snapshotBytes,
    catalogSnapshotSha256: sha(snapshotBytes),
    signerRootSha256: headRoot,
    verifiedAt: "2020-01-01T00:00:00Z",
  };
  return {
    adminSignerRootSha256: adminRoot,
    cachedVerified: { kind: "unavailable" },
    expectedAdminSignerIdentity: "signer:admin-seat-v1",
    expectedCatalogSha256: sha(snapshotBytes),
    expectedCatalogSignerIdentity: "signer:catalog-head-v1",
    expectedEnvironment: "catalog-release",
    expectedIssuer: "https://token.actions.githubusercontent.com",
    expectedPackageRootSha256: sha("package root"),
    expectedPackageSha256: sha("package"),
    expectedPromotionDecisionSha256: sha("promotion"),
    expectedRef: "refs/heads/main",
    expectedRepository: "github.com/aih/supported-catalog",
    expectedWorkflowIdentity: "workflow:catalog-release-v1",
    fresh: state,
    headSignerRootSha256: headRoot,
    lastGood: state,
    now: "2026-08-17T12:00:00Z",
    packaged: { kind: "unavailable" },
    signCanonicalPae: () => ({ keyid: "admin-key-1", sig: "YWRtaW4tc2ln" }),
    verifyCanonicalPae: () => true,
    ...overrides,
  };
}

function expectedBinding(input: ReturnType<typeof resolutionInput>) {
  const fresh = input.fresh as {
    catalogHeadBytes: Buffer;
    catalogSnapshotSha256: string;
  };
  const raw = {
    adminSignerRootSha256: adminRoot,
    catalogHeadSha256: sha(fresh.catalogHeadBytes),
    catalogSha256: fresh.catalogSnapshotSha256,
    compatibleEffectVersion: "1",
    compatibleSchemaVersion: "1",
    headSignerRootSha256: headRoot,
    members: [snapshotMember()],
    protocol: "ResolvedCatalogBindingV1",
    resolvedAt: input.now,
    sequence: 42,
    tier: "fresh",
  };
  const bytes = canonicalStrictJsonBytesV1(raw);
  return {
    ...raw,
    bytes,
    resolvedCatalogBindingSha256: sha(bytes),
  };
}

function expectedDistributionStatement(input: ReturnType<typeof resolutionInput>): Buffer {
  const binding = expectedBinding(input);
  return canonicalStrictJsonBytesV1({
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      protocol: "AdminSeatDistributionV1",
      recordType: "ResolvedCatalogBindingV1",
      signerIdentity: input.expectedAdminSignerIdentity,
    },
    predicateType: "https://aih.dev/AdminSeatDistributionV1",
    subject: [
      {
        digest: { sha256: binding.resolvedCatalogBindingSha256 },
        name: "aih/ResolvedCatalogBindingV1",
      },
    ],
  });
}

function expectedDistributionPae(input: ReturnType<typeof resolutionInput>): Buffer {
  const statement = expectedDistributionStatement(input);
  return Buffer.concat([
    Buffer.from(
      `DSSEv1 ${String(Buffer.byteLength("application/vnd.in-toto+json"))} application/vnd.in-toto+json ${String(statement.length)} `,
      "utf8",
    ),
    statement,
  ]);
}

function expectedDistributionBytes(input: ReturnType<typeof resolutionInput>): Buffer {
  const binding = expectedBinding(input);
  const { bytes: _bytes, ...serializedBinding } = binding;
  return canonicalStrictJsonBytesV1({
    binding: serializedBinding,
    envelope: {
      payload: expectedDistributionStatement(input).toString("base64"),
      payloadType: "application/vnd.in-toto+json",
      signatures: [{ keyid: "admin-key-1", sig: "YWRtaW4tc2ln" }],
    },
    protocol: "AdminSeatDistributionV1",
  });
}

describe("internal admin-seat distribution composition", () => {
  it("derives every binding fact from verified selected head and snapshot material before signing", () => {
    const input = resolutionInput();
    const expected = expectedBinding(input);
    const expectedPae = expectedDistributionPae(input);
    const signCanonicalPae = vi.fn((request: Record<string, unknown>) => {
      expect(Object.keys(request).sort()).toEqual([
        "bindingSha256",
        "expectedAdminSignerIdentity",
        "expectedAdminSignerRootSha256",
        "paeBytes",
        "protocol",
      ]);
      expect(request.protocol).toBe("AdminSeatDistributionV1");
      expect(request.expectedAdminSignerRootSha256).toBe(adminRoot);
      expect(request.expectedAdminSignerIdentity).toBe("signer:admin-seat-v1");
      expect(request.bindingSha256).toBe(expected.resolvedCatalogBindingSha256);
      expect(request.paeBytes).toEqual(expectedPae);
      return { keyid: "admin-key-1", sig: "YWRtaW4tc2ln" };
    });
    const verifyCanonicalPae = vi.fn((request: Record<string, unknown>) => {
      expect(request.expectedAdminSignerRootSha256).toBe(adminRoot);
      expect(request.expectedAdminSignerIdentity).toBe("signer:admin-seat-v1");
      expect(request.signatures).toEqual([{ keyid: "admin-key-1", sig: "YWRtaW4tc2ln" }]);
      return true;
    });

    const distribution = composeAdminSeatDistributionV1({
      ...input,
      signCanonicalPae,
      verifyCanonicalPae,
    });

    expect(signCanonicalPae).toHaveBeenCalledOnce();
    expect(verifyCanonicalPae).toHaveBeenCalledOnce();
    expect(distribution.binding).toMatchObject({
      adminSignerRootSha256: adminRoot,
      catalogHeadSha256: sha((input.fresh as { catalogHeadBytes: Buffer }).catalogHeadBytes),
      catalogSha256: expected.catalogSha256,
      compatibleEffectVersion: "1",
      compatibleSchemaVersion: "1",
      headSignerRootSha256: headRoot,
      sequence: 42,
      tier: "fresh",
      resolvedAt: input.now,
      resolvedCatalogBindingSha256: expected.resolvedCatalogBindingSha256,
    });
    expect(distribution.binding.members).toEqual([snapshotMember()]);
    expect(Object.isFrozen(distribution)).toBe(true);
    expect(Object.isFrozen(distribution.binding.members)).toBe(true);
    const bytes = canonicalAdminSeatDistributionV1Bytes(distribution);
    expect(bytes).toEqual(expectedDistributionBytes(input));
    expect(parseAdminSeatDistributionV1Json(bytes)).toEqual(distribution);
  });

  it("never accepts caller member or digest projections and signs only a fully verified material selection", () => {
    const signer = vi.fn(() => ({ keyid: "admin-key-1", sig: "YWRtaW4tc2ln" }));
    const verifier = vi.fn(() => true);
    const input = resolutionInput({ signCanonicalPae: signer, verifyCanonicalPae: verifier });
    for (const changed of [
      { ...input, members: [snapshotMember({ pinSha256: sha("forged") })] },
      { ...input, resolvedMaterial: { kind: "resolved", members: [snapshotMember()] } },
      { ...input, catalogSha256: sha("forged") },
      { ...input, fresh: { ...input.fresh, catalogSnapshotSha256: sha("forged") } },
      { ...input, expectedCatalogSha256: sha("wrong catalog") },
      { ...input, now: "2026-08-18T00:00:00Z" },
      {
        ...input,
        fresh: {
          ...input.fresh,
          catalogHeadBytes: canonicalStrictJsonBytesV1({
            ...JSON.parse(
              (input.fresh as { catalogHeadBytes: Buffer }).catalogHeadBytes.toString("utf8"),
            ),
            compatibleSchemaVersions: ["2"],
          }),
        },
      },
      { ...input, fresh: { kind: "unavailable" }, cachedVerified: { kind: "unavailable" } },
    ])
      expect(() => composeAdminSeatDistributionV1(changed)).toThrow();
    expect(signer).not.toHaveBeenCalled();
    expect(verifier).not.toHaveBeenCalled();
  });

  it("fails closed when an injected signer or independent verifier returns malformed, mismatched, or rejected evidence", () => {
    for (const changed of [
      { signCanonicalPae: () => ({ keyid: "", sig: "YQ==" }) },
      { signCanonicalPae: () => ({ keyid: "admin-key-1", sig: "" }) },
      { signCanonicalPae: () => ({ keyid: "admin-key-1", sig: "not base64" }) },
      { verifyCanonicalPae: () => false },
      { adminSignerRootSha256: headRoot },
    ])
      expect(() => composeAdminSeatDistributionV1(resolutionInput(changed))).toThrow();
  });

  it("passes a configured trusted admin identity through to independent verification without treating identity choice as invalid", () => {
    const verifyCanonicalPae = vi.fn((request: Record<string, unknown>) => {
      expect(request.expectedAdminSignerIdentity).toBe("signer:other-admin-v1");
      return true;
    });
    expect(
      composeAdminSeatDistributionV1(
        resolutionInput({
          expectedAdminSignerIdentity: "signer:other-admin-v1",
          verifyCanonicalPae,
        }),
      ),
    ).toMatchObject({ protocol: "AdminSeatDistributionV1" });
    expect(verifyCanonicalPae).toHaveBeenCalledOnce();
    expect(() =>
      composeAdminSeatDistributionV1(
        resolutionInput({
          expectedAdminSignerIdentity: "signer:other-admin-v1",
          verifyCanonicalPae: () => false,
        }),
      ),
    ).toThrow();
  });

  it("remains an internal pure composer with no filesystem, Plan, CLI, Workbench, provider, process, or runtime route", () => {
    const source = resolve("src/org-policy/admin-distribution-v1.ts");
    expect(existsSync(source)).toBe(true);
    const text = readFileSync(source, "utf8");
    expect(text).not.toMatch(
      /node:(child_process|fs|https|http|net|tls|dgram)|\b(fetch|spawn|exec|fork|writeFile|executePlan|writeText|plan)\s*\(|policyGenerate|Workbench|docker|scanner|provider\.(request|poll)|runtime-policy/i,
    );
    expect(readFileSync(resolve("src/index.ts"), "utf8")).not.toContain("admin-distribution-v1");
    expect(readFileSync(resolve("src/commands/index.ts"), "utf8")).not.toContain(
      "admin-distribution-v1",
    );
  });
});
