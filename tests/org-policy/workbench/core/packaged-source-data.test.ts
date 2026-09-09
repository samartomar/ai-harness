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
    compilerTemplate: {},
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
  it("reuses a detached package overlay only for the exact base and selected pin state", async () => {
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
    applyPackagedWorkbenchSourceDataV1(base, [
      {
        assetId: selected.id,
        sourceId: selected.sourceId,
        sourceRevisionId: selected.sourceRevisionId,
        contentDigest: selected.contentDigest,
      },
    ]);
    expect(fixture.apply).toHaveBeenCalledTimes(3);
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
});
