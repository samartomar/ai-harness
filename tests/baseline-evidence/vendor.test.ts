import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  baselineAnalyzerVersions,
  requiredBaselineAnalyzersForComponent,
} from "../../src/baseline-evidence/analyzer-profile.js";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import type { BaselineComponentEvidence } from "../../src/baseline-evidence/schema.js";
import {
  admitCatalogVendorLockDocumentV1,
  readVendorBaselineLock,
  vendorBaselineLockBytes,
  vendorBaselineLockSha256,
} from "../../src/baseline-evidence/vendor.js";
import { loadFrameworkDescriptorSectionV1 } from "../../src/catalog-package/framework-descriptors.js";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";

/**
 * The installed Catalog fixture's lock is the requalified one, vetted with the U1
 * analyzers: each receipt names the analyzer identity Core requires today.
 */
const CURRENT_ANALYZERS = baselineAnalyzerVersions();

function requiredAnalyzerReceipts(
  sourceId: string,
  component: BaselineComponentEvidence,
): Array<{ name: string; version: string }> {
  const canonical = baselineCatalogById(sourceId).components.find(
    (candidate) => candidate.id === component.id,
  );
  if (canonical === undefined) throw new Error(`missing canonical component ${component.id}`);
  return [...requiredBaselineAnalyzersForComponent(canonical)]
    .map((name) => ({ name, version: CURRENT_ANALYZERS[name] ?? "" }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

describe("shipped vendor baseline lock", () => {
  it("strictly parses and mirrors every pinned production catalog component", () => {
    const lock = readVendorBaselineLock();
    expect(lock.schemaVersion).toBe(2);
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

  it("carries every receipt at the analyzer identity Core requires today", () => {
    const receipts = readVendorBaselineLock().sources.flatMap((source) =>
      source.components.flatMap((component) => component.analyzers),
    );
    expect(receipts.length).toBeGreaterThan(0);
    for (const receipt of receipts) expect(receipt.version).toBe(CURRENT_ANALYZERS[receipt.name]);
  });

  it("retains the no-findings and has-findings verdicts from the vet-once scan", () => {
    const lock = readVendorBaselineLock();
    const ecc = lock.sources.find((source) => source.id === "ecc");
    const verificationLoop = ecc?.components.find(
      (component) => component.id === "skill:verification-loop",
    );
    expect(verificationLoop).toBeDefined();
    if (verificationLoop === undefined) throw new Error("verification-loop evidence is missing");
    expect(verificationLoop).toMatchObject({
      verdict: "no-findings",
      analyzers: requiredAnalyzerReceipts("ecc", verificationLoop),
      findings: [],
    });
    // The WARN-inclusive lock records a Cisco WARN on tdd-workflow, as information.
    const tddWorkflow = ecc?.components.find((component) => component.id === "skill:tdd-workflow");
    expect(tddWorkflow).toMatchObject({ verdict: "has-findings" });
    expect(tddWorkflow?.findings).toEqual([
      expect.objectContaining({
        code: "trust.cisco-finding",
        detail: expect.stringMatching(/^WARN: /),
      }),
    ]);
    const documentProcessing = ecc?.components.find(
      (component) => component.id === "module:document-processing",
    );
    expect(documentProcessing).toMatchObject({ verdict: "has-findings" });
    expect(documentProcessing?.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "trust.external-egress" })]),
    );
    expect(
      lock.sources
        .flatMap((source) => source.components)
        .every(
          (component) => (component.verdict === "has-findings") === component.findings.length > 0,
        ),
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

  it("exposes copied authoritative bytes and hashes the exact Catalog-carried lock", () => {
    const document = loadFrameworkDescriptorSectionV1<{ bytesBase64: string }>(
      "ecc",
      "vendorLockDocument",
    );
    const committed = Buffer.from(document.bytesBase64, "base64");
    const bytes = vendorBaselineLockBytes();

    expect(bytes).toEqual(committed);
    expect(vendorBaselineLockSha256()).toBe(createHash("sha256").update(committed).digest("hex"));

    bytes[0] = 0;
    expect(vendorBaselineLockBytes()).toEqual(committed);
  });

  it("refuses a flipped verdict even when Catalog recomputes its self-digest", () => {
    const lock = readVendorBaselineLock();
    const blocked = lock.sources
      .flatMap((source) => source.components)
      .find((item) => item.verdict === "has-findings");
    if (blocked === undefined) throw new Error("missing has-findings fixture component");
    blocked.verdict = "no-findings";
    blocked.findings = [];
    const bytes = Buffer.concat([canonicalStrictJsonBytesV1(lock), Buffer.from("\n")]);
    expect(() =>
      admitCatalogVendorLockDocumentV1({
        bytesBase64: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    ).toThrow(/authority sha256 .* is not accepted/);
  });
});
