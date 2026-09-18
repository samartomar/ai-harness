/** The evidence delivery a Workbench model may carry (browser-safe type). */
export interface StudioEvidenceDelivery {
  coreVersion: string;
  workbenchCatalogDigest: string;
  vendorLockDigest: string;
  scannerLibraryVersion: string;
  freshnessDays?: number;
  expectedCatalogPublisher?: {
    repository: string;
    workflow: string;
    catalogCommit: string;
    version: number;
  };
  scanPublications?: Array<{ source: string; publisher: string; commit: string; digest: string }>;
  qualificationPublications?: Array<{
    publisher: string;
    commit: string;
    catalogDigest: string;
    receiptSetDigest: string;
  }>;
  expectedScannerPublisher: { repository: string; workflow: string; ref: string; commit: string };
  publicBaseline?: {
    publisher: string;
    workflow: string;
    artifactDigest: string;
    verifiedAt: string;
    validUntil: string;
  };
}

/**
 * The "Evidence & versions" rows (label, value) the Workbench shows for a
 * model's evidence delivery, or undefined when the model carries none. Pure,
 * so the legacy template and the new shell's organization screen render the
 * same rows.
 */
export function evidenceDeliveryRows(model: {
  readonly evidenceDelivery?: StudioEvidenceDelivery | undefined;
  readonly catalogProvenance?:
    | { readonly sourceId: string; readonly channel: string; readonly resolvedAt: string }
    | undefined;
}): Array<[string, string]> | undefined {
  const delivery = model.evidenceDelivery;
  if (!delivery) return undefined;
  const rows: Array<[string, string]> = [
    ["Core package", `@aihq/core ${delivery.coreVersion}`],
    ["This Workbench catalog", delivery.workbenchCatalogDigest],
    ["Bundled report lock", delivery.vendorLockDigest],
    ["Core Scanner library input", `@aihq/scan ${delivery.scannerLibraryVersion}`],
    [
      "Allowed Scanner publisher",
      `${delivery.expectedScannerPublisher.repository}@${delivery.expectedScannerPublisher.commit}`,
    ],
  ];
  const baseline = delivery.publicBaseline;
  if (delivery.expectedCatalogPublisher)
    rows.push([
      "Allowed Catalog publisher",
      `${delivery.expectedCatalogPublisher.repository}@${delivery.expectedCatalogPublisher.catalogCommit} · qualification consumer policy v${delivery.expectedCatalogPublisher.version}`,
    ]);
  rows.push([
    "Freshness policy",
    `Reports and qualifications expire after ${delivery.freshnessDays ?? 90} days from their original signed dates; earlier signed qualification expiry wins. A changed version needs matching evidence.`,
  ]);
  for (const publication of delivery.scanPublications ?? [])
    rows.push([
      `${publication.source} Scanner publication`,
      `${publication.publisher}@${publication.commit} · ${publication.digest}`,
    ]);
  if (baseline) {
    rows.push(
      ["Included evidence publisher", `${baseline.publisher} · ${baseline.workflow}`],
      [
        "Verification during Core release preparation",
        `${baseline.verifiedAt}; valid until ${baseline.validUntil}`,
      ],
      ["Verified artifact digest", baseline.artifactDigest],
    );
  } else if (!delivery.scanPublications?.length)
    rows.push([
      "Prepared public evidence",
      "Not included in this build. Bundled report claims have not acquired verified publication provenance.",
    ]);
  for (const publication of delivery.qualificationPublications ?? [])
    rows.push([
      "Included Catalog qualification publication",
      `${publication.publisher}@${publication.commit} · catalog ${publication.catalogDigest} · receipt set ${publication.receiptSetDigest}`,
    ]);
  if (model.catalogProvenance) {
    rows.push([
      "Catalog delivery",
      `${model.catalogProvenance.sourceId} · ${model.catalogProvenance.channel} · resolved ${model.catalogProvenance.resolvedAt}`,
    ]);
  } else if (!delivery.qualificationPublications?.length)
    rows.push([
      "Catalog head",
      "No verified Catalog head is included in this build; no item qualification is claimed.",
    ]);
  return rows;
}

export const EVIDENCE_DELIVERY_NOTE =
  "The library and allowed publisher are preparation inputs. Each item’s security review describes the report actually included. A scan does not grant organization approval.";
