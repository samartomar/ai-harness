import { describe, expect, it } from "vitest";
import {
  baselineAnalyzerVersions,
  requiredBaselineAnalyzersForComponent,
} from "../../src/baseline-evidence/analyzer-profile.js";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import type { BaselineComponentEvidence } from "../../src/baseline-evidence/schema.js";
import { readVendorBaselineLock } from "../../src/baseline-evidence/vendor.js";
import { checkBaselineAnalyzerReceipts } from "../../src/internals/check-baseline-analyzers.js";

function analyzerReceipts(
  sourceId: string,
  component: BaselineComponentEvidence,
): Array<{ name: string; version: string }> {
  const versions = baselineAnalyzerVersions();
  const canonical = baselineCatalogById(sourceId).components.find(
    (candidate) => candidate.id === component.id,
  );
  if (canonical === undefined) throw new Error(`missing canonical component ${component.id}`);
  return [...requiredBaselineAnalyzersForComponent(canonical)]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name, version: versions[name] ?? "" }));
}

describe("baseline analyzer receipt gate", () => {
  it("accepts only exact required analyzer names and versions on every component", () => {
    const lock = structuredClone(readVendorBaselineLock());
    for (const source of lock.sources) {
      for (const component of source.components) {
        component.analyzers = analyzerReceipts(source.id, component);
      }
    }

    expect(checkBaselineAnalyzerReceipts(lock)).toEqual({ ok: true, findings: [] });
  });

  it("names the source, component, and missing exact receipt", () => {
    const lock = structuredClone(readVendorBaselineLock());
    for (const source of lock.sources) {
      for (const component of source.components) {
        component.analyzers = analyzerReceipts(source.id, component);
      }
    }
    const source = lock.sources[0];
    const component = source?.components.find((candidate) => candidate.id === "runtime:ecc-kiro");
    if (!source || !component) throw new Error("vendor fixture must contain one component");
    component.analyzers = component.analyzers.filter(({ name }) => name !== "cisco@uvx");

    expect(checkBaselineAnalyzerReceipts(lock)).toEqual({
      ok: false,
      findings: [
        {
          sourceId: source.id,
          componentId: component.id,
          detail: "missing cisco@uvx@2.0.12",
        },
      ],
    });
  });

  it("rejects a missing canonical component or source", () => {
    const missingComponent = structuredClone(readVendorBaselineLock());
    const ecc = missingComponent.sources.find((source) => source.id === "ecc");
    if (ecc === undefined) throw new Error("ECC evidence is missing");
    ecc.components = ecc.components.filter((component) => component.id !== "runtime:ecc-kiro");
    expect(checkBaselineAnalyzerReceipts(missingComponent).findings).toContainEqual({
      sourceId: "ecc",
      componentId: "runtime:ecc-kiro",
      detail: "component is missing from the vendor baseline lock",
    });

    const missingSource = structuredClone(readVendorBaselineLock());
    missingSource.sources = missingSource.sources.filter((source) => source.id !== "superpowers");
    expect(checkBaselineAnalyzerReceipts(missingSource).findings).toContainEqual({
      sourceId: "superpowers",
      componentId: "<catalog>",
      detail: "source is missing from the vendor baseline lock",
    });
  });

  it("rejects a lock pinned to a source SHA that no longer matches the active catalog pin", () => {
    const lock = structuredClone(readVendorBaselineLock());
    const source = lock.sources.find((candidate) => candidate.id === "ecc");
    if (source === undefined) throw new Error("ECC evidence is missing");
    const activePin = baselineCatalogById(source.id).pinnedSha;
    const stalePin = activePin === "f".repeat(40) ? "0".repeat(40) : "f".repeat(40);
    source.pinnedSha = stalePin;

    expect(checkBaselineAnalyzerReceipts(lock)).toEqual({
      ok: false,
      findings: [
        {
          sourceId: "ecc",
          componentId: "<catalog>",
          detail: `lock pinned ${stalePin} but active catalog pin is ${activePin}`,
        },
      ],
    });
  });
});
