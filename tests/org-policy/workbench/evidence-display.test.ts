import { describe, expect, it } from "vitest";
import type {
  AuthoringAssetV1,
  EvidenceSummaryV1,
} from "../../../src/org-policy/workbench/contracts.js";
import { evidenceDisplayFor } from "../../../src/org-policy/workbench/ui/evidence-display.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const asset: AuthoringAssetV1 = {
  id: "control:one",
  sourceId: "source:one",
  sourceRevisionId: "rev:one",
  contentDigest: digest("a"),
  originalPath: "control.json",
  derivation: "built-in",
  kind: "control",
  label: "Control",
  detailChunkId: "detail:one",
  declaredHostCapabilities: [],
  authoring: { action: "record-selection", supportedTargets: [] },
};
function summary(overrides: Partial<EvidenceSummaryV1> = {}): EvidenceSummaryV1 {
  return {
    id: "evidence:one",
    projectionVersion: "evidence-summary/v1",
    subjects: [
      {
        assetId: asset.id,
        sourceId: asset.sourceId,
        sourceRevisionId: asset.sourceRevisionId,
        contentDigest: asset.contentDigest,
      },
    ],
    evidenceDigest: digest("b"),
    coveredPaths: ["control.json"],
    verification: {
      state: "verified",
      verifiedAt: "2026-01-01T00:00:00.000Z",
      contextDigest: digest("c"),
      validUntil: "2026-01-02T00:00:00.000Z",
    },
    scan: { outcome: "pass", coverage: "complete" },
    qualification: { state: "unqualified" },
    findings: [],
    ...overrides,
  };
}

describe("browser evidence display", () => {
  it("requires an exact immutable subject", () => {
    for (const subjects of [
      [],
      [{ ...summary().subjects[0]!, sourceId: "source:other" }],
      [{ ...summary().subjects[0]!, sourceRevisionId: "rev:other" }],
      [{ ...summary().subjects[0]!, contentDigest: digest("d") }],
    ])
      expect(
        evidenceDisplayFor(asset, [summary({ subjects })], Date.parse("2026-01-01T12:00:00.000Z")),
      ).toMatchObject({ state: "none" });
  });
  it("uses explicit validity boundaries and preserves independent axes", () => {
    expect(
      evidenceDisplayFor(asset, [summary()], Date.parse("2025-12-31T23:59:59.000Z")),
    ).toMatchObject({ state: "stale" });
    expect(
      evidenceDisplayFor(asset, [summary()], Date.parse("2026-01-02T00:00:00.000Z")),
    ).toMatchObject({ state: "stale" });
    expect(evidenceDisplayFor(asset, [summary()], Date.parse("2026-01-01T12:00:00.000Z"))).toEqual({
      state: "verified",
      text: "evidence: verified · pass/complete · unqualified",
    });
  });
  it("never upgrades stale failed evidence into authority", () => {
    expect(
      evidenceDisplayFor(
        asset,
        [
          summary({
            verification: { state: "stale" },
            scan: { outcome: "failed", coverage: "complete" },
          }),
        ],
        Date.parse("2026-01-01T12:00:00.000Z"),
      ),
    ).toEqual({ state: "stale", text: "evidence: stale" });
  });
});
