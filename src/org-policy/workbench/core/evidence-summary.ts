import { evidenceIsCurrentV1 } from "../../../evidence-freshness.js";
import {
  CatalogQualificationSummariesV1Schema,
  type EvidenceSummaryV1,
  EvidenceSummaryV1Schema,
} from "../contracts.js";

/**
 * Returns true only for a current, fully positive evidence display. This is a
 * presentation predicate: it never grants custody or turns imported evidence
 * into a Core-prepared value. The actual Scanner/vendor boundary is solely
 * responsible for producing verified summaries.
 */
export function hasPositiveEvidenceDisplayV1(
  value: EvidenceSummaryV1 | unknown,
  now: Date,
  qualifications: unknown = {},
): boolean {
  const summary = EvidenceSummaryV1Schema.safeParse(value);
  if (!summary.success || summary.data.verification.state !== "verified") return false;
  const { verifiedAt, validUntil } = summary.data.verification;
  if (verifiedAt === undefined || validUntil === undefined) return false;
  const verifiedAtMs = Date.parse(verifiedAt);
  const validUntilMs = Date.parse(validUntil);
  if (!Number.isFinite(verifiedAtMs) || !Number.isFinite(validUntilMs)) return false;
  const nowMs = now.getTime();
  const catalog = CatalogQualificationSummariesV1Schema.safeParse(qualifications);
  if (!catalog.success) return false;
  return (
    verifiedAtMs <= nowMs &&
    nowMs < validUntilMs &&
    summary.data.scan.coverage === "complete" &&
    summary.data.scan.outcome === "pass" &&
    (summary.data.scan.reportSignedAt === undefined ||
      evidenceIsCurrentV1(summary.data.scan.reportSignedAt, undefined, nowMs)) &&
    summary.data.subjects.every((subject) => {
      const qualification = catalog.data[subject.assetId];
      return (
        qualification !== undefined &&
        qualification.sourceId === subject.sourceId &&
        qualification.sourceRevisionId === subject.sourceRevisionId &&
        qualification.contentDigest === subject.contentDigest &&
        Date.parse(qualification.verifiedAt) <= nowMs &&
        Date.parse(qualification.notBefore) <= nowMs &&
        evidenceIsCurrentV1(qualification.originalIssuedAt, qualification.validUntil, nowMs)
      );
    })
  );
}
