import { describe, expect, it } from "vitest";
import type {
  AuthoringAssetV1,
  EvidenceSummaryV1,
} from "../../../src/org-policy/workbench/contracts.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../../src/org-policy/workbench/selection-engine.js";
import {
  assetDecisionPresentation,
  assetDetailsPresentation,
  assetEvidencePresentation,
  catalogAssetState,
  catalogRowPresentation,
  findingExplanation,
  humanizedAssetLabel,
  normalizedCatalogBrowseFilters,
  sourceEvidenceSummary,
  visibleCatalogKindOptions,
} from "../../../src/org-policy/workbench/ui/catalog-presentation.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

const options = [
  { id: "skill", label: "Skills", count: 2 },
  { id: "agent", label: "Agents", count: 0 },
  { id: "profile", label: "Profiles", count: 0 },
] as const;

describe("catalog presentation", () => {
  it("explains a known external connection rule without guessing unknown findings", () => {
    expect(findingExplanation("[trust.external-egress] link to api.fontshare.com")).toContain(
      "remote font or stylesheet",
    );
    expect(findingExplanation("unknown.rule: something happened")).toBeUndefined();
    expect(findingExplanation("not-trust.external-egress-else")).toBeUndefined();
  });
  it("binds the evidence sheet to the actual validity interval without invented scan metadata", () => {
    const bundle = structuredClone(tinyStudioModel().workbenchBundle);
    const asset = Object.values(bundle.assets)[0]!;
    const evidence: EvidenceSummaryV1 = {
      id: "evidence:sheet",
      projectionVersion: "evidence-summary/v1",
      subjects: [
        {
          assetId: asset.id,
          sourceId: asset.sourceId,
          sourceRevisionId: asset.sourceRevisionId,
          contentDigest: asset.contentDigest,
        },
      ],
      evidenceDigest: "sha256:" + "a".repeat(64),
      coveredPaths: ["skills/", "shared-mcp.json"],
      verification: {
        state: "verified",
        verifiedAt: "2026-09-01T00:00:00.000Z",
        validUntil: "2026-09-08T00:00:00.000Z",
        contextDigest: "sha256:" + "b".repeat(64),
      },
      scan: {
        outcome: "failed",
        coverage: "partial",
        analyzers: [{ name: "example-analyzer", version: "1.2.3" }],
      },
      qualification: { state: "unqualified" },
      findings: ["Review outbound access in shared configuration."],
    };
    bundle.evidence = { [evidence.id]: evidence };
    const now = Date.parse("2026-09-07T00:00:00Z");
    const empty = createWorkbenchState();
    const total = Object.values(bundle.assets).filter(
      (item) => item.sourceId === asset.sourceId,
    ).length;
    expect(sourceEvidenceSummary(bundle, asset.sourceId, empty, now)).toEqual({
      totalAssets: total,
      includedReports: 1,
      reportsWithConcerns: 1,
      currentReports: 1,
      needsReview: total,
      choicesInDraft: 0,
    });
    evidence.scan = { outcome: "pass", coverage: "complete" };
    expect(assetEvidencePresentation(asset, bundle, now)).toMatchObject({
      statusLabel: "Findings to review",
      tone: "warning",
      findings: evidence.findings,
    });
    expect(sourceEvidenceSummary(bundle, asset.sourceId, empty, now).needsReview).toBe(total);
    evidence.scan.scope = "published-component-containment";
    expect(assetEvidencePresentation(asset, bundle, now).coverage).toContain(
      "broader source report",
    );
    expect(assetEvidencePresentation(asset, bundle, now).statusLabel).toBe("Findings to review");
    delete evidence.scan.scope;
    evidence.qualification = { state: "qualified" };
    expect(sourceEvidenceSummary(bundle, asset.sourceId, empty, now).needsReview).toBe(total);
    const selected = reduceWorkbenchAction(bundle, empty, {
      type: asset.authoring.action === "record-request" ? "record-request" : "select-root",
      assetId: asset.id,
      origin: { kind: "administrator" },
    }).state;
    expect(sourceEvidenceSummary(bundle, asset.sourceId, selected, now).choicesInDraft).toBe(1);
    expect(sourceEvidenceSummary(bundle, "source:absent", selected, now)).toEqual({
      totalAssets: 0,
      includedReports: 0,
      reportsWithConcerns: 0,
      currentReports: 0,
      needsReview: 0,
      choicesInDraft: 0,
    });
    evidence.scan = {
      outcome: "failed",
      coverage: "partial",
      analyzers: [{ name: "example-analyzer", version: "1.2.3" }],
    };
    evidence.qualification = { state: "unqualified" };
    const current = assetEvidencePresentation(asset, bundle, Date.parse("2026-09-07T00:00:00Z"));
    expect(current).toMatchObject({
      state: "verified",
      statusLabel: "Scan found concerns",
      scopePaths: ["skills/", "shared-mcp.json"],
      findings: evidence.findings,
    });
    expect(current.freshness).toContain("Core verified this evidence at 2026-09-01");
    expect(current.freshness).toContain("scanner run date is not supplied");
    expect(current.coverage).toContain("Partial scan coverage");
    expect(current.limitation).toContain("does not approve, install, or grant access");
    for (const now of ["2026-08-31T23:59:59Z", "2026-09-08T00:00:00Z"]) {
      expect(sourceEvidenceSummary(bundle, asset.sourceId, empty, Date.parse(now))).toMatchObject({
        currentReports: 0,
        needsReview: total,
      });
      expect(assetEvidencePresentation(asset, bundle, Date.parse(now))).toMatchObject({
        state: "stale",
        findings: evidence.findings,
        scopePaths: evidence.coveredPaths,
      });
    }
    evidence.verification = { state: "unverified" };
    expect(assetEvidencePresentation(asset, bundle)).toMatchObject({
      state: "unverified",
      tone: "warning",
      statusLabel: "Concerns reported · review incomplete",
      reportedResult: "Concerns found",
      analyzers: [{ name: "example-analyzer", version: "1.2.3" }],
      showQualification: true,
      qualification: "No Catalog qualification is included for this exact version.",
      findingsLabel: "Report findings",
      findings: evidence.findings,
      coverage: expect.stringContaining("Reported coverage:"),
    });
    expect(sourceEvidenceSummary(bundle, asset.sourceId, empty, now).reportsWithConcerns).toBe(1);
    evidence.scan.outcome = "pass";
    expect(assetEvidencePresentation(asset, bundle).statusLabel).toBe(
      "Findings reported · review incomplete",
    );
    evidence.findings = [];
    expect(assetEvidencePresentation(asset, bundle).statusLabel).toBe(
      "Limited scan coverage · review incomplete",
    );
    evidence.scan.coverage = "complete";
    expect(assetEvidencePresentation(asset, bundle).tone).toBe("neutral");
    expect(assetEvidencePresentation(asset, bundle).statusLabel).toBe("Security review incomplete");
    evidence.scan.outcome = "unknown";
    expect(assetEvidencePresentation(asset, bundle).tone).toBe("warning");
    expect(assetEvidencePresentation(asset, bundle).statusLabel).toBe(
      "Inconclusive scan · review incomplete",
    );
    evidence.subjects[0]!.contentDigest = "sha256:" + "c".repeat(64);
    expect(sourceEvidenceSummary(bundle, asset.sourceId, empty, now)).toMatchObject({
      currentReports: 0,
      reportsWithConcerns: 0,
      needsReview: total,
    });
    expect(assetEvidencePresentation(asset, bundle)).toMatchObject({
      state: "none",
      reportedResult: undefined,
      analyzers: [],
      findings: [],
      scopePaths: [],
      statusLabel: "Report not attached",
    });
  });
  it("puts source purpose, access and draft consequence before technical metadata", () => {
    const bundle = structuredClone(tinyStudioModel().workbenchBundle);
    const asset = Object.values(bundle.assets).find(
      (item) => item.authoring.action === "record-request",
    )!;
    const chunk = bundle.detailChunks[asset.detailChunkId]!;
    bundle.detailChunks[asset.detailChunkId] = {
      ...chunk,
      bytes: JSON.stringify({
        decision: {
          purpose: "Find documentation for the library you are using.",
          access: "Queries go to the documentation provider.",
        },
        declaration: { reason: "This transport is not supported by the managed control." },
      }),
    };
    expect(assetDecisionPresentation(asset, bundle)).toMatchObject({
      purpose: "Find documentation for the library you are using.",
      access: "Queries go to the documentation provider.",
      consequence: expect.stringContaining("pending request"),
      evidenceLabel: "Report not attached",
      needsInformation: true,
    });
    expect(assetDetailsPresentation(asset, bundle).facts).toContainEqual({
      label: "Why this needs follow-up",
      value: "This transport is not supported by the managed control.",
    });
    bundle.detailChunks[asset.detailChunkId] = {
      ...chunk,
      bytes: JSON.stringify({ asset: { metadata: { allowedTools: ["Read", "Bash"] } } }),
    };
    expect(assetDecisionPresentation(asset, bundle)).toMatchObject({
      needsInformation: true,
      access:
        "Tools named by the source: Read, Bash. Actual access depends on the host's permissions.",
    });
    bundle.detailChunks[asset.detailChunkId] = { ...chunk, bytes: "malformed" };
    expect(assetDecisionPresentation(asset, bundle)).toMatchObject({
      needsInformation: true,
      evidenceLabel: "Report not attached",
    });
  });

  it("hides source-empty kinds and clears an impossible type selection", () => {
    expect(visibleCatalogKindOptions({ sourceId: "source:one" }, options)).toEqual([
      { id: "skill", label: "Skills", count: 2 },
    ]);
    expect(visibleCatalogKindOptions({}, options)).toEqual(options);
    expect(
      normalizedCatalogBrowseFilters({ sourceId: "source:one", kind: "agent", page: 4 }, options),
    ).toEqual({ sourceId: "source:one", kind: undefined, page: 0 });
    expect(
      normalizedCatalogBrowseFilters({ sourceId: "source:one", kind: "skill", page: 4 }, options),
    ).toEqual({ sourceId: "source:one", kind: "skill", page: 4 });
  });

  it("uses plain request, control, dependency, and explicit-exclusion language", () => {
    const bundle = tinyStudioModel().workbenchBundle;
    const request = Object.values(bundle.assets).find(
      (asset) => asset.authoring.action === "record-request",
    );
    if (request === undefined) throw new Error("expected a request asset");
    const control: AuthoringAssetV1 = {
      ...request,
      authoring: {
        action: "select-control",
        projectorId: "usage-hook",
        supportedTargets: ["codex"],
      },
    };

    expect(
      catalogRowPresentation({
        asset: request,
        state: "available",
        nextAction: "record-request",
        explicitAdministratorExclusion: false,
        hasNonAdministratorExclusion: false,
      }),
    ).toMatchObject({
      status: "Not in draft",
      primaryAction: "Request review",
      exclusionAction: "Exclude from optional groups",
    });
    expect(
      catalogRowPresentation({
        asset: control,
        state: "selected",
        nextAction: "remove-root",
        explicitAdministratorExclusion: false,
        hasNonAdministratorExclusion: false,
      }),
    ).toMatchObject({
      status: "In your draft",
      primaryAction: "Remove my choice",
      explanation: expect.stringContaining("not been evaluated"),
    });
    expect(
      catalogRowPresentation({
        asset: request,
        state: "dependency",
        explicitAdministratorExclusion: true,
        hasNonAdministratorExclusion: false,
      }),
    ).toMatchObject({
      status: "Included as a dependency",
      exclusionAction: "Undo my exclusion",
      explanation: expect.stringContaining("requires"),
    });
  });

  it("keeps template direct roots direct and names administrator exclusion actions", () => {
    expect(
      catalogAssetState({
        excluded: false,
        requested: false,
        structuralDirect: false,
        directSelect: true,
        selected: true,
      }),
    ).toBe("selected");
    expect(
      catalogAssetState({
        excluded: false,
        requested: false,
        structuralDirect: true,
        directSelect: true,
        selected: true,
      }),
    ).toBe("structural");
    expect(
      catalogAssetState({
        excluded: true,
        requested: true,
        structuralDirect: false,
        directSelect: false,
        selected: false,
      }),
    ).toBe("requested");
    expect(
      catalogAssetState({
        excluded: true,
        requested: false,
        structuralDirect: true,
        directSelect: false,
        selected: true,
      }),
    ).toBe("structural");
    const asset = Object.values(tinyStudioModel().workbenchBundle.assets)[0];
    if (asset === undefined) throw new Error("expected asset");
    expect(humanizedAssetLabel({ ...asset, label: "package:skill-pack/docs-quality" })).toBe(
      "Docs Quality",
    );
    expect(humanizedAssetLabel({ ...asset, label: "codebase-memory-mcp" })).toBe(
      "Codebase Memory MCP",
    );
    expect(
      catalogRowPresentation({
        asset,
        state: "excluded",
        explicitAdministratorExclusion: false,
        hasNonAdministratorExclusion: true,
      }),
    ).toMatchObject({
      status: "Excluded by a saved origin",
      exclusionAction: "Exclude from optional groups",
    });
  });

  it("bounds visible purpose text without changing advanced prepared bytes", () => {
    const model = tinyStudioModel();
    const sourceAsset = Object.values(model.workbenchBundle.assets).find(
      (asset) => asset.authoring.action === "record-request",
    );
    if (sourceAsset === undefined) throw new Error("expected request asset");

    const detailsFor = (description: string) => {
      const bundle = structuredClone(model.workbenchBundle);
      const chunk = bundle.detailChunks[sourceAsset.detailChunkId];
      if (chunk === undefined) throw new Error("expected detail chunk");
      bundle.detailChunks[sourceAsset.detailChunkId] = {
        ...chunk,
        bytes: JSON.stringify({ declaration: { description } }),
      };
      return assetDetailsPresentation(sourceAsset, bundle);
    };

    expect(detailsFor("  First\n\tpurpose  ").summary).toBe("First purpose");
    for (const unsafe of ["hidden\u202Etext", "zero\u200Bwidth", "a".repeat(2_001)])
      expect(detailsFor(unsafe).summary).toBe(
        "The source has not supplied a description. Review its documentation before choosing this item.",
      );
    expect(detailsFor("hidden\u202Etext").advancedJson).toContain("\u202e");
  });

  it("shows stated metadata purpose and makes missing prepared evidence non-passing", () => {
    const bundle = structuredClone(tinyStudioModel().workbenchBundle);
    const asset = Object.values(bundle.assets).find(
      (candidate) => candidate.authoring.action === "record-request",
    );
    if (asset === undefined) throw new Error("expected a request asset");
    const detailChunk = bundle.detailChunks[asset.detailChunkId];
    if (detailChunk === undefined) throw new Error("expected prepared detail chunk");
    bundle.detailChunks[asset.detailChunkId] = {
      ...detailChunk,
      bytes: JSON.stringify({
        declaration: {
          description: "First-party claim-first, evidence-grounded documentation skill.",
        },
      }),
    };

    const presentation = assetDetailsPresentation(asset, bundle);

    expect(presentation.title).not.toBe("");
    expect(presentation.summary).toBe(
      "First-party claim-first, evidence-grounded documentation skill.",
    );
    expect(presentation.advancedJson).toContain(asset.id);
    expect(presentation.facts.some((fact) => fact.label === "Technical ID")).toBe(false);
    expect(presentation.facts).toContainEqual({
      label: "Security review",
      value: expect.stringContaining("Report not attached"),
    });
    expect(presentation.advancedJson).toContain("evidence-grounded documentation skill");

    const missingEvidence: EvidenceSummaryV1 = {
      id: "evidence:missing",
      projectionVersion: "evidence-summary/v1",
      subjects: [
        {
          assetId: asset.id,
          sourceId: asset.sourceId,
          sourceRevisionId: asset.sourceRevisionId,
          contentDigest: asset.contentDigest,
        },
      ],
      evidenceDigest: "sha256:" + "a".repeat(64),
      coveredPaths: ["catalog.json"],
      verification: { state: "missing" },
      scan: { outcome: "unknown", coverage: "none" },
      qualification: { state: "unknown" },
      findings: [],
    };
    bundle.evidence[missingEvidence.id] = missingEvidence;
    expect(assetDetailsPresentation(asset, bundle).facts).toContainEqual({
      label: "Security review",
      value: expect.stringContaining("Scan report missing"),
    });

    bundle.evidence = {
      "evidence:verified": {
        ...missingEvidence,
        id: "evidence:verified",
        verification: {
          state: "verified",
          verifiedAt: "2026-01-01T00:00:00.000Z",
          contextDigest: "sha256:" + "b".repeat(64),
          validUntil: "2027-01-02T00:00:00.000Z",
        },
        scan: { outcome: "pass", coverage: "complete" },
        qualification: { state: "qualified" },
      },
    };
    const verifiedFacts = assetDetailsPresentation(asset, bundle).facts;
    expect(verifiedFacts).toContainEqual({ label: "Scan result", value: "pass" });
    expect(verifiedFacts).toContainEqual({ label: "Coverage", value: "complete" });
    expect(verifiedFacts).toContainEqual({
      label: "Catalog qualification",
      value: "No Catalog qualification is included for this exact version.",
    });
    expect(verifiedFacts).toContainEqual({
      label: "Evidence verification",
      value: expect.stringContaining("not organization approval"),
    });

    const verified = bundle.evidence["evidence:verified"];
    if (verified === undefined) throw new Error("expected verified evidence");
    bundle.evidence = {
      "evidence:unverified": {
        ...verified,
        verification: { state: "unverified" },
        coveredPaths: ["shared-mcp.json"],
        findings: ["Review the other server's outbound endpoint in shared-mcp.json."],
      },
    };
    const unverifiedFacts = assetDetailsPresentation(asset, bundle).facts;
    expect(unverifiedFacts).toContainEqual({
      label: "Reported result",
      value: "pass",
    });
    expect(unverifiedFacts).toContainEqual({
      label: "Report findings",
      value: "Review the other server's outbound endpoint in shared-mcp.json.",
    });
    expect(unverifiedFacts).toContainEqual({
      label: "Scope of this report",
      value: expect.stringContaining("shared configuration"),
    });
    expect(
      unverifiedFacts.some(
        (fact) => fact.label === "Scan result" || fact.label === "Qualification",
      ),
    ).toBe(false);
    expect(assetDecisionPresentation(asset, bundle)).toMatchObject({
      evidenceLabel: "Findings reported · review incomplete",
      needsInformation: true,
    });
    const verifiedSubject = verified.subjects[0];
    if (verifiedSubject === undefined) throw new Error("expected verified subject");
    bundle.evidence = {
      "evidence:mismatched-digest": {
        ...verified,
        id: "evidence:mismatched-digest",
        subjects: [{ ...verifiedSubject, contentDigest: "sha256:" + "c".repeat(64) }],
      },
    };
    const mismatchedFacts = assetDetailsPresentation(asset, bundle).facts;
    expect(mismatchedFacts).toContainEqual({
      label: "Security review",
      value: expect.stringContaining("Report not attached"),
    });
    expect(mismatchedFacts).not.toContainEqual({ label: "Scan result", value: "pass" });
    expect(
      mismatchedFacts.some(
        (fact) => fact.label.includes("findings") || fact.label.includes("Scope"),
      ),
    ).toBe(false);
  });
});
