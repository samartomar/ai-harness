import { describe, expect, it } from "vitest";
import {
  classifySyntheticMethodology,
  SyntheticMethodologyClassificationSchema,
  SyntheticMethodologyInputSchema,
} from "../../src/methodology/classifier.js";

function digest(seed: string): string {
  const encoded = [...seed]
    .map((character) => character.codePointAt(0)?.toString(16).padStart(2, "0") ?? "00")
    .join("");
  return `sha256:${encoded.slice(0, 64).padEnd(64, "0")}`;
}

function artifact(id: string, overrides: Record<string, unknown> = {}) {
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
  const overriddenArtifact = {
    id,
    path,
    kind: "regular",
    content,
    sourceIdentity,
    dependencies: [],
    ...artifactOverrides,
  };
  const overriddenEvidence = evidenceOverrides as
    | {
        target?: Record<string, unknown>;
        source?: "exact" | "drifted";
        trust?: "admitted" | "held";
        license?: "allowed" | "unlicensed";
      }
    | undefined;
  const { target: targetOverrides, ...evidenceFields } = overriddenEvidence ?? {};

  return {
    ...overriddenArtifact,
    evidence: {
      target: {
        artifact: overriddenArtifact.id,
        path: overriddenArtifact.path,
        sourceIdentity: overriddenArtifact.sourceIdentity,
        contentDigest: overriddenArtifact.content.digest,
        ...targetOverrides,
      },
      source: "exact",
      trust: "admitted",
      license: "allowed",
      ...evidenceFields,
    },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    roots: ["review-loop"],
    artifacts: [artifact("review-loop")],
    ...overrides,
  };
}

