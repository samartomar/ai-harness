import { describe, expect, it } from "vitest";
import {
  classifySyntheticMethodology,
  SyntheticMethodologyInputSchema,
} from "../../src/methodology/classifier.js";

function artifact(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    path: `rules/${id}.md`,
    kind: "regular",
    content: "passive",
    evidence: {
      source: "exact",
      trust: "admitted",
      license: "allowed",
    },
    dependencies: [],
    ...overrides,
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
  it("admits a complete, exact, passive synthetic closure deterministically", () => {
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
      disposition: "admitted",
      admitted: ["method-routing", "review-loop"],
      findings: [],
    });
    expect(reverse).toEqual(forward);
  });

  it.each([
    ["executable", { content: "executable" }, "METHODOLOGY_SYNTHETIC_EXECUTABLE"],
    ["linked", { kind: "symlink" }, "METHODOLOGY_SYNTHETIC_LINKED"],
    ["ambiguous", { content: "ambiguous" }, "METHODOLOGY_SYNTHETIC_AMBIGUOUS"],
    [
      "unlicensed",
      { evidence: { source: "exact", trust: "admitted", license: "unlicensed" } },
      "METHODOLOGY_SYNTHETIC_UNLICENSED",
    ],
    [
      "drifted",
      { evidence: { source: "drifted", trust: "admitted", license: "allowed" } },
      "METHODOLOGY_SYNTHETIC_DRIFTED",
    ],
    [
      "held",
      { evidence: { source: "exact", trust: "held", license: "allowed" } },
      "METHODOLOGY_SYNTHETIC_HELD",
    ],
  ])("excludes a %s synthetic artifact with a fixed finding", (_name, overrides, code) => {
    const result = classifySyntheticMethodology(
      input({ artifacts: [artifact("review-loop", overrides)] }),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      disposition: "excluded",
      admitted: [],
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
      admitted: [],
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
      admitted: [],
      findings: [
        {
          code: "METHODOLOGY_SYNTHETIC_DEPENDENCY_MISSING",
          disposition: "excluded",
          artifact: "missing-rule",
        },
      ],
    });
  });

  it("keeps the synthetic input closed and resource-bounded", () => {
    expect(() => SyntheticMethodologyInputSchema.parse({ ...input(), unexpected: true })).toThrow();
    expect(() =>
      SyntheticMethodologyInputSchema.parse(
        input({ roots: Array.from({ length: 33 }, (_, index) => `component-${index}`) }),
      ),
    ).toThrow();
  });
});
