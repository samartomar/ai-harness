import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthoringCatalogBundleV1 } from "../../../src/org-policy/workbench/contracts.js";
import { expandCatalogQualificationPackageInputV2 } from "../../../src/org-policy/workbench/core/catalog-qualification-compact.js";
import { catalogQualificationPackageInputV1 } from "../../../src/org-policy/workbench/core/catalog-qualification-data.js";
import { decodeCatalogQualificationPackageInputV1 } from "../../../src/org-policy/workbench/core/catalog-qualification-package-v1.js";
import { CATALOG_QUALIFICATION_RELEASE_POLICY_V1 } from "../../../src/org-policy/workbench/core/catalog-qualification-policy-v1.js";
import { verifySourceDataQualificationV1 } from "../../../src/org-policy/workbench/core/source-data-qualification.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));
vi.mock("../../../src/live/runner.js", async (original) => ({
  ...(await original<typeof import("../../../src/live/runner.js")>()),
  findOnPath: () => "fixture-gh",
}));
afterEach(() => vi.mocked(execFileSync).mockReset());
const issuedAt = "2026-09-09T02:00:00.000Z";
// An independent update carries its own publication, not every installed source's
// differently published receipts. Keep the authority checks real with one exact record.
const packaged = expandCatalogQualificationPackageInputV2(catalogQualificationPackageInputV1()) as {
  records: unknown[];
  bindings: {
    asset: { assetId: string; sourceId: string; sourceRevisionId: string; contentDigest: string };
    sourceContentDigest: string;
    compiler: { id: string; version: string; inputFormat: string };
  }[];
  projections: Record<string, unknown>[];
};
const binding = packaged.bindings[0]!;
const summary = packaged.projections[0]![binding.asset.assetId];
const bundle = {
  version: "authoring-catalog-bundle/v1",
  sources: {
    [binding.asset.sourceId]: {
      id: binding.asset.sourceId,
      distributor: { kind: "git", locator: "fixture/source" },
      upstreamOrigin: { kind: "git", locator: "fixture/source" },
      inputFormat: binding.compiler.inputFormat,
      revision: { id: binding.asset.sourceRevisionId, contentDigest: binding.sourceContentDigest },
      compiler: { id: binding.compiler.id, version: binding.compiler.version },
    },
  },
  assets: {
    [binding.asset.assetId]: {
      id: binding.asset.assetId,
      sourceId: binding.asset.sourceId,
      sourceRevisionId: binding.asset.sourceRevisionId,
      contentDigest: binding.asset.contentDigest,
      originalPath: "skills/fixture/SKILL.md",
      derivation: "upstream",
      kind: "skill",
      label: "Fixture",
      detailChunkId: "detail:fixture",
      declaredHostCapabilities: [],
      authoring: { action: "record-selection", supportedTargets: [] },
    },
  },
  groups: {},
  relations: [],
  templates: {},
  evidence: {},
  detailChunks: {},
  provenance: { bundleDigest: `sha256:${"0".repeat(64)}` },
  qualifications: { [binding.asset.assetId]: summary },
} as AuthoringCatalogBundleV1;
function proof() {
  return {
    packageInput: structuredClone({
      version: 1,
      records: [packaged.records[0]],
      bindings: [binding],
      projections: [{ [binding.asset.assetId]: summary }],
    }),
    receiptAttestation: "fixture-receipts",
    receiptSetAttestation: "fixture-set",
  };
}
function installVerifier(input: ReturnType<typeof proof>) {
  const decoded = decodeCatalogQualificationPackageInputV1(input.packageInput);
  const attestation = (set: boolean) => {
    const first = decoded.records[0]!;
    const publisher = set ? first.receiptSetPublisher : first.publisher;
    const workflow = `https://github.com/${publisher.workflow}@${publisher.ref}`;
    return JSON.stringify([
      {
        verificationResult: {
          signature: {
            certificate: {
              subjectAlternativeName: workflow,
              buildSignerURI: workflow,
              buildConfigURI: workflow,
              issuer: publisher.issuer,
              sourceRepositoryURI: `https://github.com/${publisher.repository}`,
              sourceRepositoryRef: publisher.ref,
              sourceRepositoryDigest: publisher.commit,
              runnerEnvironment: "github-hosted",
            },
          },
          verifiedTimestamps: [{ timestamp: "2026-09-09T01:30:00Z" }],
          statement: {
            _type: "https://in-toto.io/Statement/v1",
            predicateType: "https://slsa.dev/provenance/v1",
            subject: (set ? [first] : decoded.records).map((record) => ({
              name: (set ? record.receiptSetPublisher : record.publisher).subjectName,
              digest: {
                sha256: createHash("sha256")
                  .update(set ? record.receiptSetBytes : record.receiptBytes)
                  .digest("hex"),
              },
            })),
          },
        },
      },
    ]);
  };
  vi.mocked(execFileSync)
    .mockReturnValueOnce(attestation(false))
    .mockReturnValueOnce(attestation(true));
}
describe("independent source-data Catalog verification", () => {
  it("revalidates the exact source receipt through two independently verified attestation statements", () => {
    const input = proof();
    installVerifier(input);
    expect(() => verifySourceDataQualificationV1(bundle, input, issuedAt)).not.toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(execFileSync).mock.calls[0]![1]).toContain("--deny-self-hosted-runners");
    // Cached verification never survives removal of an authorized workflow commit.
    expect(() =>
      verifySourceDataQualificationV1(bundle, input, issuedAt, ["f".repeat(40)]),
    ).toThrow();
  });
  it.each(["receipt-name", "set-name", "set-publisher", "commit"])(
    "rejects %s outside explicit release policy",
    (change) => {
      const input = proof();
      const record = (
        input.packageInput as {
          records: {
            publisher: Record<string, unknown>;
            receiptSetPublisher: Record<string, unknown>;
          }[];
        }
      ).records[0]!;
      if (change === "receipt-name") Object.assign(record.publisher, { subjectName: "wrong.json" });
      if (change === "set-name")
        Object.assign(record.receiptSetPublisher, { subjectName: "wrong.json" });
      if (change === "set-publisher")
        Object.assign(record.receiptSetPublisher, { repository: "attacker/catalog" });
      if (change === "commit")
        Object.assign(record.receiptSetPublisher, { commit: "f".repeat(40) });
      expect(() => verifySourceDataQualificationV1(bundle, input, issuedAt)).toThrow();
      expect(execFileSync).not.toHaveBeenCalled();
    },
  );
  it("rejects forged verifier output and does not reuse another proof's cached success", () => {
    const input = proof();
    input.receiptAttestation = "different-forged-proof";
    vi.mocked(execFileSync).mockReturnValue("[]");
    expect(() => verifySourceDataQualificationV1(bundle, input, issuedAt)).toThrow();
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
  it("rejects proof without qualifications and qualification without proof", () => {
    expect(() =>
      verifySourceDataQualificationV1({ ...bundle, qualifications: {} }, proof(), issuedAt),
    ).toThrow();
    expect(() => verifySourceDataQualificationV1(bundle, undefined, issuedAt)).toThrow();
    expect(() =>
      verifySourceDataQualificationV1({ ...bundle, qualifications: {} }, undefined, issuedAt),
    ).not.toThrow();
    expect(CATALOG_QUALIFICATION_RELEASE_POLICY_V1.catalogCommit).toHaveLength(40);
  });
});
