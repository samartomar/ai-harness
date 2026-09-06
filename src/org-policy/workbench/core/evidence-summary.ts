import { type EvidenceSummaryV1, EvidenceSummaryV1Schema } from "../contracts.js";

/**
 * Returns true only for a current, fully positive evidence display. This is a
 * presentation predicate: it never grants custody or turns imported evidence
 * into a Core-prepared value. The actual Scanner/vendor boundary is solely
 * responsible for producing verified summaries.
 */
export function hasPositiveEvidenceDisplayV1(
  value: EvidenceSummaryV1 | unknown,
  now: Date,
): boolean {
  const summary = EvidenceSummaryV1Schema.safeParse(value);
  if (!summary.success || summary.data.verification.state !== "verified") return false;
  const { verifiedAt, validUntil } = summary.data.verification;
  if (verifiedAt === undefined || validUntil === undefined) return false;
  const verifiedAtMs = Date.parse(verifiedAt);
  const validUntilMs = Date.parse(validUntil);
  if (!Number.isFinite(verifiedAtMs) || !Number.isFinite(validUntilMs)) return false;
  const nowMs = now.getTime();
  return (
    verifiedAtMs <= nowMs &&
    nowMs < validUntilMs &&
    summary.data.scan.coverage === "complete" &&
    summary.data.scan.outcome === "pass" &&
    summary.data.qualification.state === "qualified"
  );
}
