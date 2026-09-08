import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalBaselineVetRequestV1Bytes, parseBaselineVetRequestV1Json } from "@aihq/scan";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessCandidateWorkbenchCoverage,
  defineCandidateSourceInventory,
  prepareCandidateBaselineRequests,
} from "../../src/baseline-evidence/candidate-preparation.js";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { hashSourceTree } from "../../src/baseline-evidence/hash.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sourceFixture() {
  const root = mkdtempSync(join(tmpdir(), "aih-candidate-preparation-"));
  roots.push(root);
  mkdirSync(join(root, "skills", "demo"), { recursive: true });
  mkdirSync(join(root, "runtime"), { recursive: true });
  writeFileSync(join(root, "skills", "demo", "SKILL.md"), "# Demo\n", "utf8");
  writeFileSync(join(root, "runtime", "runner.ts"), "export const runner = true;\n", "utf8");
  writeFileSync(join(root, "README.md"), "# Candidate\n", "utf8");
  return root;
}

function inventory(root: string) {
  return defineCandidateSourceInventory({
    protocol: "CandidateBaselineInventoryV1",
    producer: { id: "aih-core-candidate-preparation-v1" },
    source: {
      id: "fixture",
      owner: "example",
      repository: "fixture",
      pinnedCommit: "a".repeat(40),
      treeSha256: hashSourceTree(root).treeSha256,
    },
    components: [
      { id: "runtime:root", paths: ["README.md", "runtime"] },
      { id: "skill:demo", paths: ["skills/demo"], content: "skill" },
    ],
    exclusions: [],
  });
}

