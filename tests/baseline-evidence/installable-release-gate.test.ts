import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spliceReusedComponent } from "../../src/baseline-evidence/reuse.js";
import { readVendorBaselineLock } from "../../src/baseline-evidence/vendor.js";
import {
  checkInstallableBaseline,
  postureOkForCatalog,
  samePaths,
} from "../../src/internals/check-baseline-installable.js";

const ALL_POSTURES = ["vibe", "team", "enterprise"] as const;

describe("shipped baseline installability", () => {
  it("reproduces the v2.8.0 zero-installable enterprise lock", async () => {
    const lock = JSON.parse(
      readFileSync(
        join(process.cwd(), "tests/fixtures/baseline-evidence/ecc-v2.8.0-vendor-lock.json"),
        "utf8",
      ),
    );

    const report = await checkInstallableBaseline({ lock, fixtureOnly: true });

    expect(report.catalogs.ecc.pin).toBe("4130457d674d2180c5af2c5f634f3cae4cbc6c4f");
    expect(report.catalogs.ecc.postures.enterprise.installed).toBe(0);
    expect(report.ok).toBe(false);
  });

  it("installs the current shipped ECC lock at every posture and holds hooks-runtime at enterprise", async () => {
    const lock = readVendorBaselineLock();
    const eccPin = lock.sources.find((source) => source.id === "ecc")?.pinnedSha;

    const report = await checkInstallableBaseline({ lock, fixtureOnly: true });

    expect(report.catalogs.ecc.pin).toBe(eccPin);
    for (const posture of ALL_POSTURES) {
      expect(report.catalogs.ecc.postures[posture].installed).toBeGreaterThan(0);
      expect(report.catalogs.ecc.postures[posture].installedComponentIds).toContain(
        "runtime:ecc-installer",
      );
    }

    // Enterprise installs the authorized common/project baseline while holding the auto-exec hook
    // module. The current pinned candidate holds module:hooks-runtime via strict-surface Unicode
    // findings rather than trust.auto-exec-hook, so assert it is held and named with codes.
    const heldHooks = report.catalogs.ecc.postures.enterprise.held.find(
      (entry) => entry.componentId === "module:hooks-runtime",
    );
    expect(heldHooks).toBeDefined();
    expect(heldHooks?.codes.length ?? 0).toBeGreaterThan(0);

    expect(report.catalogs.ecc.ok).toBe(true);
  });

  it("evaluates the current shipped Superpowers lock at every posture: honestly 0 installed, 15 held all-coded, gate green", async () => {
    const lock = readVendorBaselineLock();
    const superpowersPin = lock.sources.find((source) => source.id === "superpowers")?.pinnedSha;

    const report = await checkInstallableBaseline({ lock, fixtureOnly: true });

    expect(report.catalogs.superpowers.pin).toBe(superpowersPin);
    for (const posture of ALL_POSTURES) {
      const result = report.catalogs.superpowers.postures[posture];
      expect(result.installed).toBe(0);
      expect(result.installedComponentIds).toEqual([]);
      expect(result.held).toHaveLength(15);
      expect(result.held.every((entry) => entry.codes.length > 0)).toBe(true);
      // Today's shipped evidence is honestly blocked (real trust findings), not missing/mismatched,
      // so a zero-installed Superpowers catalog must still be reported green (issue #438).
      expect(
        result.held.every(
          (entry) =>
            !entry.codes.includes("baseline.evidence-missing") &&
            !entry.codes.includes("baseline.evidence-mismatch"),
        ),
      ).toBe(true);
    }

    expect(report.catalogs.superpowers.ok).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("fails the gate when the Superpowers source is removed from the lock entirely", async () => {
    const lock = structuredClone(readVendorBaselineLock());
    lock.sources = lock.sources.filter((source) => source.id !== "superpowers");

    const report = await checkInstallableBaseline({ lock, fixtureOnly: true });

    expect(report.catalogs.superpowers.ok).toBe(false);
    expect(report.ok).toBe(false);
    for (const posture of ALL_POSTURES) {
      const result = report.catalogs.superpowers.postures[posture];
      expect(result.installed).toBe(0);
      expect(result.held).toHaveLength(15);
      for (const entry of result.held) {
        expect(entry.codes).toEqual(["baseline.evidence-missing"]);
      }
    }
  });

  it("fails the gate when a single Superpowers component entry is deleted from its source", async () => {
    const lock = structuredClone(readVendorBaselineLock());
    const source = lock.sources.find((candidate) => candidate.id === "superpowers");
    if (source === undefined) throw new Error("superpowers evidence missing from vendor lock");
    source.components = source.components.filter(
      (component) => component.id !== "skill:brainstorming",
    );

    const report = await checkInstallableBaseline({ lock, fixtureOnly: true });

    expect(report.catalogs.superpowers.ok).toBe(false);
    expect(report.ok).toBe(false);
    const held = report.catalogs.superpowers.postures.vibe.held.find(
      (entry) => entry.componentId === "skill:brainstorming",
    );
    expect(held?.codes).toEqual(["baseline.evidence-missing"]);
  });

  it("fails the gate when a Superpowers component's evidence paths drift from the catalog", async () => {
    const lock = structuredClone(readVendorBaselineLock());
    const source = lock.sources.find((candidate) => candidate.id === "superpowers");
    const component = source?.components.find(
      (candidate) => candidate.id === "skill:brainstorming",
    );
    if (component === undefined)
      throw new Error("superpowers skill:brainstorming evidence missing");
    component.paths = [...component.paths, "skills/brainstorming/drifted-extra-path"];

    const report = await checkInstallableBaseline({ lock, fixtureOnly: true });

    expect(report.catalogs.superpowers.ok).toBe(false);
    expect(report.ok).toBe(false);
    const held = report.catalogs.superpowers.postures.vibe.held.find(
      (entry) => entry.componentId === "skill:brainstorming",
    );
    expect(held?.codes).toEqual(["baseline.evidence-mismatch"]);
  });

  it("fails the gate when the ECC installer runtime verdict flips to blocked (pins existing ECC behavior)", async () => {
    const lock = structuredClone(readVendorBaselineLock());
    const source = lock.sources.find((candidate) => candidate.id === "ecc");
    const installer = source?.components.find(
      (candidate) => candidate.id === "runtime:ecc-installer",
    );
    if (installer === undefined) throw new Error("ECC installer evidence missing from vendor lock");
    installer.verdict = "blocked";
    installer.findings = [
      { code: "trust.synthetic-test-block", detail: "synthetic test-only block for issue #438" },
    ];

    const report = await checkInstallableBaseline({ lock, fixtureOnly: true });

    expect(report.catalogs.ecc.ok).toBe(false);
    expect(report.ok).toBe(false);
    for (const posture of ALL_POSTURES) {
      expect(report.catalogs.ecc.postures[posture].installedComponentIds).not.toContain(
        "runtime:ecc-installer",
      );
    }
  });

  it("authorizes and ledger round-trips a Superpowers component when its evidence verdict is pass", async () => {
    const lock = structuredClone(readVendorBaselineLock());
    const source = lock.sources.find((candidate) => candidate.id === "superpowers");
    const component = source?.components.find(
      (candidate) => candidate.id === "skill:using-superpowers",
    );
    if (component === undefined) {
      throw new Error("superpowers skill:using-superpowers evidence missing");
    }
    component.verdict = "pass";
    component.findings = [];

    const report = await checkInstallableBaseline({ lock, fixtureOnly: true });

    expect(report.catalogs.superpowers.ok).toBe(true);
    expect(report.ok).toBe(true);
    for (const posture of ALL_POSTURES) {
      const result = report.catalogs.superpowers.postures[posture];
      expect(result.installed).toBe(1);
      expect(result.installedComponentIds).toEqual(["skill:using-superpowers"]);
      expect(result.held).toHaveLength(14);
    }
  });
});

describe("ledger comparison logic (samePaths as used for ledger-vs-authorized-ids matching)", () => {
  // `checkInstallableBaseline` writes the fixture registration ledger from the very same
  // `authorizations` array it derives `installedComponentIds` from, so a real end-to-end
  // ledger/authorization mismatch is unreachable through the public API without adding a new
  // production test-only seam (see report). This pins the comparison primitive itself
  // (`ledgerMatches = samePaths(ledgerIds, installedComponentIds)`) directly.
  it("matches when the ledger's component ids equal the authorized/installed ids", () => {
    const installedComponentIds = ["skill:brainstorming", "skill:writing-plans"].sort();
    const ledgerIds = ["skill:writing-plans", "skill:brainstorming"].sort();
    expect(samePaths(ledgerIds, installedComponentIds)).toBe(true);
  });

  it("flags a mismatch when the ledger is missing a component id that evidence authorized", () => {
    const installedComponentIds = ["skill:brainstorming", "skill:writing-plans"].sort();
    const ledgerIds = ["skill:brainstorming"].sort();
    expect(samePaths(ledgerIds, installedComponentIds)).toBe(false);
  });

  it("flags a mismatch when the ledger carries an extra component id evidence never authorized", () => {
    const installedComponentIds = ["skill:brainstorming"].sort();
    const ledgerIds = ["skill:brainstorming", "skill:writing-plans"].sort();
    expect(samePaths(ledgerIds, installedComponentIds)).toBe(false);
  });
});

describe("postureOkForCatalog preview-escape gating for non-installer catalogs (latent path)", () => {
  // PREVIEW_ARTIFACT_BY_CATALOG is a module constant (not injectable) and no current non-installer
  // catalog ships a preview artifact, so this path is unreachable end-to-end through
  // checkInstallableBaseline today. Pin the criterion function directly instead: escape findings
  // must gate every catalog that ships a preview, independent of the installer requirement.
  const nonInstallerInput = {
    catalogId: "superpowers" as const,
    authorizations: [],
    held: [{ componentId: "skill:brainstorming", codes: ["trust.hidden-unicode"] }],
    ledgerMatches: true,
  };

  it("stays green for a non-installer catalog with zero preview escapes", () => {
    expect(postureOkForCatalog({ ...nonInstallerInput, previewEscapeCount: 0 })).toBe(true);
  });

  it("goes red for a non-installer catalog when a preview destination escapes the fixture", () => {
    expect(postureOkForCatalog({ ...nonInstallerInput, previewEscapeCount: 1 })).toBe(false);
  });

  it("installs identically from a lock whose ECC components were reuse-spliced (issue #444, bullet 6)", async () => {
    const lock = readVendorBaselineLock();
    const baseline = await checkInstallableBaseline({ lock, fixtureOnly: true });

    const splicedLock = {
      ...lock,
      sources: lock.sources.map((source) =>
        source.id === "ecc"
          ? {
              ...source,
              components: source.components.map((component) => spliceReusedComponent(component)),
            }
          : source,
      ),
    };
    const splicedReport = await checkInstallableBaseline({ lock: splicedLock, fixtureOnly: true });

    expect(splicedReport.ok).toBe(baseline.ok);
    for (const posture of ["vibe", "team", "enterprise"] as const) {
      expect(splicedReport.catalogs.ecc.postures[posture].installedComponentIds).toEqual(
        baseline.catalogs.ecc.postures[posture].installedComponentIds,
      );
    }
  });
});
