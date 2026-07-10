import { describe, expect, it } from "vitest";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import {
  readVendorBaselineLock,
  vendorBaselineLockSha256,
} from "../../src/baseline-evidence/vendor.js";

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
    expect(
      ecc?.components.find((component) => component.id === "skill:verification-loop"),
    ).toMatchObject({
      verdict: "pass",
      analyzers: [{ name: "aih-native", version: "2.7.0" }],
      findings: [],
    });
    expect(
      ecc?.components.find((component) => component.id === "skill:tdd-workflow"),
    ).toMatchObject({
      verdict: "blocked",
      findings: [expect.objectContaining({ code: "trust.hidden-unicode" })],
    });
    expect(
      lock.sources
        .flatMap((source) => source.components)
        .every((component) => component.verdict === "pass" || component.findings.length > 0),
    ).toBe(true);
  });

  it("exposes a stable lowercase SHA-256 receipt for the shipped lock bytes", () => {
    expect(vendorBaselineLockSha256()).toMatch(/^[0-9a-f]{64}$/);
    expect(vendorBaselineLockSha256()).toBe(vendorBaselineLockSha256());
  });
});
