import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readVendorBaselineLock } from "../../../src/baseline-evidence/vendor.js";
import { policyAuthoringCatalog } from "../../../src/org-policy/catalog.js";
import {
  policyAuthoringCatalogBundle,
  verifyAuthoringCatalogBundleIntegrityV1,
} from "../../../src/org-policy/workbench/catalog-bundle.js";
import { parseAuthoringCatalogBundleV1 } from "../../../src/org-policy/workbench/contracts.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
  resolveWorkbenchSelection,
} from "../../../src/org-policy/workbench/selection-engine.js";

function sha256(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

let productionFixture:
  | {
      catalog: ReturnType<typeof policyAuthoringCatalog>;
      bundle: ReturnType<typeof policyAuthoringCatalogBundle>;
    }
  | undefined;

function productionCatalogBundle() {
  productionFixture ??= (() => {
    const catalog = policyAuthoringCatalog();
    return { catalog, bundle: policyAuthoringCatalogBundle(catalog) };
  })();
  return structuredClone(productionFixture);
}

describe("policy authoring catalog bundle", () => {
  it("normalizes pinned sources without giving source metadata projector authority", () => {
    const bundle = policyAuthoringCatalogBundle();
    expect(() => parseAuthoringCatalogBundleV1(bundle)).not.toThrow();
    expect(
      Object.values(bundle.assets).some((asset) => asset.authoring.action === "record-selection"),
    ).toBe(true);
    expect(
      Object.values(bundle.assets).some((asset) => asset.authoring.action === "select-control"),
    ).toBe(true);
    expect(
      Object.values(bundle.assets).every(
        (asset) =>
          asset.authoring.action !== "select-control" || asset.authoring.projectorId !== undefined,
      ),
    ).toBe(true);
  });

  it("binds pinned assets to their pinned component or declaration identities", () => {
    const { catalog, bundle } = productionCatalogBundle();
    const vendorSources = new Map(
      readVendorBaselineLock().sources.map((source) => [source.id, source]),
    );

    for (const framework of catalog.frameworks) {
      const source = bundle.sources[`source:${framework.id}`];
      const verifiedSource = vendorSources.get(framework.id);
      expect(source?.revision.contentDigest).toBe(`sha256:${verifiedSource?.sourceTreeSha256}`);
      for (const item of framework.assets) {
        const asset = bundle.assets[`${framework.id}/${item.id}`];
        expect(asset?.contentDigest).toBe(
          `sha256:${item.vet?.treeSha256 ?? item.metadata?.sourceSha256}`,
        );
      }
    }
  });

  it("preserves catalog closure and maps every vetted subject to exact source content", () => {
    const { catalog, bundle } = productionCatalogBundle();
    const vendorComponents = new Map(
      readVendorBaselineLock().sources.map((source) => [
        source.id,
        new Map(source.components.map((component) => [component.id, component])),
      ]),
    );
    const relationsByFromAssetId = new Map<string, (typeof bundle.relations)[number][]>();
    for (const relation of bundle.relations) {
      const relations = relationsByFromAssetId.get(relation.fromAssetId) ?? [];
      relations.push(relation);
      relationsByFromAssetId.set(relation.fromAssetId, relations);
    }
    const evidenceBySubjectAssetId = new Map<string, (typeof bundle.evidence)[string][]>();
    for (const evidence of Object.values(bundle.evidence)) {
      for (const subject of evidence.subjects) {
        const entries = evidenceBySubjectAssetId.get(subject.assetId) ?? [];
        entries.push(evidence);
        evidenceBySubjectAssetId.set(subject.assetId, entries);
      }
    }

    for (const framework of catalog.frameworks) {
      const components = vendorComponents.get(framework.id);
      for (const item of framework.assets) {
        const assetId = `${framework.id}/${item.id}`;
        const relations = relationsByFromAssetId.get(assetId) ?? [];
        for (const dependency of item.dependencies ?? []) {
          expect(relations).toContainEqual({
            fromAssetId: assetId,
            toAssetId: `${framework.id}/${dependency}`,
            kind: "requires",
          });
        }
        for (const rider of item.riders ?? []) {
          expect(relations).toContainEqual({
            fromAssetId: assetId,
            toAssetId: `${framework.id}/${rider}`,
            kind: "requires",
          });
        }
        for (const member of item.members ?? []) {
          expect(relations).toContainEqual({
            fromAssetId: assetId,
            toAssetId: `${framework.id}/${member}`,
            kind: "member",
            membership: "optional",
          });
        }
        if (item.vet !== undefined) {
          const coveredPaths = components?.get(item.id)?.paths;
          if (coveredPaths === undefined) throw new Error(`missing evidence paths for ${item.id}`);
          expect(evidenceBySubjectAssetId.get(assetId) ?? []).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                coveredPaths: [...coveredPaths].sort(),
                subjects: [
                  expect.objectContaining({
                    assetId,
                    sourceId: `source:${framework.id}`,
                    contentDigest: `sha256:${item.vet.treeSha256}`,
                  }),
                ],
              }),
            ]),
          );
        }
      }
    }
    expect(Object.keys(bundle.groups)).not.toHaveLength(0);
    expect(Object.keys(bundle.templates)).not.toHaveLength(0);
  });

  it("uses exact vendor-lock component paths for complete evidence coverage", () => {
    const { catalog, bundle } = productionCatalogBundle();
    const vendorComponents = new Map(
      readVendorBaselineLock().sources.map((source) => [
        source.id,
        new Map(source.components.map((component) => [component.id, component])),
      ]),
    );
    const candidate = catalog.frameworks
      .flatMap((framework) => framework.assets.map((asset) => ({ framework, asset })))
      .find(({ framework, asset }) => {
        const paths = vendorComponents.get(framework.id)?.get(asset.id)?.paths;
        return (
          asset.vet !== undefined &&
          paths !== undefined &&
          asset.sourcePaths.some((path) => !paths.includes(path))
        );
      });
    expect(candidate).toBeDefined();
    if (candidate === undefined) throw new Error("expected a provenance alias fixture");
    const exactPaths = vendorComponents.get(candidate.framework.id)?.get(candidate.asset.id)?.paths;
    if (exactPaths === undefined) throw new Error("expected exact component paths");
    expect(
      bundle.evidence[`evidence:${candidate.framework.id}/${candidate.asset.id}`]?.coveredPaths,
    ).toEqual([...exactPaths].sort());
    expect(candidate.asset.sourcePaths.some((path) => !exactPaths.includes(path))).toBe(true);
  });

  it("compiles production composition templates as exact inert roots", () => {
    const { catalog, bundle } = productionCatalogBundle();
    for (const part of catalog.enterpriseComposition.parts) {
      const templateId = "template:ecc/" + part.id;
      const template = bundle.templates[templateId];
      if (!template) throw new Error("missing composition template: " + templateId);
      expect(template.roots.map((root) => root.assetId)).toEqual(
        part.componentIds.map((componentId) => "ecc/" + componentId).sort(),
      );
      const applied = reduceWorkbenchAction(bundle, createWorkbenchState(), {
        type: "apply-template",
        templateId,
      });
      expect(applied.accepted).toBe(true);
      expect(applied.state.roots.every((root) => root.origin.kind === "template")).toBe(true);
      expect(
        resolveWorkbenchSelection(bundle, applied.state).assetIds.every(
          (assetId) => bundle.assets[assetId]?.authoring.action === "record-selection",
        ),
      ).toBe(true);
    }
    let methodology = reduceWorkbenchAction(bundle, createWorkbenchState(), {
      type: "apply-template",
      templateId: "template:ecc/methodology",
    });
    expect(methodology.accepted).toBe(true);
    methodology = reduceWorkbenchAction(bundle, methodology.state, {
      type: "apply-template",
      templateId: "template:superpowers/methodology",
    });
    expect(methodology.accepted).toBe(false);
  });

  it("keeps methodology on explicit profiles rather than technology framework assets", () => {
    const { bundle } = productionCatalogBundle();
    for (const framework of ["ecc", "superpowers"]) {
      expect(bundle.assets[`${framework}/profile:methodology`]).toMatchObject({
        exclusiveSlot: "methodology",
        methodologyKey: framework,
      });
    }
    expect(
      Object.values(bundle.assets)
        .filter((asset) => asset.kind === "framework")
        .every((asset) => asset.exclusiveSlot === undefined),
    ).toBe(true);
  });
  it("binds every detail chunk and the bundle digest to its exact bytes", () => {
    const { bundle } = productionCatalogBundle();
    for (const chunk of Object.values(bundle.detailChunks)) {
      expect(chunk.digest).toBe(sha256(chunk.bytes));
    }

    const tampered = structuredClone(bundle);
    const assetId = Object.keys(tampered.assets)[0];
    if (assetId === undefined) throw new Error("expected a catalog asset");
    const asset = tampered.assets[assetId];
    if (asset === undefined) throw new Error("expected a catalog asset record");
    asset.label = `${asset.label} changed`;
    expect(() => verifyAuthoringCatalogBundleIntegrityV1(tampered)).toThrow(/bundle digest/i);
    const chunkTampered = structuredClone(bundle);
    const chunkId = Object.keys(chunkTampered.detailChunks)[0];
    if (chunkId === undefined) throw new Error("expected a detail chunk");
    const chunk = chunkTampered.detailChunks[chunkId];
    if (chunk === undefined) throw new Error("expected a detail chunk record");
    chunk.bytes = `${chunk.bytes} changed`;
    expect(() => verifyAuthoringCatalogBundleIntegrityV1(chunkTampered)).toThrow(
      /detail chunk digest/i,
    );
  });
});
