import { evidenceExpiryV1, evidenceIsCurrentV1 } from "../../../evidence-freshness.js";
import type {
  AuthoringAssetV1,
  AuthoringCatalogBundleV1,
  EvidenceSummaryV1,
} from "../contracts.js";

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
        now >= validUntil ||
        (summary.scan.reportSignedAt !== undefined &&
          !evidenceIsCurrentV1(summary.scan.reportSignedAt, undefined, now))));
  if (stale) return { state: "stale", text: "evidence: stale" };

  return {
    state: verification.state,
    text: `evidence: ${verification.state} · ${summary.scan.outcome}/${summary.scan.coverage}${summary.scan.scope === "published-component-containment" ? " · shared source-file coverage" : ""}`,
  };
}

/** Reads an independent Core projection; never treats a scan outcome as qualification. */
export function qualificationDisplayFor(
  asset: AuthoringAssetV1,
  bundle: AuthoringCatalogBundleV1,
  now = Date.now(),
): { state: "none" | "current" | "expired" | "not-yet-valid"; text: string } {
  const summary = bundle.qualifications?.[asset.id];
  const source = bundle.sources[asset.sourceId];
  if (
    summary === undefined ||
    source === undefined ||
    summary.assetId !== asset.id ||
    summary.sourceId !== asset.sourceId ||
    summary.sourceRevisionId !== asset.sourceRevisionId ||
    summary.contentDigest !== asset.contentDigest ||
    summary.sourceContentDigest !== source.revision.contentDigest
  )
    return { state: "none", text: "No Catalog qualification is included for this exact version." };
  const state =
    now < Date.parse(summary.notBefore) || now < Date.parse(summary.verifiedAt)
      ? "not-yet-valid"
      : evidenceIsCurrentV1(summary.originalIssuedAt, summary.validUntil, now)
        ? "current"
        : "expired";
  const label =
    state === "current"
      ? "Catalog qualification current"
      : state === "expired"
        ? "Catalog qualification expired"
        : "Catalog qualification not yet valid";
  let expiry = "unavailable";
  try {
    expiry = evidenceExpiryV1(summary.originalIssuedAt, summary.validUntil);
  } catch {
    /* Invalid dates remain non-current. */
  }
  return {
    state,
    text: `${label}. Issued ${summary.originalIssuedAt}; valid from ${summary.notBefore} until ${expiry}. Scope: ${summary.scope.description}. Published by ${summary.publisher.repository}@${summary.publisher.commit}. This does not grant organization approval.`,
  };
}
