import { describe, expect, it } from "vitest";
import { deriveEccRuntimeDeclaredEvaluationV1 } from "../../src/ecc/runtime-descriptor-evaluation.js";

const raw = (value: string) => value.repeat(64).slice(0, 64);
const report = (blocked = false) => ({
  id: "ecc",
  owner: "affaan-m",
  repo: "ECC",
  pinnedSha: "a".repeat(40),
  sourceTreeSha256: raw("a"),
  components: [
    {
      id: "runtime:raw-a",
      paths: ["runtime/a"],
      treeSha256: raw("b"),
      verdict: blocked ? ("blocked" as const) : ("pass" as const),
      analyzers: [{ name: "semgrep@uvx", version: "1" }],
      findings: blocked ? [{ code: "blocked", detail: "raw finding" }] : [],
    },
    {
      id: "runtime:raw-b",
      paths: ["runtime/b"],
      treeSha256: raw("c"),
      verdict: "pass" as const,
      analyzers: [{ name: "trivy@uvx", version: "2" }],
      findings: [],
    },
  ],
});
const components = [
  { id: "skill:alpha", paths: ["skills/alpha"], identityTreeSha256: raw("d") },
  { id: "skill:beta", paths: ["skills/beta"], identityTreeSha256: raw("e") },
];
const mappings = [
  { componentId: "skill:alpha", rawComponentIds: ["runtime:raw-a"] },
  { componentId: "skill:beta", rawComponentIds: ["runtime:raw-b"] },
];

describe("ECC runtime declared evaluation", () => {
  it("derives exact declared verifier components only after the raw containment mapping", () => {
    const result = deriveEccRuntimeDeclaredEvaluationV1({
      rawReport: report(),
      mappings,
      components,
    });
    expect(result.vendorLock.sources[0]?.components).toEqual([
      expect.objectContaining({ id: "skill:alpha", verdict: "pass", treeSha256: raw("d") }),
      expect.objectContaining({ id: "skill:beta", verdict: "pass", treeSha256: raw("e") }),
    ]);
    expect(result.vendorLock.sources[0]?.components[0]?.analyzers).toEqual([
      { name: "semgrep@uvx", version: "1" },
    ]);
  });

  it("keeps a mapped raw block and its full finding instead of inventing a pass", () => {
    const result = deriveEccRuntimeDeclaredEvaluationV1({
      rawReport: report(true),
      mappings,
      components,
    });
    expect(result.vendorLock.sources[0]?.components[0]).toMatchObject({
      verdict: "blocked",
      findings: [{ code: "blocked", detail: "raw finding" }],
    });
  });

  it("rejects missing mappings and raw component references", () => {
    expect(() =>
      deriveEccRuntimeDeclaredEvaluationV1({
        rawReport: report(),
        mappings: mappings.slice(0, 1),
        components,
      }),
    ).toThrow();
    expect(() =>
      deriveEccRuntimeDeclaredEvaluationV1({
        rawReport: report(),
        mappings: [
          { componentId: "skill:alpha", rawComponentIds: ["runtime:missing"] },
          mappings[1]!,
        ],
        components,
      }),
    ).toThrow();
  });
});
