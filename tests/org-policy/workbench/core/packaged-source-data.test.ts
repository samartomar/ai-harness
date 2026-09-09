import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
} from "../../../../src/contract/strict-json-v1.js";
import type { PreparedWorkbenchCatalogV1 } from "../../../../src/org-policy/workbench/prepared-catalog.js";
import { tinyStudioModel } from "../../studio-test-fixture.js";

const fixture = vi.hoisted(() => ({
  records: [] as { bytes: string; sha256: string }[],
  apply: vi.fn(),
}));
vi.mock("../../../../src/org-policy/workbench/core/packaged-source-data-data.js", () => ({
  PACKAGED_WORKBENCH_SOURCE_DATA_V1: fixture.records,
}));
vi.mock("../../../../src/org-policy/workbench/core/source-data.js", () => ({
  applyPackagedWorkbenchSourceBundlesV1: fixture.apply,
}));
function seal(value: unknown) {
  return {
    bytes: canonicalStrictJsonBytesV1(value).toString("utf8"),
    sha256: canonicalStrictJsonSha256V1(value),
  };
}
function record() {
  const bundle = tinyStudioModel().workbenchBundle;
  const source = Object.values(bundle.sources)[0];
  if (!source) throw new Error("Missing fixture source");
  source.upstreamOrigin = { kind: "git", locator: "https://github.com/example/skills" };
  source.revision.id = "a".repeat(40);
  for (const asset of Object.values(bundle.assets)) asset.sourceRevisionId = source.revision.id;
  bundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...bundle, provenance: {} })}`;
  return {
    version: "packaged-workbench-source-data/v1",
    sourceBundle: bundle,
    source: { repository: "example/skills", commit: source.revision.id },
    scannerProof: {},
    compilerTemplate: { version: "built-in/v1" },
    inlineBlobs: [],
    publicationBlobs: [
      { sha256: "b".repeat(64), bytes: 1, url: "https://github.com/example/scans" },
    ],
  };
}
function frameworkRecord() {
  const bundle = structuredClone(tinyStudioModel().workbenchBundle);
  const revision = "a".repeat(40);
  const repository = "fixture/ecc";
  const previous = Object.values(bundle.sources)[0];
  if (!previous) throw new Error("Missing fixture source");
  delete bundle.sources[previous.id];
  bundle.sources["source:ecc"] = {
    ...previous,
    id: "source:ecc",
    upstreamOrigin: { kind: "git", locator: repository },
    inputFormat: "pinned-baseline/v1",
    revision: { id: revision, contentDigest: previous.revision.contentDigest },
    compiler: { id: "pinned-baseline", version: "1" },
  };
  const assets = Object.values(bundle.assets);
  const declarations = assets.map((asset) => {
    const name = asset.id.split(":")[1];
    if (!name) throw new Error("Missing fixture asset name");
    const itemId = `skill:${name}`;
    const id = `ecc/${itemId}`;
    const detail = bundle.detailChunks[asset.detailChunkId];
    if (!detail) throw new Error("Missing fixture detail");
    delete bundle.assets[asset.id];
    delete bundle.detailChunks[asset.detailChunkId];
    asset.id = id;
    asset.sourceId = "source:ecc";
    asset.sourceRevisionId = revision;
    asset.derivation = "upstream";
    asset.kind = "skill";
    asset.originalPath = `skills/${name}/SKILL.md`;
    asset.detailChunkId = `detail:${id}`;
    asset.authoring = { action: "record-selection", supportedTargets: [] };
    bundle.assets[id] = asset;
    bundle.detailChunks[asset.detailChunkId] = detail;
    return {
      id: itemId,
      kind: "skill",
      source: { repository, commit: revision, path: asset.originalPath },
      sourcePaths: [asset.originalPath],
    };
  });
  const group = bundle.groups["group:fixture"];
  if (!group) throw new Error("Missing fixture group");
  group.assetIds = declarations.map((item) => `ecc/${item.id}`);
  bundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...bundle, provenance: {} })}`;
  return {
    version: "packaged-workbench-source-data/v1",
    sourceBundle: bundle,
    source: { repository, commit: revision },
    scannerProof: {},
    compilerTemplate: {
      version: "pinned-baseline/v1",
      framework: { id: "ecc", repository, commit: revision, assets: declarations },
    },
    inlineBlobs: [],
    publicationBlobs: [
      { sha256: "b".repeat(64), bytes: 1, url: "https://github.com/example/scans" },
    ],
  };
}
function preparedBase(): PreparedWorkbenchCatalogV1 {
  return {
    bundle: structuredClone(tinyStudioModel().workbenchBundle),
    bindings: {},
    sourceInputs: {},
  } as PreparedWorkbenchCatalogV1;
}
beforeEach(() => {
  vi.resetModules();
  fixture.records.length = 0;
  fixture.apply.mockReset();
  fixture.apply.mockImplementation((base) => structuredClone(base));
});
describe("offline package-owned source records", () => {
  it("returns detached sealed records without fetching or invoking a source importer", async () => {
    fixture.records.push(seal(record()));
    const { packagedWorkbenchSourceDataRecordsV1 } = await import(
      "../../../../src/org-policy/workbench/core/packaged-source-data.js"
    );
    const first = packagedWorkbenchSourceDataRecordsV1();
    const item = first[0];
    if (!item) throw new Error("Missing record");
    item.source.commit = "c".repeat(40);
    expect(packagedWorkbenchSourceDataRecordsV1()[0]?.source.commit).toBe("a".repeat(40));
    expect(fixture.apply).not.toHaveBeenCalled();
  });
  it("rejects changed seals and archive identities", async () => {
    const value = record();
    fixture.records.push({ ...seal(value), sha256: "0".repeat(64) });
    const { packagedWorkbenchSourceDataRecordsV1 } = await import(
      "../../../../src/org-policy/workbench/core/packaged-source-data.js"
    );
    expect(packagedWorkbenchSourceDataRecordsV1).toThrow(/seal mismatch/);
    value.source.commit = "c".repeat(40);
    fixture.records.splice(0, 1, seal(value));
    expect(packagedWorkbenchSourceDataRecordsV1).toThrow(/archive identity mismatch/);
  });
  it("defers nested runtime descriptor inspection until a runtime consumer requests it", async () => {
    const value = {
      ...record(),
      runtimeDescriptor: {
        bytesBase64: Buffer.from("{}", "utf8").toString("base64"),
        sha256: `sha256:${canonicalStrictJsonSha256V1({})}`,
      },
    };
    fixture.records.push(seal(value));
    const { packagedEccRuntimeDescriptorsV1, packagedWorkbenchSourceDataRecordsV1 } = await import(
      "../../../../src/org-policy/workbench/core/packaged-source-data.js"
    );

    expect(packagedWorkbenchSourceDataRecordsV1).not.toThrow();
    expect(packagedEccRuntimeDescriptorsV1).toThrow();
    // A failed inspection is never marked as a registered empty descriptor owner.
    expect(packagedEccRuntimeDescriptorsV1).toThrow();
  });
  it("retains the exact compiled-base revision when an initial package record is newer", async () => {
    const value = record();
    fixture.records.push(seal(value));
    const { applyPackagedWorkbenchSourceDataV1 } = await import(
      "../../../../src/org-policy/workbench/core/packaged-source-data.js"
    );
    const olderBundle = structuredClone(value.sourceBundle);
    for (const source of Object.values(olderBundle.sources)) source.revision.id = "c".repeat(40);
    for (const asset of Object.values(olderBundle.assets)) asset.sourceRevisionId = "c".repeat(40);
    olderBundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...olderBundle, provenance: {} })}`;
    // The mocked assembly seam must never inspect the legacy form catalog.
    const base = {
      bundle: olderBundle,
      bindings: {},
      sourceInputs: {},
    } as PreparedWorkbenchCatalogV1;
    const asset = Object.values(olderBundle.assets)[0];
    if (!asset) throw new Error("Missing asset");
    expect(
      applyPackagedWorkbenchSourceDataV1(base, [
        {
          assetId: asset.id,
          sourceId: asset.sourceId,
          sourceRevisionId: asset.sourceRevisionId,
          contentDigest: asset.contentDigest,
        },
      ]),
    ).toBe(base);
    expect(fixture.apply).not.toHaveBeenCalled();
    applyPackagedWorkbenchSourceDataV1(base);
    expect(fixture.apply).toHaveBeenCalledOnce();
  });
  it("reuses a detached package overlay only for the exact base and selected records", async () => {
    const value = record();
    fixture.records.push(seal(value));
    const { applyPackagedWorkbenchSourceDataV1 } = await import(
      "../../../../src/org-policy/workbench/core/packaged-source-data.js"
    );
    const base = preparedBase();
    const first = applyPackagedWorkbenchSourceDataV1(base);
    const second = applyPackagedWorkbenchSourceDataV1(base);
    expect(fixture.apply).toHaveBeenCalledOnce();
    expect(first).not.toBe(second);
    const assetId = Object.keys(first.bundle.assets)[0];
    if (!assetId) throw new Error("Missing fixture asset");
    delete first.bundle.assets[assetId];
    expect(second.bundle.assets[assetId]).toBeDefined();
    const changed = structuredClone(base);
    changed.bindings[assetId] = {
      kind: "intent",
      legacyRequestId: "changed",
      legacyRequestOrder: 1,
    };
    applyPackagedWorkbenchSourceDataV1(changed);
    expect(fixture.apply).toHaveBeenCalledTimes(2);
    const selected = Object.values(value.sourceBundle.assets)[0];
    if (!selected) throw new Error("Missing packaged fixture asset");
    const selectedOverlay = applyPackagedWorkbenchSourceDataV1(base, [
      {
        assetId: selected.id,
        sourceId: selected.sourceId,
        sourceRevisionId: selected.sourceRevisionId,
        contentDigest: selected.contentDigest,
      },
    ]);
    expect(selectedOverlay).toEqual(second);
    expect(selectedOverlay).not.toBe(second);
    expect(fixture.apply).toHaveBeenCalledTimes(2);
  });
  it("evicts the least-recent exact input after four overlays", async () => {
    fixture.records.push(seal(record()));
    const { applyPackagedWorkbenchSourceDataV1 } = await import(
      "../../../../src/org-policy/workbench/core/packaged-source-data.js"
    );
    const bases = Array.from({ length: 5 }, (_, index) => {
      const base = preparedBase();
      base.bindings[`cache-${index}`] = {
        kind: "intent",
        legacyRequestId: `cache-${index}`,
        legacyRequestOrder: index,
      };
      return base;
    });
    for (const base of bases) applyPackagedWorkbenchSourceDataV1(base);
    expect(fixture.apply).toHaveBeenCalledTimes(5);
    const first = bases[0];
    if (!first) throw new Error("Missing cache fixture");
    applyPackagedWorkbenchSourceDataV1(first);
    expect(fixture.apply).toHaveBeenCalledTimes(6);
  });
  it("restores only compiler bindings declared by the sealed registered template", async () => {
    const value = frameworkRecord();
    fixture.records.push(seal(value));
    fixture.apply.mockImplementation((base, records) => ({
      ...structuredClone(base),
      bundle: structuredClone(records[0]?.sourceBundle),
      bindings: {},
    }));
    const { applyPackagedWorkbenchSourceDataV1 } = await import(
      "../../../../src/org-policy/workbench/core/packaged-source-data.js"
    );
    const prepared = applyPackagedWorkbenchSourceDataV1(preparedBase());
    expect(prepared.bindings["ecc/skill:control"]).toEqual({
      kind: "external-selection",
      external: {
        owner: "ecc",
        item: {
          id: "skill:control",
          kind: "skill",
          source: {
            repository: "fixture/ecc",
            commit: "a".repeat(40),
            path: "skills/control/SKILL.md",
          },
        },
      },
    });

    fixture.records.length = 0;
    const malformed = frameworkRecord();
    malformed.compilerTemplate.framework.assets.pop();
    fixture.records.push(seal(malformed));
    vi.resetModules();
    const { applyPackagedWorkbenchSourceDataV1: applyMalformed } = await import(
      "../../../../src/org-policy/workbench/core/packaged-source-data.js"
    );
    expect(() => applyMalformed(preparedBase())).toThrow(/undeclared asset/);
  });
});
