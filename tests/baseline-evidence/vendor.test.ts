import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  baselineAnalyzerVersions,
  requiredBaselineAnalyzersForComponent,
} from "../../src/baseline-evidence/analyzer-profile.js";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import type { BaselineComponentEvidence } from "../../src/baseline-evidence/schema.js";
import {
  readVendorBaselineLock,
  vendorBaselineLockBytes,
  vendorBaselineLockSha256,
} from "../../src/baseline-evidence/vendor.js";

function requiredAnalyzerReceipts(
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

describe("shipped vendor baseline lock", () => {
  it("strictly parses and mirrors every pinned production catalog component", () => {
    const lock = readVendorBaselineLock();
    expect(lock.schemaVersion).toBe(1);
    expect(lock.sources.map((source) => source.id)).toEqual(["ecc", "superpowers"]);

    for (const id of ["ecc", "superpowers"] as const) {
      const catalog = baselineCatalogById(id);
      const evidence = lock.sources.find((source) => source.id === id);
      expect(evidence).toBeDefined();
      expect(evidence).toMatchObject({
        owner: catalog.owner,
        repo: catalog.repo,
        pinnedSha: catalog.pinnedSha,
      });
      expect(
        evidence?.components.map((component) => ({ id: component.id, paths: component.paths })),
      ).toEqual(
        catalog.components.map((component) => ({ id: component.id, paths: component.paths })),
      );
    }
  });

  it("retains honest pass and blocked verdicts from the vet-once scan", () => {
    const lock = readVendorBaselineLock();
    const ecc = lock.sources.find((source) => source.id === "ecc");
    const verificationLoop = ecc?.components.find(
      (component) => component.id === "skill:verification-loop",
    );
    expect(verificationLoop).toBeDefined();
    if (verificationLoop === undefined) throw new Error("verification-loop evidence is missing");
    expect(verificationLoop).toMatchObject({
      verdict: "pass",
      analyzers: requiredAnalyzerReceipts("ecc", verificationLoop),
      findings: [],
    });
    const tddWorkflow = ecc?.components.find((component) => component.id === "skill:tdd-workflow");
    expect(tddWorkflow).toMatchObject({ verdict: "pass", findings: [] });
    const documentProcessing = ecc?.components.find(
      (component) => component.id === "module:document-processing",
    );
    expect(documentProcessing).toMatchObject({ verdict: "blocked" });
    expect(documentProcessing?.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "trust.external-egress" })]),
    );
    expect(
      lock.sources
        .flatMap((source) => source.components)
        .every((component) => component.verdict === "pass" || component.findings.length > 0),
    ).toBe(true);
    expect(
      lock.sources.every((source) =>
        source.components.every(
          (component) =>
            JSON.stringify(component.analyzers.map(({ name }) => name).sort()) ===
            JSON.stringify(
              requiredAnalyzerReceipts(source.id, component)
                .map(({ name }) => name)
                .sort(),
            ),
        ),
      ),
    ).toBe(true);
  });

  it("exposes copied authoritative bytes and hashes the exact committed lock file", () => {
    const committed = readFileSync("src/baseline-evidence/vendor-lock.json");
    const bytes = vendorBaselineLockBytes();

    expect(bytes).toEqual(committed);
    expect(vendorBaselineLockSha256()).toBe(createHash("sha256").update(committed).digest("hex"));

    bytes[0] = 0;
    expect(vendorBaselineLockBytes()).toEqual(committed);
  });
});
