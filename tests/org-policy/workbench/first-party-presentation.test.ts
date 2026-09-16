import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../../src/org-policy/studio-model.js";
import {
  assetDecisionPresentation,
  assetEvidencePresentation,
} from "../../../src/org-policy/workbench/ui/catalog-presentation.js";

describe("bundled Core component presentation", () => {
  it("identifies bundled skills, agents and hooks separately from missing scan evidence", () => {
    const bundle = policyStudioModel().workbenchBundle;
    bundle.evidence = {};
    bundle.qualifications = {};
    const before = JSON.stringify({
      evidence: bundle.evidence,
      qualifications: bundle.qualifications,
    });
    for (const asset of Object.values(bundle.assets).filter(
      (item) =>
        item.sourceId === "source:aih-core" && ["skill", "agent", "hook"].includes(item.kind),
    )) {
      const report = assetEvidencePresentation(asset, bundle);
      expect(report).toMatchObject({
        component: { label: "Included with Core", path: asset.originalPath },
        state: "none",
        tone: "neutral",
        qualificationState: "unknown",
        reportedResult: undefined,
        statusLabel: "Current scan report not attached",
      });
      expect(assetDecisionPresentation(asset, bundle).evidenceLabel).toBe("Included with Core");
    }
    expect(
      JSON.stringify({ evidence: bundle.evidence, qualifications: bundle.qualifications }),
    ).toBe(before);
    const mcp = bundle.assets["aih/sequential-thinking"];
    if (mcp === undefined) throw new Error("Expected the bundled sequential-thinking MCP");
    expect(assetEvidencePresentation(mcp, bundle).component).toBeUndefined();
  });

  it("does not label imported lookalikes as bundled Core components", () => {
    const bundle = policyStudioModel().workbenchBundle;
    const asset = bundle.assets["aih/package:skill-pack/docs-quality"];
    if (asset === undefined) throw new Error("Expected the bundled docs-quality component");
    const source = bundle.sources[asset.sourceId];
    if (source === undefined) throw new Error("Expected the bundled Core source");
    bundle.sources[asset.sourceId] = {
      ...source,
      upstreamOrigin: { kind: "organization", locator: "example" },
    };
    expect(assetEvidencePresentation(asset, bundle).component).toBeUndefined();
    expect(assetDecisionPresentation(asset, bundle).evidenceLabel).not.toBe("Included with Core");
  });

  it("keeps a first-party report's concerns visible instead of replacing them with inclusion", () => {
    const bundle = policyStudioModel().workbenchBundle;
    const asset = bundle.assets["aih/package:skill-pack/docs-quality"];
    if (asset === undefined) throw new Error("Expected the bundled docs-quality component");
    bundle.evidence = {
      "evidence:concerns": {
        id: "evidence:concerns",
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
        coveredPaths: [asset.originalPath],
        verification: { state: "unverified" },
        scan: { outcome: "failed", coverage: "complete" },
        qualification: { state: "unknown" },
        findings: ["A finding that still needs review"],
      },
    };
    expect(assetDecisionPresentation(asset, bundle).evidenceLabel).toBe(
      "Concerns reported · review incomplete",
    );
    expect(assetEvidencePresentation(asset, bundle)).toMatchObject({
      component: { label: "Included with Core" },
      tone: "warning",
      reportedResult: "Concerns found",
      findings: ["A finding that still needs review"],
    });
  });
});
