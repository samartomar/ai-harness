import { describe, expect, it } from "vitest";
import { readVendorBaselineLock } from "../../src/baseline-evidence/vendor.js";
import { policyAuthoringCatalog } from "../../src/org-policy/catalog.js";

function allAssets() {
  return policyAuthoringCatalog().frameworks.flatMap((framework) => framework.assets);
}

function lockComponents(sourceId: string) {
  const source = readVendorBaselineLock().sources.find((entry) => entry.id === sourceId);
  if (source === undefined) throw new Error(`vendor lock is missing ${sourceId}`);
  return source;
}

describe("pinned Catalog vet verdicts", () => {
  it("carries verdicts only for components present in the pinned vet lock", () => {
    for (const framework of policyAuthoringCatalog().frameworks) {
      const byId = new Map(
        lockComponents(framework.id).components.map((component) => [component.id, component]),
      );
      for (const asset of framework.assets) {
        const locked = byId.get(asset.id);
        if (locked === undefined) {
          expect(asset.vet, `${asset.id} must not inherit unrelated vet evidence`).toBeUndefined();
        } else {
          expect(asset.vet, `${asset.id} lost its pinned vet verdict`).toBeDefined();
          expect(asset.vet?.verdict).toBe(locked.verdict);
        }
      }
    }
  });

  it("marks exactly the components the vet blocked", () => {
    const blocked = allAssets().filter((asset) => asset.vet?.verdict === "blocked");
    const expected = readVendorBaselineLock()
      .sources.flatMap((source) => source.components)
      .filter((component) => component.verdict === "blocked")
      .map((component) => component.id);
    expect(blocked.map((asset) => asset.id).sort()).toStrictEqual([...expected].sort());
    expect(blocked.length).toBeGreaterThan(0);
  });

  it("retains a finding for every blocked component", () => {
    for (const asset of allAssets()) {
      if (asset.vet?.verdict !== "blocked") continue;
      expect(asset.vet.findings.length, `${asset.id} is blocked with no finding`).toBeGreaterThan(
        0,
      );
      expect(asset.vet.findings[0]?.code).toMatch(/\S/);
    }
  });

  it("binds each projected verdict to the pin the vet ran against", () => {
    for (const framework of policyAuthoringCatalog().frameworks) {
      expect(framework.commit).toBe(lockComponents(framework.id).pinnedSha);
    }
  });
});