describe("candidate-only baseline request preparation", () => {
  it("authors canonical Scanner requests without reading or changing active catalogs", () => {
    const root = sourceFixture();
    const before = baselineCatalogById("ecc").pinnedSha;
    const requests = prepareCandidateBaselineRequests({
      sourceRoot: root,
      inventory: inventory(root),
    });
    const [request] = requests;
    if (request === undefined) throw new Error("fixture must prepare one request");

    expect(requests).toHaveLength(1);
    expect(request.source.treeSha256).toBe(hashSourceTree(root).treeSha256);
    expect(request.components.map((component) => component.analyzers)).toEqual([
      ["aih-native", "skillspector", "semgrep"],
      ["aih-native", "skillspector", "semgrep", "cisco"],
    ]);
    expect(
      parseBaselineVetRequestV1Json(canonicalBaselineVetRequestV1Bytes(request).toString("utf8")),
    ).toEqual(request);
    expect(baselineCatalogById("ecc").pinnedSha).toBe(before);
  });

  it("rejects source drift and an omitted newly materialized file", () => {
    const root = sourceFixture();
    const prepared = inventory(root);
    writeFileSync(join(root, "runtime", "new.ts"), "export const newFile = true;\n", "utf8");
    expect(() =>
      prepareCandidateBaselineRequests({ sourceRoot: root, inventory: prepared }),
    ).toThrow(/does not match the sealed candidate inventory/);

    const current = inventory(root);
    writeFileSync(join(root, "uncovered.md"), "uncovered\n", "utf8");
    const drifted = defineCandidateSourceInventory({
      ...current,
      source: { ...current.source, treeSha256: hashSourceTree(root).treeSha256 },
    });
    expect(() =>
      prepareCandidateBaselineRequests({ sourceRoot: root, inventory: drifted }),
    ).toThrow(/not covered by exactly one candidate component/);
  });

  it("binds literal materialized bytes rather than normalizing line endings", () => {
    const root = sourceFixture();
    writeFileSync(join(root, "runtime", "runner.ts"), "export const runner = true;\r\n", "utf8");
    const prepared = inventory(root);
    writeFileSync(join(root, "runtime", "runner.ts"), "export const runner = true;\n", "utf8");

    expect(() =>
      prepareCandidateBaselineRequests({ sourceRoot: root, inventory: prepared }),
    ).toThrow(/does not match the sealed candidate inventory/);
  });

  it("requires every source symlink to be explicitly excluded from component binding", () => {
    const root = sourceFixture();
    symlinkSync("README.md", join(root, "AGENTS.md"), "file");
    const source = hashSourceTree(root);
    const unexcluded = defineCandidateSourceInventory({
      ...inventory(root),
      source: { ...inventory(root).source, treeSha256: source.treeSha256 },
    });
    expect(() =>
      prepareCandidateBaselineRequests({ sourceRoot: root, inventory: unexcluded }),
    ).toThrow(/source symlink exclusions do not match materialized source/);

    const excluded = defineCandidateSourceInventory({
      ...unexcluded,
      exclusions: [{ path: "AGENTS.md", reason: "source-symlink" }],
    });
    expect(
      prepareCandidateBaselineRequests({ sourceRoot: root, inventory: excluded }),
    ).toHaveLength(1);
  });

  it("maps only exact path intersections and preserves the active pin", () => {
    const root = sourceFixture();
    const prepared = inventory(root);
    const assessment = assessCandidateWorkbenchCoverage({
      inventory: prepared,
      requests: prepareCandidateBaselineRequests({ sourceRoot: root, inventory: prepared }),
      workbench: {
        sourceId: "source:fixture",
        sourceRevisionId: "b".repeat(40),
        assets: [
          {
            id: "fixture/runtime",
            originalPath: "runtime/runner.ts",
            contentDigest: `sha256:${"1".repeat(64)}`,
          },
          {
            id: "fixture/skill:demo",
            originalPath: "skills/demo/SKILL.md",
            contentDigest: `sha256:${"2".repeat(64)}`,
          },
          {
            id: "fixture/unmapped",
            originalPath: "missing/file.md",
            contentDigest: `sha256:${"3".repeat(64)}`,
          },
        ],
      },
    });

    expect(assessment).toMatchObject({
      protocol: "CandidateWorkbenchCoverageV1",
      authority: "none",
      publisherEligibility: "requires-protected-publisher-reexecution",
      catalogStatus: "revision-mismatch",
      activePinAction: "preserve",
      offeredAssetCount: 3,
      pathMappedAssetCount: 2,
      unmappedAssetIds: ["fixture/unmapped"],
      candidateComponentCount: 2,
      candidateOnlyComponentIds: [],
    });
    expect(assessment.pathMappings).toEqual([
      {
        assetId: "fixture/runtime",
        assetContentDigest: `sha256:${"1".repeat(64)}`,
        candidateComponentId: "runtime:root",
        candidateComponentTreeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        originalPath: "runtime/runner.ts",
      },
      {
        assetId: "fixture/skill:demo",
        assetContentDigest: `sha256:${"2".repeat(64)}`,
        candidateComponentId: "skill:demo",
        candidateComponentTreeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        originalPath: "skills/demo/SKILL.md",
      },
    ]);
  });

  it("accepts canonical request path ordering for an equivalent sealed path set", () => {
    const root = sourceFixture();
    const base = inventory(root);
    const prepared = defineCandidateSourceInventory({
      ...base,
      components: base.components.map((component) =>
        component.id === "runtime:root"
          ? { ...component, paths: [...component.paths].reverse() }
          : component,
      ),
    });
    const requests = prepareCandidateBaselineRequests({ sourceRoot: root, inventory: prepared });

    expect(
      assessCandidateWorkbenchCoverage({
        inventory: prepared,
        requests,
      }),
    ).toMatchObject({ candidateComponentCount: 2, activePinAction: "preserve" });
  });

  it("reports absent Workbench enrollment without converting scan coverage to approval", () => {
    const root = sourceFixture();
    const prepared = inventory(root);
    const assessment = assessCandidateWorkbenchCoverage({
      inventory: prepared,
      requests: prepareCandidateBaselineRequests({ sourceRoot: root, inventory: prepared }),
    });

    expect(assessment).toMatchObject({
      authority: "none",
      catalogStatus: "not-offered",
      activePinAction: "preserve",
      offeredAssetCount: 0,
      pathMappedAssetCount: 0,
      candidateComponentCount: 2,
      candidateOnlyComponentIds: ["runtime:root", "skill:demo"],
    });
  });

  it("rejects request drift instead of widening candidate coverage", () => {
    const root = sourceFixture();
    const prepared = inventory(root);
    const requests = prepareCandidateBaselineRequests({ sourceRoot: root, inventory: prepared });
    const [request] = requests;
    if (request === undefined) throw new Error("fixture must prepare one request");

    expect(() =>
      assessCandidateWorkbenchCoverage({
        inventory: prepared,
        requests: [{ ...request, components: request.components.slice(1) }],
      }),
    ).toThrow(/request components do not match sealed candidate inventory/);
  });
});
