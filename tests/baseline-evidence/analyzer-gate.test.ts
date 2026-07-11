import { describe, expect, it } from "vitest";
import {
  baselineAnalyzerVersions,
  REQUIRED_BASELINE_ANALYZERS,
} from "../../src/baseline-evidence/analyzer-profile.js";
import { readVendorBaselineLock } from "../../src/baseline-evidence/vendor.js";
import { checkBaselineAnalyzerReceipts } from "../../src/internals/check-baseline-analyzers.js";

function analyzerReceipts(): Array<{ name: string; version: string }> {
  const versions = baselineAnalyzerVersions();
  return [...REQUIRED_BASELINE_ANALYZERS]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name, version: versions[name] ?? "" }));
}

describe("baseline analyzer receipt gate", () => {
  it("accepts only exact required analyzer names and versions on every component", () => {
    const lock = structuredClone(readVendorBaselineLock());
    for (const component of lock.sources.flatMap((source) => source.components)) {
      component.analyzers = analyzerReceipts();
    }

    expect(checkBaselineAnalyzerReceipts(lock)).toEqual({ ok: true, findings: [] });
  });

  it("names the source, component, and missing exact receipt", () => {
    const lock = structuredClone(readVendorBaselineLock());
    for (const component of lock.sources.flatMap((source) => source.components)) {
      component.analyzers = analyzerReceipts();
    }
    const source = lock.sources[0];
    const component = source?.components[0];
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
});
