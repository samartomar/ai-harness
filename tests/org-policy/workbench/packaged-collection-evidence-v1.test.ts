import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1 } from "../../../src/baseline-evidence/scanner-publication-policy.js";
import { canonicalStrictJsonSha256V1 } from "../../../src/contract/strict-json-v1.js";
import type { AuthoringCatalogBundleV1 } from "../../../src/org-policy/workbench/contracts.js";

const records = vi.hoisted((): { bytes: string; sha256: string }[] => []);
vi.mock("../../../src/org-policy/packaged-collection-evidence-data.js", () => ({
  PACKAGED_SCANNER_COLLECTION_EVIDENCE_RECORDS_V1: records,
}));

import {
  encodePackagedScannerCollectionEvidenceRecordV1,
  packagedScannerCollectionEvidenceV1,
  packagedScannerCollectionOverlayV1,
  ScannerEvidenceProjectionRecordV1Schema,
} from "../../../src/org-policy/packaged-collection-evidence-v1.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

const sha = (letter: string) => letter.repeat(64);
const commit = "a".repeat(40);

function sealedFixture(bundle: AuthoringCatalogBundleV1) {
  const source = bundle.sources["source:fixture-core"]!;
  const current = bundle.assets["fixture:control"]!;
  const expired = bundle.assets["fixture:external"]!;
  const components = [
    {
      componentId: "component:current",
      asset: current,
      tree: sha("b"),
      signedAt: "2026-06-01T00:00:00.000Z",
    },
    {
      componentId: "component:expired",
      asset: expired,
      tree: sha("c"),
      signedAt: "2026-06-02T00:00:00.000Z",
    },
  ];
  const record = {
    version: "packaged-scanner-collection-evidence/v1" as const,
    authority: "display-only" as const,
    catalog: {
      id: "aih" as const,
      owner: "samartomar",
      repository: "ai-harness",
      pinnedCommit: commit,
      sourceTreeSha256: sha("a"),
      coverageDigest: `sha256:${sha("d")}`,
      source: {
        id: source.id,
        revisionId: source.revision.id,
        contentDigest: source.revision.contentDigest,
        inputFormat: source.inputFormat,
        upstreamOrigin: source.upstreamOrigin,
      },
    },
    coverage: {
      version: "workbench-scanner-coverage/v1" as const,
      authority: "none" as const,
      scope: "declared-source-files" as const,
      components: components.map(({ componentId, asset, tree }) => ({
        componentId,
        componentTreeSha256: tree,
        paths: ["catalog.json"],
        files: [{ path: "catalog.json", digest: `sha256:${sha("e")}` }],
        subject: {
          assetId: asset.id,
          sourceId: asset.sourceId,
          sourceRevisionId: asset.sourceRevisionId,
          contentDigest: asset.contentDigest,
        },
      })),
      unmappedDerivedAssets: [],
    },
    report: {
      id: "aih",
      owner: "samartomar",
      repo: "ai-harness",
      pinnedSha: commit,
      sourceTreeSha256: sha("a"),
      components: components.map(({ componentId, tree }) => ({
        id: componentId,
        paths: ["catalog.json"],
        treeSha256: tree,
        verdict: "pass" as const,
        analyzers: [{ name: "scanner", version: "1" }],
        findings: [],
      })),
    },
    publications: components.map((_, index) => ({
      authority: "none" as const,
      repository: SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.repository,
      workflow: SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.workflow,
      ref: SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.ref,
      sourceCommit: SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.commit,
      publicationSha256: sha(index === 0 ? "f" : "1"),
      requestSha256: sha(index === 0 ? "2" : "3"),
      receiptSha256: sha(index === 0 ? "4" : "5"),
      publicationLocator: `https://github.com/samartomar/aih-scan/releases/download/baseline-v1-${SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1.commit}-${sha(index === 0 ? "2" : "3")}/publication.json`,
      publishedAt: "2026-06-03T00:00:00.000Z",
    })),
    observations: components.map(({ componentId, tree, signedAt }, index) => ({
      componentId,
      componentTreeSha256: tree,
      reportSignedAt: signedAt,
      reportVerificationExpiresAt: "2026-06-04T00:00:00.000Z",
      requestSha256: sha(index === 0 ? "2" : "3"),
      publicationSha256: sha(index === 0 ? "f" : "1"),
      receiptSha256: sha(index === 0 ? "4" : "5"),
    })),
    verification: {
      method: "gh-attestation-verify" as const,
      preparedAt: "2026-06-04T00:00:00.000Z",
    },
  };
  return {
    ...record,
    catalog: {
      ...record.catalog,
      coverageProjectionDigest: `sha256:${canonicalStrictJsonSha256V1({ version: "packaged-coverage-projection/v1", coverage: record.coverage })}`,
    },
    observations: record.observations.map((observation, index) => ({
      ...observation,
      reportComponentDigest: `sha256:${canonicalStrictJsonSha256V1({ version: "packaged-report-component/v1", component: record.report.components[index] })}`,
    })),
  };
}

beforeEach(() => records.splice(0));

