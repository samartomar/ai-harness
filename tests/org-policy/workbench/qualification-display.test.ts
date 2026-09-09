import { describe, expect, it } from "vitest";
import type {
  CatalogQualificationSummaryV1,
  EvidenceSummaryV1,
} from "../../../src/org-policy/workbench/contracts.js";
import { hasPositiveEvidenceDisplayV1 } from "../../../src/org-policy/workbench/core/evidence-summary.js";
import { createWorkbenchState } from "../../../src/org-policy/workbench/selection-engine.js";
import {
  assetEvidencePresentation,
  sourceEvidenceSummary,
} from "../../../src/org-policy/workbench/ui/catalog-presentation.js";
import { qualificationDisplayFor } from "../../../src/org-policy/workbench/ui/evidence-display.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

const digest = `sha256:${"a".repeat(64)}`;
function fixture() {
  const bundle = structuredClone(tinyStudioModel().workbenchBundle);
  const asset = Object.values(bundle.assets)[0];
  if (asset === undefined) throw new Error("Fixture requires an asset.");
  const source = bundle.sources[asset.sourceId];
  if (source === undefined) throw new Error("Fixture requires a source.");
  const qualification: CatalogQualificationSummaryV1 = {
    projectionVersion: "catalog-qualification-summary/v1",
    state: "qualified",
    assetId: asset.id,
    sourceId: asset.sourceId,
    sourceRevisionId: asset.sourceRevisionId,
    sourceContentDigest: source.revision.contentDigest,
    contentDigest: asset.contentDigest,
    subjectDigest: digest,
    publisher: {
      repository: "example/catalog",
      workflow: "example/catalog/.github/workflows/publish.yml",
      ref: "refs/heads/main",
      issuer: "https://token.actions.githubusercontent.com",
      commit: "a".repeat(40),
    },
    receiptDigest: digest,
    receiptSetDigest: digest,
    catalogDigest: digest,
    catalogHeadDigest: digest,
    catalogMemberDigest: digest,
    closureDigest: digest,
    compilerBindingDigest: digest,
    contextDigest: digest,
    verifiedAt: "2026-09-02T00:00:00Z",
    originalIssuedAt: "2026-09-01T00:00:00Z",
    notBefore: "2026-09-01T00:00:00Z",
    validUntil: "2026-11-30T00:00:00Z",
    scope: { kind: "source-files", description: "Pinned skill source files" },
  };
  const evidence: EvidenceSummaryV1 = {
    id: "evidence:test",
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
    coveredPaths: ["skills/test/SKILL.md"],
    verification: {
      state: "verified",
      verifiedAt: "2026-09-02T00:00:00Z",
      validUntil: "2026-12-01T00:00:00Z",
      contextDigest: digest,
    },
    scan: {
      outcome: "failed",
      coverage: "complete",
      reportSignedAt: "2026-06-01T00:00:00Z",
      publishedAt: "2026-06-02T00:00:00Z",
    },
    qualification: { state: "qualified" },
    findings: ["Outbound access needs review."],
  };
  bundle.qualifications = { [asset.id]: qualification };
  bundle.evidence = { [evidence.id]: evidence };
  return { bundle, asset, qualification, evidence };
}

describe("independent report and Catalog dates", () => {
  it("keeps findings in the source review count even with current passing evidence and qualification", () => {
    const { bundle, asset, evidence } = fixture();
    evidence.scan = {
      outcome: "pass",
      coverage: "complete",
      reportSignedAt: "2026-09-02T00:00:00Z",
    };
    const now = Date.parse("2026-09-07T00:00:00Z");
    const state = createWorkbenchState();
    const withFindings = sourceEvidenceSummary(bundle, asset.sourceId, state, now);
    evidence.findings = [];
    const cleared = sourceEvidenceSummary(bundle, asset.sourceId, state, now);
    expect(withFindings.needsReview).toBe(cleared.needsReview + 1);
    expect(withFindings.reportsWithConcerns).toBe(cleared.reportsWithConcerns + 1);
    expect(withFindings.currentReports).toBe(cleared.currentReports);
  });
  it("requires independently current Catalog facts for a positive combined display", () => {
    const { bundle, evidence } = fixture();
    const now = new Date("2026-09-07T00:00:00Z");
    evidence.scan = {
      outcome: "pass",
      coverage: "complete",
      reportSignedAt: "2026-09-02T00:00:00Z",
    };
    expect(hasPositiveEvidenceDisplayV1(evidence, now)).toBe(false);
    expect(hasPositiveEvidenceDisplayV1(evidence, now, bundle.qualifications)).toBe(true);
    evidence.scan.reportSignedAt = "2026-06-01T00:00:00Z";
    expect(hasPositiveEvidenceDisplayV1(evidence, now, bundle.qualifications)).toBe(false);
  });
  it("retains old concerns without treating a current qualification as a fresh scan", () => {
    const { bundle, asset, evidence } = fixture();
    const display = assetEvidencePresentation(asset, bundle, Date.parse("2026-09-07T00:00:00Z"));
    expect(display).toMatchObject({
      state: "stale",
      qualificationState: "qualified",
      findings: evidence.findings,
    });
    expect(display.findingsLabel).toContain("Historical");
    expect(display.freshness).toContain("Report signed 2026-06-01");
    expect(display.qualification).toContain("Issued 2026-09-01");
    bundle.evidence = {};
    expect(
      assetEvidencePresentation(asset, bundle, Date.parse("2026-09-07T00:00:00Z")),
    ).toMatchObject({ state: "none", qualificationState: "qualified" });
  });
  it("keeps the earlier Catalog expiry even when a new scan passes", () => {
    const { bundle, asset, qualification, evidence } = fixture();
    qualification.validUntil = "2026-09-05T00:00:00Z";
    evidence.scan.reportSignedAt = "2026-09-02T00:00:00Z";
    evidence.scan.publishedAt = "2026-09-03T00:00:00Z";
    evidence.scan.outcome = "pass";
    expect(
      assetEvidencePresentation(asset, bundle, Date.parse("2026-09-07T00:00:00Z")),
    ).toMatchObject({
      state: "verified",
      qualificationState: "unknown",
      qualification: expect.stringContaining("expired"),
    });
  });
  it("bounds both clocks at 90 days and ignores a later intake or repackaging date", () => {
    const { bundle, asset, qualification } = fixture();
    qualification.validUntil = "2027-09-01T00:00:00Z";
    qualification.verifiedAt = "2026-11-29T00:00:00Z";
    expect(qualificationDisplayFor(asset, bundle, Date.parse("2026-11-29T23:59:59Z")).state).toBe(
      "current",
    );
    expect(qualificationDisplayFor(asset, bundle, Date.parse("2026-11-30T00:00:00Z")).state).toBe(
      "expired",
    );
  });
  it("does not carry qualification across a source or content change", () => {
    for (const field of [
      "sourceId",
      "sourceRevisionId",
      "contentDigest",
      "sourceContentDigest",
    ] as const) {
      const { bundle, asset, qualification } = fixture();
      qualification[field] = "changed";
      expect(qualificationDisplayFor(asset, bundle).state).toBe("none");
    }
  });
});
