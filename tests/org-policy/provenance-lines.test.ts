/**
 * The two provenance sentences, present and absent. `studio-template.ts` wraps
 * them in its own markup and the Workbench's Evidence & versions drawer writes
 * them as text, so the composition itself is pinned here once.
 */
import { describe, expect, it } from "vitest";
import {
  baselineEvidenceProvenanceTextV1,
  catalogProvenanceTextV1,
} from "../../src/org-policy/provenance-lines.js";

describe("catalogProvenanceTextV1", () => {
  it("is absent when the model resolved no administrator catalog", () => {
    expect(catalogProvenanceTextV1({})).toBeUndefined();
    expect(catalogProvenanceTextV1({ catalogProvenance: undefined })).toBeUndefined();
  });

  it("names the tier, source, channel, resolution, age and bootstrap", () => {
    expect(
      catalogProvenanceTextV1({
        catalogProvenance: {
          tier: "supported",
          sourceId: "aihq-catalog",
          channel: "stable",
          resolvedAt: "2026-09-19T00:00:00Z",
          ageSeconds: 42,
          bootstrapProvenance: "packaged",
        },
      }),
    ).toBe(
      "Supported catalog · verified supported · source aihq-catalog (stable) · resolved 2026-09-19T00:00:00Z · 42s since download · bootstrap packaged",
    );
  });

  it("says a packaged fallback has no download age", () => {
    expect(
      catalogProvenanceTextV1({
        catalogProvenance: {
          tier: "supported",
          sourceId: "packaged",
          channel: "bundled",
          resolvedAt: "2026-09-19T00:00:00Z",
          ageSeconds: null,
          bootstrapProvenance: "packaged",
        },
      }),
    ).toContain("packaged fallback (no download age)");
  });
});

describe("baselineEvidenceProvenanceTextV1", () => {
  it("is absent when the model resolved no baseline evidence", () => {
    expect(baselineEvidenceProvenanceTextV1({})).toBeUndefined();
    expect(
      baselineEvidenceProvenanceTextV1({ baselineEvidenceProvenance: undefined }),
    ).toBeUndefined();
  });

  it("names the tier, sources, schema, digest, age and resolution", () => {
    expect(
      baselineEvidenceProvenanceTextV1({
        baselineEvidenceProvenance: {
          tier: "verified",
          sourceIds: ["public", "vendor"],
          schemaVersion: 2,
          digest: "sha256:abc",
          ageSeconds: 7,
          resolvedAt: "2026-09-19T00:00:00Z",
        },
      }),
    ).toBe(
      "Baseline evidence · verified · sources public,vendor · schema 2 · digest sha256:abc · age 7s · resolved 2026-09-19T00:00:00Z",
    );
  });

  it("says a packaged fallback in place of an age", () => {
    expect(
      baselineEvidenceProvenanceTextV1({
        baselineEvidenceProvenance: {
          tier: "verified",
          sourceIds: [],
          schemaVersion: 1,
          digest: "sha256:def",
          ageSeconds: null,
          resolvedAt: "2026-09-19T00:00:00Z",
        },
      }),
    ).toContain("age packaged fallback");
  });
});
