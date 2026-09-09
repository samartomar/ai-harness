import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepared: vi.fn(),
  reports: vi.fn(),
  records: vi.fn(),
  qualification: vi.fn(),
  apply: vi.fn(),
}));
vi.mock("../../src/org-policy/workbench/prepared-catalog.js", () => ({
  defaultPreparedWorkbenchCatalog: mocks.prepared,
  packagedPreparedWorkbenchCatalogV1: mocks.prepared,
  prepareWorkbenchCatalog: mocks.prepared,
}));
vi.mock("../../src/org-policy/packaged-collection-evidence-v1.js", () => ({
  packagedScannerCollectionOverlayV1: mocks.reports,
  packagedScannerCollectionEvidenceV1: mocks.records,
}));
vi.mock("../../src/org-policy/workbench/core/catalog-qualification-v1.js", () => ({
  preparePackagedCatalogQualificationV1: mocks.qualification,
  catalogQualificationPreparedBundleV1: mocks.apply,
}));

import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { verifyAuthoringCatalogBundleIntegrityV1 } from "../../src/org-policy/workbench/catalog-integrity.js";
import type {
  CatalogQualificationSummaryV1,
  EvidenceSummaryV1,
} from "../../src/org-policy/workbench/contracts.js";
import { tinyStudioModel } from "./studio-test-fixture.js";

describe("Studio composes the verified package channels", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.prepared.mockImplementation(() => {
      const fixture = tinyStudioModel();
      return {
        catalog: fixture.catalog,
        bundle: fixture.workbenchBundle,
        bindings: fixture.workbenchBindings,
        sourceInputs: {},
      };
    });
    mocks.reports.mockReturnValue({});
    mocks.records.mockReturnValue([]);
  });
  it("retains report findings and original independent dates while disclosing exact publications", () => {
    const fixture = tinyStudioModel();
    const asset = Object.values(fixture.workbenchBundle.assets)[0];
    if (!asset) throw new Error("Fixture asset missing.");
    const source = fixture.workbenchBundle.sources[asset.sourceId];
    if (!source) throw new Error("Fixture source missing.");
    const digest = `sha256:${"a".repeat(64)}`;
    const evidence: EvidenceSummaryV1 = {
      id: "evidence:fixture",
      projectionVersion: "evidence-summary/v1",
      subjects: [
        {
          assetId: asset.id,
          sourceId: asset.sourceId,
          sourceRevisionId: asset.sourceRevisionId,
          contentDigest: asset.contentDigest,
        },
      ],
      evidenceDigest: digest,
      coveredPaths: ["catalog.json"],
      verification: {
        state: "verified",
        verifiedAt: "2026-09-03T00:00:00Z",
        validUntil: "2026-11-30T00:00:00Z",
        contextDigest: digest,
      },
      scan: {
        outcome: "failed",
        coverage: "complete",
        reportSignedAt: "2026-09-01T00:00:00Z",
        publishedAt: "2026-09-02T00:00:00Z",
      },
      qualification: { state: "unknown" },
      findings: ["Outbound access requires review."],
    };
    const summary: CatalogQualificationSummaryV1 = {
      projectionVersion: "catalog-qualification-summary/v1",
      state: "qualified",
      assetId: asset.id,
      sourceId: asset.sourceId,
      sourceRevisionId: asset.sourceRevisionId,
      contentDigest: asset.contentDigest,
      sourceContentDigest: source.revision.contentDigest,
      subjectDigest: digest,
      receiptDigest: digest,
      receiptSetDigest: digest,
      catalogDigest: digest,
      catalogHeadDigest: digest,
      catalogMemberDigest: digest,
      closureDigest: digest,
      compilerBindingDigest: digest,
      contextDigest: digest,
      publisher: {
        repository: "fixture/catalog",
        workflow: "fixture/catalog/workflow.yml",
        ref: "refs/heads/main",
        issuer: "https://token.actions.githubusercontent.com",
        commit: "b".repeat(40),
      },
      verifiedAt: "2026-09-04T00:00:00Z",
      originalIssuedAt: "2026-09-02T00:00:00Z",
      notBefore: "2026-09-02T00:00:00Z",
      validUntil: "2026-09-27T00:00:00Z",
      scope: { kind: "configuration-only", description: "Fixture declaration only" },
    };
    mocks.reports.mockReturnValue({ [evidence.id]: evidence });
    mocks.records.mockReturnValue([
      {
        catalog: { id: "fixture" },
        publications: [
          {
            repository: "fixture/scan",
            sourceCommit: "c".repeat(40),
            publicationSha256: "d".repeat(64),
          },
        ],
      },
    ]);
    mocks.qualification.mockReturnValue({});
    mocks.apply.mockImplementation((bundle) => ({
      ...bundle,
      qualifications: { [asset.id]: summary },
    }));
    const model = policyStudioModel(undefined, undefined, {});
    expect(model.workbenchBundle.evidence[evidence.id]).toEqual(evidence);
    expect(model.workbenchBundle.qualifications?.[asset.id]).toEqual(summary);
    expect(model.workbenchBundle.provenance.bundleDigest).not.toBe(
      fixture.workbenchBundle.provenance.bundleDigest,
    );
    expect(() => verifyAuthoringCatalogBundleIntegrityV1(model.workbenchBundle)).not.toThrow();
    expect(model.evidenceDelivery?.scanPublications).toEqual([
      {
        source: "fixture",
        publisher: "fixture/scan",
        commit: "c".repeat(40),
        digest: `sha256:${"d".repeat(64)}`,
      },
    ]);
    expect(model.evidenceDelivery?.qualificationPublications).toEqual([
      {
        publisher: "fixture/catalog",
        commit: "b".repeat(40),
        catalogDigest: digest,
        receiptSetDigest: digest,
      },
    ]);
    expect(model.initialPolicy.governance?.authority?.approvals).toEqual([]);
  });
  it("rejects a lost preparation handle instead of silently dropping qualification", () => {
    mocks.qualification.mockReturnValue({});
    mocks.apply.mockReturnValue(undefined);
    expect(() => policyStudioModel(undefined, undefined, {})).toThrow("lost custody");
  });
});