describe("synthetic methodology classifier", () => {
  it("classifies a complete, exact, passive synthetic closure as eligible deterministically", () => {
    const forward = classifySyntheticMethodology(
      input({
        roots: ["review-loop", "method-routing"],
        artifacts: [artifact("review-loop"), artifact("method-routing")],
      }),
    );
    const reverse = classifySyntheticMethodology(
      input({
        roots: ["method-routing", "review-loop"],
        artifacts: [artifact("method-routing"), artifact("review-loop")],
      }),
    );

    expect(forward).toEqual({
      schemaVersion: 1,
      disposition: "eligible",
      eligible: ["method-routing", "review-loop"],
      findings: [],
    });
    expect(reverse).toEqual(forward);
  });

  it("excludes a self-referential synthetic dependency with a fixed cycle finding", () => {
    const result = classifySyntheticMethodology(
      input({ artifacts: [artifact("review-loop", { dependencies: ["review-loop"] })] }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      disposition: "excluded",
      eligible: [],
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_DEPENDENCY_CYCLE",
          disposition: "excluded",
          artifact: "review-loop",
        },
      ],
    });
  });

  it("excludes every member of a multi-node synthetic dependency cycle deterministically", () => {
    const result = classifySyntheticMethodology(
      input({
        roots: ["review-loop", "method-routing"],
        artifacts: [
          artifact("review-loop", { dependencies: ["method-routing"] }),
          artifact("method-routing", { dependencies: ["review-loop"] }),
        ],
      }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      disposition: "excluded",
      eligible: [],
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_DEPENDENCY_CYCLE",
          disposition: "excluded",
          artifact: "method-routing",
        },
        {
          code: "METHODOLOGY_SYNTHETIC_DEPENDENCY_CYCLE",
          disposition: "excluded",
          artifact: "review-loop",
        },
      ],
    });
  });

  it.each([
    [
      "executable",
      { content: { classification: "executable", digest: digest("content-review-loop") } },
      "METHODOLOGY_SYNTHETIC_EXECUTABLE",
    ],
    ["symlink", { kind: "symlink" }, "METHODOLOGY_SYNTHETIC_LINKED"],
    ["hard link", { kind: "hard-link" }, "METHODOLOGY_SYNTHETIC_LINKED"],
    ["reparse point", { kind: "reparse-point" }, "METHODOLOGY_SYNTHETIC_LINKED"],
    [
      "ambiguous",
      { content: { classification: "ambiguous", digest: digest("content-review-loop") } },
      "METHODOLOGY_SYNTHETIC_AMBIGUOUS",
    ],
    ["unlicensed", { evidence: { license: "unlicensed" } }, "METHODOLOGY_SYNTHETIC_UNLICENSED"],
    ["drifted", { evidence: { source: "drifted" } }, "METHODOLOGY_SYNTHETIC_DRIFTED"],
    ["held", { evidence: { trust: "held" } }, "METHODOLOGY_SYNTHETIC_HELD"],
  ])("excludes a %s synthetic artifact with a fixed finding", (_name, overrides, code) => {
    const result = classifySyntheticMethodology(
      input({ artifacts: [artifact("review-loop", overrides)] }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      disposition: "excluded",
      eligible: [],
      findings: [
        {
          code,
          disposition: "excluded",
          artifact: "review-loop",
        },
      ],
    });
  });

  it("excludes dependencies that are absent from the declared closure", () => {
    const result = classifySyntheticMethodology(
      input({
        artifacts: [
          artifact("review-loop", { dependencies: ["shared-rule"] }),
          artifact("shared-rule"),
        ],
      }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      disposition: "excluded",
      eligible: [],
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_OUT_OF_CLOSURE",
          disposition: "excluded",
          artifact: "shared-rule",
        },
      ],
    });
  });

  it("excludes missing synthetic dependencies without a permissive fallback", () => {
    const result = classifySyntheticMethodology(
      input({ artifacts: [artifact("review-loop", { dependencies: ["missing-rule"] })] }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      disposition: "excluded",
      eligible: [],
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_DEPENDENCY_MISSING",
          disposition: "excluded",
          artifact: "missing-rule",
        },
      ],
    });
  });

  it("excludes duplicate synthetic paths as ambiguous", () => {
    const result = classifySyntheticMethodology(
      input({
        roots: ["review-loop", "method-routing"],
        artifacts: [
          artifact("review-loop", { path: "rules/shared.md" }),
          artifact("method-routing", { path: "rules/shared.md" }),
        ],
      }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      disposition: "excluded",
      eligible: [],
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_PATH_AMBIGUOUS",
          disposition: "excluded",
          artifact: "method-routing",
        },
        {
          code: "METHODOLOGY_SYNTHETIC_PATH_AMBIGUOUS",
          disposition: "excluded",
          artifact: "review-loop",
        },
      ],
    });
  });

  it("excludes duplicate exact synthetic source identities as ambiguous", () => {
    const sharedSourceIdentity = {
      locator: "synthetic://fixture/shared-source",
      digest: digest("source-shared"),
    };
    const result = classifySyntheticMethodology(
      input({
        roots: ["review-loop", "method-routing"],
        artifacts: [
          artifact("review-loop", { sourceIdentity: sharedSourceIdentity }),
          artifact("method-routing", { sourceIdentity: sharedSourceIdentity }),
        ],
      }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      disposition: "excluded",
      eligible: [],
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_SOURCE_IDENTITY_AMBIGUOUS",
          disposition: "excluded",
          artifact: "method-routing",
        },
        {
          code: "METHODOLOGY_SYNTHETIC_SOURCE_IDENTITY_AMBIGUOUS",
          disposition: "excluded",
          artifact: "review-loop",
        },
      ],
    });
  });

  it("excludes a synthetic source locator with conflicting declared digests", () => {
    const result = classifySyntheticMethodology(
      input({
        roots: ["review-loop", "method-routing"],
        artifacts: [
          artifact("review-loop", {
            sourceIdentity: {
              locator: "synthetic://fixture/shared-source",
              digest: digest("source-one"),
            },
          }),
          artifact("method-routing", {
            sourceIdentity: {
              locator: "synthetic://fixture/shared-source",
              digest: digest("source-two"),
            },
          }),
        ],
      }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      disposition: "excluded",
      eligible: [],
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_SOURCE_IDENTITY_AMBIGUOUS",
          disposition: "excluded",
          artifact: "method-routing",
        },
        {
          code: "METHODOLOGY_SYNTHETIC_SOURCE_IDENTITY_AMBIGUOUS",
          disposition: "excluded",
          artifact: "review-loop",
        },
      ],
    });
  });

  it.each([
    ["artifact", { artifact: "method-routing" }],
    ["path", { path: "rules/method-routing.md" }],
    [
      "source locator",
      {
        sourceIdentity: {
          locator: "synthetic://fixture/method-routing",
          digest: digest("source-review-loop"),
        },
      },
    ],
    [
      "source digest",
      {
        sourceIdentity: {
          locator: "synthetic://fixture/review-loop",
          digest: digest("source-method-routing"),
        },
      },
    ],
    ["content digest", { contentDigest: digest("another-content") }],
  ])("excludes evidence whose target %s is not bound to the synthetic artifact", (_name, target) => {
    const result = classifySyntheticMethodology(
      input({ artifacts: [artifact("review-loop", { evidence: { target } })] }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      disposition: "excluded",
      eligible: [],
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_EVIDENCE_UNBOUND",
          disposition: "excluded",
          artifact: "review-loop",
        },
      ],
    });
  });

  it.each([
    ["empty synthetic path segment", { path: "rules//shared.md" }],
    ["trailing synthetic path segment", { path: "rules/shared/" }],
    ["dot synthetic path segment", { path: "rules/./shared.md" }],
    ["parent synthetic path segment", { path: "rules/../shared.md" }],
    ["mixed-case synthetic path segment", { path: "rules/Shared.md" }],
    ["trailing-period synthetic path segment", { path: "rules/shared." }],
    ["Windows device-name synthetic path segment", { path: "rules/con.md" }],
    ["Windows numbered device-name synthetic path segment", { path: "rules/com1.txt" }],
    [
      "empty synthetic locator segment",
      {
        sourceIdentity: {
          locator: "synthetic://fixture//shared",
          digest: digest("source-review-loop"),
        },
      },
    ],
    [
      "mixed-case synthetic locator segment",
      {
        sourceIdentity: {
          locator: "synthetic://fixture/Shared",
          digest: digest("source-review-loop"),
        },
      },
    ],
    [
      "Windows device-name synthetic locator segment",
      {
        sourceIdentity: {
          locator: "synthetic://fixture/aux",
          digest: digest("source-review-loop"),
        },
      },
    ],
    [
      "parent synthetic locator segment",
      {
        sourceIdentity: {
          locator: "synthetic://fixture/rules/../shared.md",
          digest: digest("source-review-loop"),
        },
      },
    ],
    [
      "trailing synthetic locator segment",
      {
        sourceIdentity: {
          locator: "synthetic://fixture/shared/",
          digest: digest("source-review-loop"),
        },
      },
    ],
  ])("rejects a %s at the closed schema boundary", (_name, overrides) => {
    expect(() =>
      SyntheticMethodologyInputSchema.parse(
        input({ artifacts: [artifact("review-loop", overrides)] }),
      ),
    ).toThrow();
  });

  it("fails closed instead of classifying noncanonical synthetic path aliases as eligible", () => {
    expect(() =>
      classifySyntheticMethodology(
        input({
          roots: ["review-loop", "method-routing"],
          artifacts: [
            artifact("review-loop", { path: "rules/shared.md" }),
            artifact("method-routing", { path: "rules//shared.md" }),
          ],
        }),
      ),
    ).toThrow();
  });

  it("fails closed instead of classifying case-alias synthetic paths as eligible", () => {
    expect(() =>
      classifySyntheticMethodology(
        input({
          roots: ["review-loop", "method-routing"],
          artifacts: [
            artifact("review-loop", { path: "rules/shared.md" }),
            artifact("method-routing", { path: "rules/Shared.md" }),
          ],
        }),
      ),
    ).toThrow();
  });

  it("fails closed instead of classifying a Windows device-name synthetic path as eligible", () => {
    expect(() =>
      classifySyntheticMethodology(
        input({ artifacts: [artifact("review-loop", { path: "rules/nul" })] }),
      ),
    ).toThrow();
  });

  it("uses code-unit ordering even if ambient locale comparison changes", () => {
    const originalLocaleCompare = String.prototype.localeCompare;
    Object.defineProperty(String.prototype, "localeCompare", {
      configurable: true,
      value: () => 0,
    });

    try {
      expect(
        classifySyntheticMethodology(
          input({
            roots: ["ab", "a0", "a-"],
            artifacts: [artifact("ab"), artifact("a0"), artifact("a-")],
          }),
        ),
      ).toEqual({
        schemaVersion: 1,
        disposition: "eligible",
        eligible: ["a-", "a0", "ab"],
        findings: [],
      });
    } finally {
      Object.defineProperty(String.prototype, "localeCompare", {
        configurable: true,
        value: originalLocaleCompare,
      });
    }
  });

  it("keeps the synthetic input closed and bounds every input collection", () => {
    expect(() => SyntheticMethodologyInputSchema.parse({ ...input(), unexpected: true })).toThrow();
    expect(() =>
      SyntheticMethodologyInputSchema.parse(
        input({ roots: Array.from({ length: 33 }, (_, index) => `component-${index}`) }),
      ),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyInputSchema.parse(
        input({
          artifacts: Array.from({ length: 65 }, (_, index) => artifact(`component-${index}`)),
        }),
      ),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyInputSchema.parse(
        input({
          artifacts: [
            artifact("review-loop", {
              dependencies: Array.from({ length: 33 }, (_, index) => `component-${index}`),
            }),
          ],
        }),
      ),
    ).toThrow();
  });

  it("bounds a synthetic path before it can enter classification", () => {
    expect(() =>
      SyntheticMethodologyInputSchema.parse(
        input({ artifacts: [artifact("review-loop", { path: "a".repeat(513) })] }),
      ),
    ).toThrow();
  });

  it("rejects contradictory, duplicate, obsolete, and overlong classification records", () => {
    const finding = {
      code: "METHODOLOGY_SYNTHETIC_AMBIGUOUS",
      disposition: "excluded" as const,
      artifact: "review-loop",
    };

    expect(() =>
      SyntheticMethodologyClassificationSchema.parse({
        schemaVersion: 1,
        disposition: "eligible",
        eligible: ["review-loop"],
        findings: [finding],
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyClassificationSchema.parse({
        schemaVersion: 1,
        disposition: "excluded",
        eligible: ["review-loop"],
        findings: [finding],
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyClassificationSchema.parse({
        schemaVersion: 1,
        disposition: "excluded",
        eligible: [],
        findings: [finding, finding],
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyClassificationSchema.parse({
        schemaVersion: 1,
        disposition: "eligible",
        eligible: Array.from({ length: 33 }, (_, index) => `component-${index}`),
        findings: [],
      }),
    ).toThrow();
    expect(() =>
      SyntheticMethodologyClassificationSchema.parse({
        schemaVersion: 1,
        disposition: "excluded",
        eligible: [],
        findings: Array.from({ length: 1281 }, (_, index) => ({
          ...finding,
          artifact: `component-${index}`,
        })),
      }),
    ).toThrow();
  });

  it("classifies the maximal synthetic closure without exceeding its result bound", () => {
    const roots = Array.from({ length: 32 }, (_, index) => `component-${index}`);
    const sharedSourceIdentity = {
      locator: "synthetic://fixture/shared-source",
      digest: digest("source-shared"),
    };
    const result = classifySyntheticMethodology(
      input({
        roots,
        artifacts: roots.map((id, artifactIndex) =>
          artifact(id, {
            path: "rules/shared.md",
            kind: "hard-link",
            content: { classification: "executable", digest: digest(`content-${id}`) },
            sourceIdentity: sharedSourceIdentity,
            evidence: {
              target: { contentDigest: digest(`unbound-${id}`) },
              source: "drifted",
              trust: "held",
              license: "unlicensed",
            },
            dependencies: Array.from(
              { length: 32 },
              (_, dependencyIndex) => `missing-${artifactIndex}-${dependencyIndex}`,
            ),
          }),
        ),
      }),
    );

    expect(result.disposition).toBe("excluded");
    expect(result.eligible).toEqual([]);
    expect(result.findings).toHaveLength(1280);
  });
});
