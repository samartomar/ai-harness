import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../../src/org-policy/studio-model.js";
import { inspectWorkbenchEvidenceCoverageV1 } from "../../../src/org-policy/workbench/delivery-readiness.js";
import { prepareWorkbenchEvidenceCompositionsForReleaseV1 } from "../../../src/org-policy/workbench/providers/evidence-compositions.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

describe("Workbench release evidence coverage", () => {
  it("requires an exact current report for every bundled asset, including new providers", () => {
    const bundle = structuredClone(tinyStudioModel().workbenchBundle);
    bundle.evidence = {};
    const now = "2026-09-07T00:00:00Z";
    const initial = inspectWorkbenchEvidenceCoverageV1(bundle, now);
    expect(initial.ready).toBe(false);
    expect(initial.assets).toHaveLength(Object.keys(bundle.assets).length);
    expect(initial.assets.every((asset) => asset.problem === "report-missing")).toBe(true);
    for (const asset of Object.values(bundle.assets)) {
      const id = `evidence:${asset.id}`;
      bundle.evidence[id] = {
        id,
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
        coveredPaths: ["fixture.json"],
        verification: {
          state: "verified",
          verifiedAt: "2026-09-06T00:00:00Z",
          validUntil: "2026-09-08T00:00:00Z",
          contextDigest: `sha256:${"b".repeat(64)}`,
        },
        scan: { outcome: "failed", coverage: "complete" },
        qualification: { state: "unqualified" },
        findings: ["A real concern must remain visible; it is not missing scan coverage."],
      };
    }
    const complete = inspectWorkbenchEvidenceCoverageV1(bundle, now);
    expect(complete.ready).toBe(true);
    expect(complete.assets.every((asset) => asset.reportedOutcome === "failed")).toBe(true);
    const report = Object.values(bundle.evidence)[0];
    if (report === undefined) throw new Error("expected fixture evidence");
    const verified = report.verification;
    report.verification = { state: "unverified" };
    expect(inspectWorkbenchEvidenceCoverageV1(bundle, now).assets[0]?.problem).toBe(
      "report-unverified",
    );
    report.verification = verified;
    expect(
      inspectWorkbenchEvidenceCoverageV1(bundle, "2026-09-08T00:00:00Z").assets.every(
        (asset) => asset.problem === "report-stale",
      ),
    ).toBe(true);
    expect(
      inspectWorkbenchEvidenceCoverageV1(bundle, "2026-09-05T00:00:00Z").assets.every(
        (asset) => asset.problem === "report-stale",
      ),
    ).toBe(true);
    report.scan.coverage = "partial";
    expect(inspectWorkbenchEvidenceCoverageV1(bundle, now).assets[0]?.problem).toBe(
      "coverage-incomplete",
    );
    report.scan.coverage = "complete";
    report.scan.outcome = "unknown";
    expect(inspectWorkbenchEvidenceCoverageV1(bundle, now).assets[0]?.problem).toBe(
      "outcome-unknown",
    );
    report.scan.outcome = "failed";
    bundle.evidence.duplicate = { ...report, id: "duplicate" };
    expect(inspectWorkbenchEvidenceCoverageV1(bundle, now).assets[0]?.problem).toBe(
      "report-ambiguous",
    );
    delete bundle.evidence.duplicate;
    report.verification = { state: "verified" };
    expect(inspectWorkbenchEvidenceCoverageV1(bundle, now).assets[0]?.problem).toBe(
      "report-invalid",
    );
    report.verification = verified;
    const subject = report.subjects[0];
    if (subject === undefined) throw new Error("expected fixture subject");
    subject.contentDigest = `sha256:${"c".repeat(64)}`;
    expect(inspectWorkbenchEvidenceCoverageV1(bundle, now).assets[0]?.problem).toBe(
      "report-missing",
    );
    expect(inspectWorkbenchEvidenceCoverageV1(bundle, "2026-09-08T00:00:00Z").ready).toBe(false);
    expect(() => inspectWorkbenchEvidenceCoverageV1(bundle, "not a date")).toThrow();
    Object.assign(bundle.evidence, { malformed: null });
    expect(inspectWorkbenchEvidenceCoverageV1(bundle, now).invalidEvidenceIds).toContain(
      "malformed",
    );
    bundle.assets = {};
    expect(inspectWorkbenchEvidenceCoverageV1(bundle, now).ready).toBe(false);
  });
});
function currentVerifiedReport(asset: {
  id: string;
  sourceId: string;
  sourceRevisionId: string;
  contentDigest: string;
}) {
  return {
    id: `evidence:${asset.id}`,
    projectionVersion: "evidence-summary/v1" as const,
    subjects: [
      {
        assetId: asset.id,
        sourceId: asset.sourceId,
        sourceRevisionId: asset.sourceRevisionId,
        contentDigest: asset.contentDigest,
      },
    ],
    evidenceDigest: `sha256:${"a".repeat(64)}`,
    coveredPaths: ["fixture.json"],
    verification: {
      state: "verified" as const,
      verifiedAt: "2026-09-06T00:00:00Z",
      validUntil: "2026-09-08T00:00:00Z",
      contextDigest: `sha256:${"b".repeat(64)}`,
    },
    scan: { outcome: "pass" as const, coverage: "complete" as const },
    qualification: { state: "unknown" as const },
    findings: [],
  };
}