describe("packaged collection evidence", () => {
  it("leaves external publisher authorization to raw-proof verification while keeping package admission pinned", () => {
    const record = sealedFixture(tinyStudioModel().workbenchBundle);
    for (const publication of record.publications) {
      publication.sourceCommit = "9".repeat(40);
      publication.publicationLocator = `https://github.com/${publication.repository}/releases/download/baseline-v1-${publication.sourceCommit}-${publication.requestSha256}/publication.json`;
    }
    expect(ScannerEvidenceProjectionRecordV1Schema.safeParse(record).success).toBe(true);
    expect(() => encodePackagedScannerCollectionEvidenceRecordV1(record)).toThrow(/publisher/);
    record.publications[0]!.publicationLocator = record.publications[0]!.publicationLocator.replace(
      "9".repeat(40),
      "8".repeat(40),
    );
    expect(ScannerEvidenceProjectionRecordV1Schema.safeParse(record).success).toBe(false);
  });
  it.each(["paths", "report-digest", "coverage-digest"])(
    "rejects external source projection %s drift before verified display",
    (field) => {
      const original = sealedFixture(tinyStudioModel().workbenchBundle);
      const record = {
        ...original,
        catalog: { ...original.catalog, id: "external-compatible" },
        report: { ...original.report, id: "external-compatible" },
      };
      expect(ScannerEvidenceProjectionRecordV1Schema.safeParse(record).success).toBe(true);
      if (field === "paths") {
        record.report.components[0]!.paths = ["other.json"];
        record.observations[0]!.reportComponentDigest =
          `sha256:${canonicalStrictJsonSha256V1({ version: "packaged-report-component/v1", component: record.report.components[0] })}`;
      } else if (field === "report-digest")
        record.observations[0]!.reportComponentDigest = `sha256:${sha("9")}`;
      else record.catalog.coverageProjectionDigest = `sha256:${sha("9")}`;
      expect(() => ScannerEvidenceProjectionRecordV1Schema.parse(record)).toThrow(
        /projection digest|report component digest|report coverage paths/,
      );
    },
  );

  it("accepts distinct Scanner and Core legal-material trees with a bound report", () => {
    const record = sealedFixture(tinyStudioModel().workbenchBundle);
    record.report.components[0]!.treeSha256 = sha("9");
    record.observations[0]!.reportComponentDigest =
      `sha256:${canonicalStrictJsonSha256V1({ version: "packaged-report-component/v1", component: record.report.components[0] })}`;
    expect(() => encodePackagedScannerCollectionEvidenceRecordV1(record)).not.toThrow();
  });

  it("requires each original publication inside its own retained custody window", () => {
    const record = sealedFixture(tinyStudioModel().workbenchBundle);
    record.publications[0]!.publishedAt = record.observations[0]!.reportVerificationExpiresAt;
    expect(() => ScannerEvidenceProjectionRecordV1Schema.parse(record)).toThrow(
      /publication outside report verification window/,
    );
  });

  it.each(["coverage", "paths", "tree", "verdict", "findings"])(
    "rejects partial %s substitution even when the outer seal is recomputed",
    (field) => {
      const record = sealedFixture(tinyStudioModel().workbenchBundle);
      if (field === "coverage")
        record.coverage.components[0]!.subject.contentDigest = `sha256:${sha("9")}`;
      if (field === "paths") {
        record.report.components[0]!.paths = ["other.json"];
        record.observations[0]!.reportComponentDigest =
          `sha256:${canonicalStrictJsonSha256V1({ version: "packaged-report-component/v1", component: record.report.components[0] })}`;
      }
      if (field === "tree") record.report.components[0]!.treeSha256 = sha("9");
      if (field === "verdict") Object.assign(record.report.components[0]!, { verdict: "blocked" });
      if (field === "findings")
        Object.assign(record.report.components[0]!, {
          findings: [{ code: "test-finding", detail: "Retain this finding" }],
        });
      expect(() => encodePackagedScannerCollectionEvidenceRecordV1(record)).toThrow(
        /projection digest|report component digest|report coverage paths/,
      );
    },
  );
  it("projects an exact current report and retains an expired report's historical outcome", () => {
    const bundle = tinyStudioModel().workbenchBundle;
    records.push(encodePackagedScannerCollectionEvidenceRecordV1(sealedFixture(bundle)));

    const overlay = packagedScannerCollectionOverlayV1(bundle);
    expect(overlay["evidence:fixture:control"]).toMatchObject({
      verification: {
        state: "verified",
        verifiedAt: "2026-06-04T00:00:00.000Z",
        validUntil: "2026-08-30T00:00:00Z",
      },
      scan: { outcome: "pass", coverage: "complete", reportSignedAt: "2026-06-01T00:00:00.000Z" },
    });
    expect(overlay["evidence:fixture:external"]).toMatchObject({
      verification: {
        state: "verified",
        verifiedAt: "2026-06-04T00:00:00.000Z",
        validUntil: "2026-08-31T00:00:00Z",
      },
      scan: { outcome: "pass", coverage: "complete", reportSignedAt: "2026-06-02T00:00:00.000Z" },
    });
  });

  it("does not project when the assembled source identity differs", () => {
    const bundle = tinyStudioModel().workbenchBundle;
    records.push(encodePackagedScannerCollectionEvidenceRecordV1(sealedFixture(bundle)));
    bundle.sources["source:fixture-core"]!.revision.id = "revision:changed";

    expect(packagedScannerCollectionOverlayV1(bundle)).toEqual({});
  });

  it("rejects incomplete or duplicate component provenance", () => {
    const bundle = tinyStudioModel().workbenchBundle;
    const record = sealedFixture(bundle);
    expect(() =>
      encodePackagedScannerCollectionEvidenceRecordV1({
        ...record,
        observations: [record.observations[0]!, record.observations[0]!],
      }),
    ).toThrow(/duplicate component observation/);
    expect(() =>
      encodePackagedScannerCollectionEvidenceRecordV1({
        ...record,
        observations: [record.observations[0]!],
      }),
    ).toThrow(/lacks observation/);
  });

  it("refuses an invalid static seal before parsing it", () => {
    records.push({ bytes: "{}", sha256: `sha256:${sha("0")}` });
    expect(() => packagedScannerCollectionEvidenceV1()).toThrow(/seal mismatch/);
  });
});
