import { evidenceIsCurrentV1 } from "../../evidence-freshness.js";
import {
  type AuthoringCatalogBundleV1,
  type EvidenceSummaryV1,
  EvidenceSummaryV1Schema,
} from "./contracts.js";
import {
  resolveWorkbenchEvidenceCompositionV1,
  type WorkbenchEvidenceCompositionsV1,
} from "./providers/evidence-compositions.js";

export type WorkbenchEvidenceCoverageProblemV1 =
  | "report-missing"
  | "report-invalid"
  | "report-ambiguous"
  | "report-unverified"
  | "report-stale"
  | "coverage-incomplete"
  | "outcome-unknown"
  | "composition-missing"
  | "composition-invalid"
  | "constituent-evidence-incomplete";

type AssetAssessment = {
  assetId: string;
  sourceId: string;
  sourceRevisionId: string;
  contentDigest: string;
  report?: EvidenceSummaryV1;
  problem?: WorkbenchEvidenceCoverageProblemV1;
};

function reportProblem(
  reports: readonly EvidenceSummaryV1[],
  invalid: boolean,
  clock: number,
): WorkbenchEvidenceCoverageProblemV1 | undefined {
  const report = reports[0];
  if (invalid) return "report-invalid";
  if (report === undefined || report.verification.state === "missing") return "report-missing";
  if (reports.length !== 1) return "report-ambiguous";
  if (report.verification.state === "stale") return "report-stale";
  if (report.verification.state !== "verified") return "report-unverified";
  if (
    clock < Date.parse(report.verification.verifiedAt ?? "") ||
    clock >= Date.parse(report.verification.validUntil ?? "") ||
    (report.scan.reportSignedAt !== undefined &&
      !evidenceIsCurrentV1(report.scan.reportSignedAt, undefined, clock))
  )
    return "report-stale";
  if (report.scan.coverage !== "complete") return "coverage-incomplete";
  if (report.scan.outcome === "unknown") return "outcome-unknown";
  return undefined;
}

/**
 * Delivery inspection only. Compositions are opaque Core release inputs: they can
 * establish structural coverage for their derived profile, never scan outcome,
 * qualification, evidence custody, or any upstream constituent's readiness.
 */
export function inspectWorkbenchEvidenceCoverageV1(
  bundle: AuthoringCatalogBundleV1,
  now: string,
  compositions?: WorkbenchEvidenceCompositionsV1,
) {
  const clock = Date.parse(now);
  if (!Number.isFinite(clock)) throw new Error("Evidence coverage requires a valid clock.");
  const byAsset = new Map<string, EvidenceSummaryV1[]>();
  const invalidEvidenceIds: string[] = [];
  const invalidAssetIds = new Set<string>();
  for (const [id, value] of Object.entries(bundle.evidence)) {
    const parsed = EvidenceSummaryV1Schema.safeParse(value);
    if (!parsed.success) {
      invalidEvidenceIds.push(id);
      // Subject diagnostics are parsed independently; never traverse malformed values.
      const subjects = EvidenceSummaryV1Schema.shape.subjects.safeParse(
        typeof value === "object" && value !== null ? value.subjects : undefined,
      );
      if (subjects.success)
        for (const subject of subjects.data) invalidAssetIds.add(subject.assetId);
      continue;
    }
    const report = parsed.data;
    for (const subject of report.subjects) {
      const asset = bundle.assets[subject.assetId];
      if (
        asset === undefined ||
        subject.sourceId !== asset.sourceId ||
        subject.sourceRevisionId !== asset.sourceRevisionId ||
        subject.contentDigest !== asset.contentDigest
      )
        continue;
      const reports = byAsset.get(asset.id) ?? [];
      if (!reports.includes(report)) reports.push(report);
      byAsset.set(asset.id, reports);
    }
  }
  const assessments = Object.values(bundle.assets)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map<AssetAssessment>((asset) => {
      const reports = byAsset.get(asset.id) ?? [];
      const report = reports[0];
      return {
        assetId: asset.id,
        sourceId: asset.sourceId,
        sourceRevisionId: asset.sourceRevisionId,
        contentDigest: asset.contentDigest,
        ...(report === undefined ? {} : { report }),
        ...(reportProblem(reports, invalidAssetIds.has(asset.id), clock) === undefined
          ? {}
          : { problem: reportProblem(reports, invalidAssetIds.has(asset.id), clock) }),
      };
    });
  const byId = new Map(assessments.map((assessment) => [assessment.assetId, assessment]));
  for (const assessment of assessments) {
    const composition = resolveWorkbenchEvidenceCompositionV1(
      bundle,
      compositions,
      assessment.assetId,
    );
    if (composition === undefined) continue;
    // A Scanner-shaped report for a core-derived profile never supplies proof or scan facts.
    delete assessment.report;
    if (invalidAssetIds.has(assessment.assetId)) {
      assessment.problem = "report-invalid";
      continue;
    }
    if (composition.state === "missing") {
      assessment.problem = "composition-missing";
      continue;
    }
    if (composition.state === "invalid") {
      assessment.problem = "composition-invalid";
      continue;
    }
    if (composition.constituentAssetIds.some((assetId) => byId.get(assetId)?.problem !== undefined))
      assessment.problem = "constituent-evidence-incomplete";
    else delete assessment.problem;
  }
  const assets = assessments.map(({ report: _report, ...assessment }) => ({
    ...assessment,
    ...(_report === undefined ? {} : { reportedOutcome: _report.scan.outcome }),
  }));
  // An empty catalog and malformed global evidence must not satisfy a packaged delivery gate.
  return {
    ready:
      invalidEvidenceIds.length === 0 &&
      assets.length > 0 &&
      assets.every((asset) => !asset.problem),
    assets,
    invalidEvidenceIds: invalidEvidenceIds.sort(),
  };
}
