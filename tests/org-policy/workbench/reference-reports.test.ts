import { describe, expect, it, vi } from "vitest";
import * as packagedCollection from "../../../src/org-policy/packaged-collection-evidence-v1.js";
import {
  packagedScannerCollectionEvidenceV1,
  projectScannerCollectionEvidenceV1,
} from "../../../src/org-policy/packaged-collection-evidence-v1.js";
import { packagedWorkbenchReferenceReportsV1 } from "../../../src/org-policy/workbench/core/packaged-reference-reports.js";
import { defaultPreparedWorkbenchCatalog } from "../../../src/org-policy/workbench/prepared-catalog.js";
import { WorkbenchReferenceReportsV1Schema } from "../../../src/org-policy/workbench/reference-reports.js";

const matchingIds = [
  "aih/context7",
  "aih/github",
  "aih/package:skill-pack/docs-quality",
  "aih/package:skill-pack/governance-quality",
  "aih/package:skill-pack/review-quality",
  "aih/usage-metering",
].sort();

describe("previous catalog reports", () => {
  it("shows exact historical subjects without adding current evidence or changing policy", () => {
    const bundle = defaultPreparedWorkbenchCatalog().bundle;
    const before = JSON.stringify(bundle);
    const reports = packagedWorkbenchReferenceReportsV1(bundle);
    expect(Object.keys(reports).sort()).toEqual(matchingIds);
    expect(WorkbenchReferenceReportsV1Schema.parse(reports)).toEqual(reports);
    expect(JSON.stringify(bundle)).toBe(before);
    const record = packagedScannerCollectionEvidenceV1().find((item) => item.catalog.id === "aih")!;
    expect(projectScannerCollectionEvidenceV1(bundle, [record])).toEqual({});
    for (const [id, report] of Object.entries(reports)) {
      const component = record.coverage.components.find((item) => item.subject.assetId === id)!;
      const observation = record.observations.find(
        (item) => item.componentId === component.componentId,
      )!;
      expect(report.authority).toBe("none");
      expect(report.subject).toEqual(component.subject);
      expect(report.componentTreeDigest).toBe(`sha256:${component.componentTreeSha256}`);
      expect(report.coveredPaths).toEqual([...component.paths].sort());
      expect(report.reportSignedAt).toBe(observation.reportSignedAt);
      expect(report.previousSourceContentDigest).toBe(record.catalog.source.contentDigest);
      expect(report.currentSourceContentDigest).not.toBe(report.previousSourceContentDigest);
      expect(report.publicationDigest).toBe(`sha256:${observation.publicationSha256}`);
      expect(bundle.evidence[`evidence:${id}`]).toBeUndefined();
    }
  });

  it.each(["contentDigest", "sourceRevisionId", "sourceId", "derivation"])(
    "does not associate a previous report with a changed %s",
    (field) => {
      const bundle = structuredClone(defaultPreparedWorkbenchCatalog().bundle);
      Object.assign(bundle.assets["aih/github"]!, {
        [field]: field === "contentDigest" ? `sha256:${"0".repeat(64)}` : "different",
      });
      expect(packagedWorkbenchReferenceReportsV1(bundle)["aih/github"]).toBeUndefined();
    },
  );

  it("requires the original source identity and does not duplicate current reports", () => {
    const bundle = structuredClone(defaultPreparedWorkbenchCatalog().bundle);
    const record = packagedScannerCollectionEvidenceV1().find((item) => item.catalog.id === "aih")!;
    const source = bundle.sources[record.catalog.source.id]!;
    source.upstreamOrigin.locator = "different";
    expect(packagedWorkbenchReferenceReportsV1(bundle)).toEqual({});
    source.upstreamOrigin.locator = record.catalog.source.upstreamOrigin.locator;
    source.revision.contentDigest = record.catalog.source.contentDigest;
    expect(packagedWorkbenchReferenceReportsV1(bundle)).toEqual({});
    expect(Object.keys(projectScannerCollectionEvidenceV1(bundle, [record])).sort()).toEqual(
      matchingIds.map((id) => `evidence:${id}`).sort(),
    );
  });

  it("rejects foreign publication links and cross-item display records", () => {
    const reports = structuredClone(
      packagedWorkbenchReferenceReportsV1(defaultPreparedWorkbenchCatalog().bundle),
    );
    const report = reports["aih/github"]!;
    report.publicationUrl = "https://example.com/publication.json";
    expect(WorkbenchReferenceReportsV1Schema.safeParse(reports).success).toBe(false);
    report.publicationUrl =
      "https://github.com/samartomar/aih-scan/releases/download/baseline-v1-" +
      "a".repeat(40) +
      "-" +
      "b".repeat(64) +
      "/publication.json";
    report.subject.assetId = "aih/context7";
    expect(WorkbenchReferenceReportsV1Schema.safeParse(reports).success).toBe(false);
  });

  it("defers to an independently attached current report", () => {
    const bundle = structuredClone(defaultPreparedWorkbenchCatalog().bundle);
    const record = packagedScannerCollectionEvidenceV1().find((item) => item.catalog.id === "aih")!;
    const originalSourceDigest = bundle.sources[record.catalog.source.id]!.revision.contentDigest;
    bundle.sources[record.catalog.source.id]!.revision.contentDigest =
      record.catalog.source.contentDigest;
    const evidence = projectScannerCollectionEvidenceV1(bundle, [record])["evidence:aih/github"]!;
    bundle.sources[record.catalog.source.id]!.revision.contentDigest = originalSourceDigest;
    bundle.evidence[evidence.id] = evidence;
    expect(packagedWorkbenchReferenceReportsV1(bundle)["aih/github"]).toBeUndefined();
  });

  it("rejects cross-wired first-party component identities even in a schema-valid sealed record", () => {
    const bundle = defaultPreparedWorkbenchCatalog().bundle;
    const record = structuredClone(
      packagedScannerCollectionEvidenceV1().find((item) => item.catalog.id === "aih")!,
    );
    const github = record.coverage.components.find(
      (item) => item.subject.assetId === "aih/github",
    )!;
    const context7 = record.coverage.components.find(
      (item) => item.subject.assetId === "aih/context7",
    )!;
    [github.subject, context7.subject] = [context7.subject, github.subject];
    record.catalog.coverageProjectionDigest = packagedCollection.packagedCoverageProjectionDigestV1(
      record.coverage,
    );
    expect(() =>
      packagedCollection.encodePackagedScannerCollectionEvidenceRecordV1(record),
    ).not.toThrow();
    const loader = vi
      .spyOn(packagedCollection, "packagedScannerCollectionEvidenceV1")
      .mockReturnValue([record]);
    try {
      const reports = packagedWorkbenchReferenceReportsV1(bundle);
      expect(reports["aih/github"]).toBeUndefined();
      expect(reports["aih/context7"]).toBeUndefined();
    } finally {
      loader.mockRestore();
    }
  });

  it("keeps historical reports readable when current evidence is only a missing placeholder", () => {
    const bundle = structuredClone(defaultPreparedWorkbenchCatalog().bundle);
    const asset = bundle.assets["aih/github"]!;
    bundle.evidence["placeholder"] = {
      id: "placeholder",
      projectionVersion: "evidence-summary/v1",
      subjects: [
        {
          assetId: asset.id,
          sourceId: asset.sourceId,
          sourceRevisionId: asset.sourceRevisionId,
          contentDigest: asset.contentDigest,
        },
      ],
      evidenceDigest: `sha256:${"a".repeat(64)}`,
      coveredPaths: [],
      verification: { state: "missing" },
      scan: { outcome: "unknown", coverage: "none" },
      qualification: { state: "unknown" },
      findings: [],
    };
    expect(packagedWorkbenchReferenceReportsV1(bundle)["aih/github"]).toBeDefined();
  });
});
