import type { AuthoringAssetV1, EvidenceSummaryV1 } from "../contracts.js";

export type EvidenceDisplayState = "none" | "verified" | "unverified" | "missing" | "stale";

export interface EvidenceDisplay {
  state: EvidenceDisplayState;
  text: string;
}

function isExactSubject(asset: AuthoringAssetV1, evidence: EvidenceSummaryV1): boolean {
  return evidence.subjects.some(
    (subject) =>
      subject.assetId === asset.id &&
      subject.sourceId === asset.sourceId &&
      subject.sourceRevisionId === asset.sourceRevisionId &&
      subject.contentDigest === asset.contentDigest,
  );
}

/**
 * Displays Core-prepared evidence facts only. The browser neither verifies
 * evidence nor grants authority; it marks a verified summary stale outside
 * the prepared validity interval.
 */
export function evidenceDisplayFor(
  asset: AuthoringAssetV1,
  summaries: readonly EvidenceSummaryV1[],
  now = Date.now(),
): EvidenceDisplay {
  const summary = summaries.find((candidate) => isExactSubject(asset, candidate));
  if (summary === undefined) return { state: "none", text: "evidence: none prepared" };

  const verification = summary.verification;
  const verifiedAt =
    verification.verifiedAt === undefined ? Number.NaN : Date.parse(verification.verifiedAt);
  const validUntil =
    verification.validUntil === undefined ? Number.NaN : Date.parse(verification.validUntil);
  const stale =
    verification.state === "stale" ||
    (verification.state === "verified" &&
      (!Number.isFinite(verifiedAt) ||
        !Number.isFinite(validUntil) ||
        now < verifiedAt ||
        now >= validUntil));
  if (stale) return { state: "stale", text: "evidence: stale" };

  return {
    state: verification.state,
    text: `evidence: ${verification.state} · ${summary.scan.outcome}/${summary.scan.coverage} · ${summary.qualification.state}`,
  };
}
