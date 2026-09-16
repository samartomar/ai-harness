import { canonicalStrictJsonSha256V1 } from "../../../contract/strict-json-v1.js";
import { evidenceExpiryV1 } from "../../../evidence-freshness.js";
import { packagedScannerCollectionEvidenceV1 } from "../../packaged-collection-evidence-v1.js";
import type { AuthoringCatalogBundleV1 } from "../contracts.js";
import {
  type WorkbenchReferenceReportsV1,
  WorkbenchReferenceReportsV1Schema,
} from "../reference-reports.js";

/**
 * Read-only history from sealed package records. An unchanged item identity does
 * not prove that the entire current catalog was scanned. Keep this out of the
 * bundle's evidence map and out of every adoption/release decision.
 */
export function packagedWorkbenchReferenceReportsV1(
  bundle: AuthoringCatalogBundleV1,
): WorkbenchReferenceReportsV1 {
  const result: WorkbenchReferenceReportsV1 = {};
  for (const record of packagedScannerCollectionEvidenceV1()) {
    if (record.catalog.id !== "aih" || record.catalog.source.upstreamOrigin.kind !== "aih")
      continue;
    const source = bundle.sources[record.catalog.source.id];
    if (
      source === undefined ||
      source.id !== record.catalog.source.id ||
      source.revision.id !== record.catalog.source.revisionId ||
      source.revision.contentDigest === record.catalog.source.contentDigest ||
      source.inputFormat !== record.catalog.source.inputFormat ||
      source.upstreamOrigin.kind !== record.catalog.source.upstreamOrigin.kind ||
      source.upstreamOrigin.locator !== record.catalog.source.upstreamOrigin.locator
    )
      continue;
    const recordDigest = `sha256:${canonicalStrictJsonSha256V1(record)}`;
    for (const component of record.coverage.components) {
      const asset = bundle.assets[component.subject.assetId];
      if (
        asset === undefined ||
        asset.id !== component.subject.assetId ||
        component.componentId !== `asset:${createHash("sha256").update(asset.id).digest("hex")}` ||
        asset.sourceId !== component.subject.sourceId ||
        asset.sourceId !== source.id ||
        asset.sourceRevisionId !== component.subject.sourceRevisionId ||
        asset.contentDigest !== component.subject.contentDigest ||
        asset.derivation !== "built-in"
      )
        continue;
      // Already attached reports own their display; history must not suggest
      // a missing current report when an independent evidence route supplied it.
      if (
        Object.values(bundle.evidence).some(
          (evidence) =>
            evidence.verification.state !== "missing" &&
            evidence.subjects.some(
              (subject) =>
                subject.assetId === asset.id &&
                subject.sourceId === asset.sourceId &&
                subject.sourceRevisionId === asset.sourceRevisionId &&
                subject.contentDigest === asset.contentDigest,
            ),
        )
      )
        continue;
      const report = record.report.components.find((item) => item.id === component.componentId);
      const observation = record.observations.find(
        (item) => item.componentId === component.componentId,
      );
      if (report === undefined || observation === undefined) continue;
      const publication = record.publications.find(
        (item) =>
          item.requestSha256 === observation.requestSha256 &&
          item.publicationSha256 === observation.publicationSha256 &&
          item.receiptSha256 === observation.receiptSha256,
      );
      if (publication === undefined) continue;
      result[asset.id] = {
        kind: "previous-catalog-report",
        authority: "none",
        assetId: asset.id,
        subject: { ...component.subject },
        previousSourceContentDigest: record.catalog.source.contentDigest,
        currentSourceContentDigest: source.revision.contentDigest,
        componentTreeDigest: `sha256:${component.componentTreeSha256}`,
        coveredPaths: [...component.paths].sort(),
        reportSignedAt: observation.reportSignedAt,
        publishedAt: publication.publishedAt,
        validUntil: evidenceExpiryV1(observation.reportSignedAt),
        outcome: report.verdict === "blocked" ? "failed" : "pass",
        analyzers: report.analyzers.map((analyzer) => ({ ...analyzer })),
        findings: report.findings
          .slice(0, 50)
          .map((finding) => `${finding.code}: ${finding.detail}`.slice(0, 1_000)),
        publicationUrl: publication.publicationLocator,
        publicationDigest: `sha256:${publication.publicationSha256}`,
        recordDigest,
      };
    }
  }
  return WorkbenchReferenceReportsV1Schema.parse(result);
}

import { createHash } from "node:crypto";
