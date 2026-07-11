import { describe, expect, it } from "vitest";
import {
  baselineAnalyzerVersions,
  requiredBaselineAnalyzersForComponent,
} from "../../src/baseline-evidence/analyzer-profile.js";
import type { BaselineComponentEvidence } from "../../src/baseline-evidence/schema.js";
import { readVendorBaselineLock } from "../../src/baseline-evidence/vendor.js";
import { checkBaselineAnalyzerReceipts } from "../../src/internals/check-baseline-analyzers.js";

function analyzerReceipts(
  component: BaselineComponentEvidence,
): Array<{ name: string; version: string }> {
  const versions = baselineAnalyzerVersions();
  return [...requiredBaselineAnalyzersForComponent(component)]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name, version: versions[name] ?? "" }));
}

describe("baseline analyzer receipt gate", () => {
  it("accepts only exact required analyzer names and versions on every component", () => {
    const lock = structuredClone(readVendorBaselineLock());
    for (const component of lock.sources.flatMap((source) => source.components)) {
      component.analyzers = analyzerReceipts(component);
    }

    expect(checkBaselineAnalyzerReceipts(lock)).toEqual({ ok: true, findings: [] });
  });

  it("names the source, component, and missing exact receipt", () => {
    const lock = structuredClone(readVendorBaselineLock());
    for (const component of lock.sources.flatMap((source) => source.components)) {
      component.analyzers = analyzerReceipts(component);
    }
    const source = lock.sources[0];
    const component = source?.components.find((candidate) =>
      requiredBaselineAnalyzersForComponent(candidate).includes("cisco@uvx"),
    );
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
