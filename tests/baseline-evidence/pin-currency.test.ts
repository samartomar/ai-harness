import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baselineAnalyzerVersions } from "../../src/baseline-evidence/analyzer-profile.js";
import type { BaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { BASELINE_CATALOG_IDS, baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { comparePinSets, formatPinCurrency } from "../../src/baseline-evidence/pin-currency.js";
import type { BaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";
import vendorLock from "../../src/baseline-evidence/vendor-lock.json" with { type: "json" };
import {
  checkBaselinePinCurrency,
  defaultLockPath,
  runPinCurrencyCli,
} from "../../src/internals/check-baseline-pin-currency.js";

const CATALOGS = BASELINE_CATALOG_IDS.map((id) => baselineCatalogById(id));
const lock = vendorLock as unknown as BaselineEvidenceLock;

function withSourcePin(pin: string): BaselineEvidenceLock {
  return {
    ...lock,
    sources: lock.sources.map((source) =>
      source.id === "ecc" ? { ...source, pinnedSha: pin } : source,
    ),
  };
}

function withAnalyzerVersion(name: string, version: string): BaselineEvidenceLock {
  return {
    ...lock,
    sources: lock.sources.map((source) => ({
      ...source,
      components: source.components.map((component) => ({
        ...component,
        analyzers: component.analyzers.map((receipt) =>
          receipt.name === name ? { ...receipt, version } : receipt,
        ),
      })),
    })),
  };
}

describe("baseline pin currency", () => {
  const analyzerVersions = baselineAnalyzerVersions();

  it("reports no drift for the committed lock, which was vetted at these exact pins", () => {
    expect(comparePinSets({ lock, catalogs: CATALOGS, analyzerVersions })).toEqual([]);
    expect(formatPinCurrency([])).toContain("matches every declared pin");
  });

  it("fires when a source pin moves — the case that makes a re-vet critical", () => {
    const drift = comparePinSets({
      lock: withSourcePin("f".repeat(40)),
      catalogs: CATALOGS,
      analyzerVersions,
    });
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ kind: "source", id: "ecc", recorded: "f".repeat(40) });
    expect(drift[0]?.declared).toBe(CATALOGS.find((c) => c.id === "ecc")?.pinnedSha);
  });

  it("fires when an analyzer identity moves, even though every source pin is unchanged", () => {
    // The exact case a path-based relevance gate is worst at: the sources are
    // untouched, but the thing doing the scanning is not the thing that scanned.
    const drift = comparePinSets({
      lock: withAnalyzerVersion("skillspector@docker", "rev@sha256:stale"),
      catalogs: CATALOGS,
      analyzerVersions,
    });
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      kind: "analyzer",
      id: "skillspector@docker",
      recorded: "rev@sha256:stale",
    });
  });

  it("reports a moved analyzer once, not once per component", () => {
    const drifted = withAnalyzerVersion("aih-native", "native.000000000000");
    const affected = drifted.sources.flatMap((source) => source.components).length;
    expect(affected).toBeGreaterThan(100);
    expect(comparePinSets({ lock: drifted, catalogs: CATALOGS, analyzerVersions })).toHaveLength(1);
  });

  it("treats an analyzer the build no longer declares as drift rather than ignoring it", () => {
    const drift = comparePinSets({
      lock: withAnalyzerVersion("aih-native", "native.000000000000"),
      catalogs: CATALOGS,
      analyzerVersions: {} as Record<string, string>,
    });
    expect(drift.some((entry) => entry.declared === "(not declared)")).toBe(true);
  });

  it("treats a source missing from the lock as drift, not as nothing to check", () => {
    const partial: BaselineEvidenceLock = {
      ...lock,
      sources: lock.sources.filter((source) => source.id === "ecc"),
    };
    const drift = comparePinSets({ lock: partial, catalogs: CATALOGS, analyzerVersions });
    expect(drift).toContainEqual(
      expect.objectContaining({ kind: "source", id: "superpowers", recorded: "(absent)" }),
    );
  });

  it("names the re-vet as the remedy, because drift is stale evidence not a fixable defect", () => {
    const report = formatPinCurrency([
      { kind: "source", id: "ecc", declared: "a".repeat(40), recorded: "b".repeat(40) },
    ]);
    expect(report).toContain("stale evidence");
    expect(report).toContain("baseline:request");
    expect(report).toContain("immutable Scanner publications");
    expect(report).toContain("baseline-publication-consume");
    expect(report).not.toContain("baseline:vet");
    expect(report).not.toContain("--full");
  });

  it("does not compare component content hashes — that is baseline:check's job", () => {
    const contentMoved: BaselineEvidenceLock = {
      ...lock,
      sources: lock.sources.map((source) => ({
        ...source,
        components: source.components.map((component) => ({
          ...component,
          treeSha256: "0".repeat(64),
        })),
      })),
    };
    expect(comparePinSets({ lock: contentMoved, catalogs: CATALOGS, analyzerVersions })).toEqual(
      [],
    );
  });

  it("passes on the committed lock through the CLI entry point", () => {
    const result = checkBaselinePinCurrency("src/baseline-evidence/vendor-lock.json");
    expect(result.ok).toBe(true);
    expect(result.report).toContain("matches every declared pin");
  });

  it("reports not-ok through the CLI entry point when a pin has moved", () => {
    // The failure path matters more than the passing one: this is the branch
    // that turns a routine check into a blocking one, and it is what a reader
    // sees when a re-vet has become mandatory.
    const dir = mkdtempSync(join(tmpdir(), "aih-pin-currency-"));
    const lockPath = join(dir, "vendor-lock.json");
    try {
      writeFileSync(lockPath, JSON.stringify(withSourcePin("c".repeat(40))), "utf8");
      const result = checkBaselinePinCurrency(lockPath);
      expect(result.ok).toBe(false);
      expect(result.report).toContain("no longer match the committed evidence");
      expect(result.report).toContain("ecc");
      expect(result.report).toContain("stale evidence");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a lock that does not parse rather than reporting no drift", () => {
    expect(() => checkBaselinePinCurrency("package.json")).toThrow();
  });

  it("defaults to the committed lock the check exists to defend", () => {
    expect(defaultLockPath().replace(/\\/g, "/")).toContain(
      "src/baseline-evidence/vendor-lock.json",
    );
  });

  it("exits 0 and prints the report when the committed evidence is current", () => {
    const written: string[] = [];
    expect(runPinCurrencyCli(defaultLockPath(), (text) => written.push(text))).toBe(0);
    expect(written.join("")).toContain("matches every declared pin");
  });

  it("exits 1 when a pin has moved, so CI blocks rather than warns", () => {
    const dir = mkdtempSync(join(tmpdir(), "aih-pin-currency-cli-"));
    const lockPath = join(dir, "vendor-lock.json");
    const written: string[] = [];
    try {
      writeFileSync(lockPath, JSON.stringify(withSourcePin("e".repeat(40))), "utf8");
      expect(runPinCurrencyCli(lockPath, (text) => written.push(text))).toBe(1);
      expect(written.join("")).toContain("no longer match the committed evidence");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("catalog coverage", () => {
  it("checks every declared baseline catalog, so a new one cannot be silently unguarded", () => {
    const checked = new Set(CATALOGS.map((catalog: BaselineCatalog) => catalog.id));
    expect([...checked].sort()).toEqual([...BASELINE_CATALOG_IDS].sort());
  });
});
