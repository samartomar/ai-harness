import { describe, expect, it } from "vitest";
import {
  planSyntheticMethodologyProjection,
  SyntheticMethodologyProjectionManifestSchema,
  SyntheticMethodologyProjectionPlanSchema,
  SyntheticMethodologyProjectionSchema,
} from "../../src/methodology/projection-planner.js";

function digest(seed: string): string {
  const encoded = [...seed]
    .map((character) => character.codePointAt(0)?.toString(16).padStart(2, "0") ?? "00")
    .join("");
  return `sha256:${encoded.slice(0, 64).padEnd(64, "0")}`;
}

function classifierArtifact(id: string, overrides: Record<string, unknown> = {}) {
  const { evidence: evidenceOverrides, ...artifactOverrides } = overrides;
  const path = `rules/${id}.md`;
  const sourceIdentity = {
    locator: `synthetic://fixture/${id}`,
    digest: digest(`source-${id}`),
  };
  const content = {
    classification: "passive",
    digest: digest(`content-${id}`),
  };
  const artifact = {
    id,
    path,
    kind: "regular",
    content,
    sourceIdentity,
    dependencies: [],
    ...artifactOverrides,
  };
  const evidence = evidenceOverrides as
    | {
        target?: Record<string, unknown>;
        source?: "exact" | "drifted";
        trust?: "admitted" | "held";
        license?: "allowed" | "unlicensed";
      }
    | undefined;
  const { target: targetOverrides, ...evidenceFields } = evidence ?? {};

  return {
    ...artifact,
    evidence: {
      target: {
        artifact: artifact.id,
        path: artifact.path,
        sourceIdentity: artifact.sourceIdentity,
        contentDigest: artifact.content.digest,
        ...targetOverrides,
      },
      source: "exact",
      trust: "admitted",
      license: "allowed",
      ...evidenceFields,
    },
  };
}

function classifierInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    roots: ["review-loop"],
    artifacts: [classifierArtifact("review-loop")],
    ...overrides,
  };
}

function mapping(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    target: {
      path: `methodology/v1/rules/${id}.md`,
      owner: "aih-methodology-v1",
    },
    ...overrides,
  };
}

function projection(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    classification: classifierInput(),
    mappings: [mapping("review-loop")],
    ...overrides,
  };
}