function fullyReportedProductionBundle() {
  const bundle = structuredClone(policyStudioModel().workbenchBundle);
  bundle.evidence = Object.fromEntries(
    Object.values(bundle.assets).map((asset) => {
      const report = currentVerifiedReport(asset);
      return [report.id, report];
    }),
  );
  return bundle;
}

describe("Core-derived methodology composition evidence", () => {
  it("uses an injected code-owned composition only after every upstream constituent has a current report", () => {
    const bundle = fullyReportedProductionBundle();
    const releaseCompositions = prepareWorkbenchEvidenceCompositionsForReleaseV1(bundle);
    const now = "2026-09-07T00:00:00Z";

    expect(inspectWorkbenchEvidenceCoverageV1(bundle, now).assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assetId: "ecc/profile:methodology",
          problem: "composition-missing",
        }),
        expect.objectContaining({
          assetId: "superpowers/profile:methodology",
          problem: "composition-missing",
        }),
        expect.objectContaining({
          assetId: "ponytail/profile:methodology",
          problem: "composition-missing",
        }),
      ]),
    );
    expect(
      inspectWorkbenchEvidenceCoverageV1(bundle, now, releaseCompositions).assets.filter(
        (asset) => asset.problem,
      ),
    ).toEqual([]);

    const constituent = Object.values(bundle.assets).find(
      (asset) => asset.sourceId === "source:ecc" && asset.derivation === "upstream",
    );
    if (constituent === undefined) throw new Error("expected ECC constituent");
    delete bundle.evidence[`evidence:${constituent.id}`];
    expect(
      inspectWorkbenchEvidenceCoverageV1(bundle, now, releaseCompositions).assets.find(
        (asset) => asset.assetId === "ecc/profile:methodology",
      )?.problem,
    ).toBe("constituent-evidence-incomplete");
  });

  it("keeps a failed constituent structurally covered, but never treats a synthetic profile report as proof", () => {
    const bundle = fullyReportedProductionBundle();
    const releaseCompositions = prepareWorkbenchEvidenceCompositionsForReleaseV1(bundle);
    const now = "2026-09-07T00:00:00Z";
    const constituent = Object.values(bundle.assets).find(
      (asset) => asset.sourceId === "source:ponytail" && asset.derivation === "upstream",
    );
    if (constituent === undefined) throw new Error("expected Ponytail constituent");
    const report = bundle.evidence[`evidence:${constituent.id}`];
    if (report === undefined) throw new Error("expected Ponytail evidence");
    report.scan.outcome = "failed";

    const composed = inspectWorkbenchEvidenceCoverageV1(bundle, now, releaseCompositions);
    expect(
      composed.assets.find((asset) => asset.assetId === "ponytail/profile:methodology")?.problem,
    ).toBeUndefined();
    expect(composed.assets.find((asset) => asset.assetId === constituent.id)?.reportedOutcome).toBe(
      "failed",
    );

    const withoutCompositions = inspectWorkbenchEvidenceCoverageV1(bundle, now);
    const missing = withoutCompositions.assets.find(
      (asset) => asset.assetId === "ponytail/profile:methodology",
    );
    expect(missing?.problem).toBe("composition-missing");
    expect(missing?.reportedOutcome).toBeUndefined();
  });

  it("fails closed for invalid composition material, including cyclic relationships", () => {
    const bundle = fullyReportedProductionBundle();
    bundle.relations.push({
      fromAssetId: "ponytail/skill:ponytail",
      toAssetId: "ponytail/profile:methodology",
      kind: "requires",
    });
    const compositions = prepareWorkbenchEvidenceCompositionsForReleaseV1(bundle);
    expect(
      inspectWorkbenchEvidenceCoverageV1(bundle, "2026-09-07T00:00:00Z", compositions).assets.find(
        (asset) => asset.assetId === "ponytail/profile:methodology",
      )?.problem,
    ).toBe("composition-invalid");
  });
});