describe("synthetic methodology projection planner", () => {
  it("creates a deterministic host-neutral manifest from eligible synthetic entries", () => {
    const forward = planSyntheticMethodologyProjection(
      projection({
        classification: classifierInput({
          roots: ["review-loop", "method-routing"],
          artifacts: [classifierArtifact("review-loop"), classifierArtifact("method-routing")],
        }),
        mappings: [mapping("review-loop"), mapping("method-routing")],
      }),
    );
    const reverse = planSyntheticMethodologyProjection(
      projection({
        classification: classifierInput({
          roots: ["method-routing", "review-loop"],
          artifacts: [classifierArtifact("method-routing"), classifierArtifact("review-loop")],
        }),
        mappings: [mapping("method-routing"), mapping("review-loop")],
      }),
    );

    const entries = [
      {
        id: "method-routing",
        source: {
          locator: "synthetic://fixture/method-routing",
          sourceDigest: digest("source-method-routing"),
          contentDigest: digest("content-method-routing"),
        },
        target: "methodology/v1/rules/method-routing.md",
      },
      {
        id: "review-loop",
        source: {
          locator: "synthetic://fixture/review-loop",
          sourceDigest: digest("source-review-loop"),
          contentDigest: digest("content-review-loop"),
        },
        target: "methodology/v1/rules/review-loop.md",
      },
    ];
    expect(forward).toMatchObject({
      schemaVersion: 1,
      state: "planned",
      manifest: {
        schemaVersion: 2,
        digestVersion: "methodology-projection-digest-v2",
        owner: "aih-methodology-v1",
        admission: {
          policyVersion: "methodology-projection-admission-v2",
          classifierVersion: "synthetic-methodology-classifier-v2",
          closure: {
            schemaVersion: 1,
            roots: ["method-routing", "review-loop"],
            artifacts: [classifierArtifact("method-routing"), classifierArtifact("review-loop")],
          },
          eligibility: {
            disposition: "eligible",
            eligible: ["method-routing", "review-loop"],
          },
        },
        entries,
      },
      findings: [],
    });
    if (forward.state !== "planned" || forward.manifest === null) {
      throw new Error("test fixture must plan");
    }
    expect(forward.manifest.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(SyntheticMethodologyProjectionManifestSchema.parse(forward.manifest)).toEqual(
      forward.manifest,
    );
    expect(reverse).toEqual(forward);
  });

  it("changes the versioned manifest digest when only a dependency edge changes", () => {
    const unchanged = planSyntheticMethodologyProjection(
      projection({
        classification: classifierInput({
          roots: ["review-loop", "method-routing"],
          artifacts: [classifierArtifact("review-loop"), classifierArtifact("method-routing")],
        }),
        mappings: [mapping("review-loop"), mapping("method-routing")],
      }),
    );
    const changed = planSyntheticMethodologyProjection(
      projection({
        classification: classifierInput({
          roots: ["review-loop", "method-routing"],
          artifacts: [
            classifierArtifact("review-loop", { dependencies: ["method-routing"] }),
            classifierArtifact("method-routing"),
          ],
        }),
        mappings: [mapping("review-loop"), mapping("method-routing")],
      }),
    );

    if (
      unchanged.state !== "planned" ||
      unchanged.manifest === null ||
      changed.state !== "planned" ||
      changed.manifest === null
    ) {
      throw new Error("test fixtures must plan");
    }
    expect(changed.manifest.entries).toEqual(unchanged.manifest.entries);
    expect(changed.manifest.admission.closure).not.toEqual(unchanged.manifest.admission.closure);
    expect(changed.manifest.digest).not.toBe(unchanged.manifest.digest);
  });

  it("blocks colliding owned projection targets with a fixed finding", () => {
    const result = planSyntheticMethodologyProjection(
      projection({
        classification: classifierInput({
          roots: ["review-loop", "method-routing"],
          artifacts: [classifierArtifact("review-loop"), classifierArtifact("method-routing")],
        }),
        mappings: [
          mapping("review-loop", {
            target: { path: "methodology/v1/rules/shared.md", owner: "aih-methodology-v1" },
          }),
          mapping("method-routing", {
            target: { path: "methodology/v1/rules/shared.md", owner: "aih-methodology-v1" },
          }),
        ],
      }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      state: "blocked",
      manifest: null,
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_DESTINATION_COLLISION",
          disposition: "blocked",
          target: "methodology/v1/rules/shared.md",
        },
      ],
      boundary: {
        providerExecution: false,
        hostExecution: false,
        reads: false,
        writes: false,
        cli: false,
      },
    });
  });

  it.each([
    ["an external owner", { path: "methodology/v1/rules/review-loop.md", owner: "external" }],
    [
      "a target outside the owned root",
      { path: "foreign/v1/rules/review-loop.md", owner: "aih-methodology-v1" },
    ],
  ])("blocks %s", (_name, target) => {
    const result = planSyntheticMethodologyProjection(
      projection({ mappings: [mapping("review-loop", { target })] }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      state: "blocked",
      manifest: null,
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_TARGET_UNOWNED",
          disposition: "blocked",
          target: target.path,
        },
      ],
      boundary: {
        providerExecution: false,
        hostExecution: false,
        reads: false,
        writes: false,
        cli: false,
      },
    });
  });

  it("blocks classifier-denied source ambiguity without selecting an arbitrary source", () => {
    const result = planSyntheticMethodologyProjection(
      projection({
        classification: classifierInput({
          roots: ["review-loop", "method-routing"],
          artifacts: [
            classifierArtifact("review-loop", {
              sourceIdentity: {
                locator: "synthetic://fixture/shared-source",
                digest: digest("source-shared"),
              },
              evidence: {
                target: {
                  sourceIdentity: {
                    locator: "synthetic://fixture/shared-source",
                    digest: digest("source-shared"),
                  },
                },
              },
            }),
            classifierArtifact("method-routing", {
              sourceIdentity: {
                locator: "synthetic://fixture/shared-source",
                digest: digest("source-shared"),
              },
              evidence: {
                target: {
                  sourceIdentity: {
                    locator: "synthetic://fixture/shared-source",
                    digest: digest("source-shared"),
                  },
                },
              },
            }),
          ],
        }),
        mappings: [mapping("review-loop"), mapping("method-routing")],
      }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      state: "blocked",
      manifest: null,
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_ELIGIBILITY_DENIED",
          disposition: "blocked",
          target: "methodology/v1/rules/method-routing.md",
        },
        {
          code: "METHODOLOGY_SYNTHETIC_ELIGIBILITY_DENIED",
          disposition: "blocked",
          target: "methodology/v1/rules/review-loop.md",
        },
      ],
      boundary: {
        providerExecution: false,
        hostExecution: false,
        reads: false,
        writes: false,
        cli: false,
      },
    });
  });

  it("blocks executable classifier candidates before creating a manifest", () => {
    const result = planSyntheticMethodologyProjection(
      projection({
        classification: classifierInput({
          artifacts: [
            classifierArtifact("review-loop", {
              content: { classification: "executable", digest: digest("content-review-loop") },
            }),
          ],
        }),
      }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      state: "blocked",
      manifest: null,
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_ELIGIBILITY_DENIED",
          disposition: "blocked",
          target: "methodology/v1/rules/review-loop.md",
        },
      ],
      boundary: {
        providerExecution: false,
        hostExecution: false,
        reads: false,
        writes: false,
        cli: false,
      },
    });
  });

  it("blocks mappings that do not exactly bind classifier eligibility", () => {
    const result = planSyntheticMethodologyProjection(
      projection({
        classification: classifierInput({
          roots: ["review-loop", "method-routing"],
          artifacts: [classifierArtifact("review-loop"), classifierArtifact("method-routing")],
        }),
        mappings: [mapping("review-loop")],
      }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      state: "blocked",
      manifest: null,
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_ELIGIBILITY_MAPPING_MISMATCH",
          disposition: "blocked",
          target: "methodology/v1",
        },
      ],
      boundary: {
        providerExecution: false,
        hostExecution: false,
        reads: false,
        writes: false,
        cli: false,
      },
    });
  });

  it("keeps projection records closed, classifier-bound, and canonical at their boundary", () => {
    expect(() =>
      SyntheticMethodologyProjectionSchema.parse({ ...projection(), unknown: true }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionSchema.parse(
        projection({ mappings: [{ ...mapping("review-loop"), eligibility: "eligible" }] }),
      ),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionSchema.parse(
        projection({
          mappings: [
            mapping("review-loop", {
              target: { path: "methodology/v1/rules/Review-loop.md", owner: "aih-methodology-v1" },
            }),
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionSchema.parse(
        projection({
          mappings: [
            {
              ...mapping("review-loop"),
              source: {
                locator: "synthetic://fixture/injected",
                sourceDigest: digest("injected-source"),
                contentDigest: digest("injected-content"),
              },
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects contradictory or duplicated externally supplied plan results", () => {
    const finding = {
      code: "METHODOLOGY_SYNTHETIC_TARGET_UNOWNED",
      disposition: "blocked" as const,
      target: "foreign/v1/rules/review-loop.md",
    };
    expect(() =>
      SyntheticMethodologyProjectionPlanSchema.parse({
        schemaVersion: 1,
        state: "planned",
        manifest: null,
        findings: [],
        boundary: {
          providerExecution: false,
          hostExecution: false,
          reads: false,
          writes: false,
          cli: false,
        },
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionPlanSchema.parse({
        schemaVersion: 1,
        state: "blocked",
        manifest: null,
        findings: [finding, finding],
        boundary: {
          providerExecution: false,
          hostExecution: false,
          reads: false,
          writes: false,
          cli: false,
        },
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionPlanSchema.parse({
        schemaVersion: 1,
        state: "blocked",
        manifest: null,
        findings: [
          {
            code: "METHODOLOGY_SYNTHETIC_ELIGIBILITY_DENIED",
            disposition: "blocked",
            target: "methodology/v1/rules/review-loop.md",
          },
          finding,
        ],
        boundary: {
          providerExecution: false,
          hostExecution: false,
          reads: false,
          writes: false,
          cli: false,
        },
      }),
    ).toThrow();
  });

  it("rejects unordered, duplicate, overlong, or digest-mismatched manifests", () => {
    const planned = planSyntheticMethodologyProjection(
      projection({
        classification: classifierInput({
          roots: ["review-loop", "method-routing"],
          artifacts: [classifierArtifact("review-loop"), classifierArtifact("method-routing")],
        }),
        mappings: [mapping("review-loop"), mapping("method-routing")],
      }),
    );
    const manifest = planned.manifest;
    if (planned.state !== "planned" || manifest === null) {
      throw new Error("test fixture must plan");
    }

    expect(() =>
      SyntheticMethodologyProjectionPlanSchema.parse({
        ...planned,
        manifest: { ...manifest, entries: [...manifest.entries].reverse() },
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionPlanSchema.parse({
        ...planned,
        manifest: {
          ...manifest,
          entries: [manifest.entries[0], manifest.entries[0]],
        },
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionPlanSchema.parse({
        ...planned,
        manifest: { ...manifest, digest: digest("tampered") },
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyProjectionPlanSchema.parse({
        ...planned,
        manifest: {
          ...manifest,
          entries: Array.from({ length: 33 }, (_, index) => ({
            id: `component-${index}`,
            source: {
              locator: `synthetic://fixture/component-${index}`,
              sourceDigest: digest(`source-${index}`),
              contentDigest: digest(`content-${index}`),
            },
            target: `methodology/v1/rules/component-${index}.md`,
          })),
        },
      }),
    ).toThrow();
  });
});
