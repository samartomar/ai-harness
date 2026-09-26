import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { hashComponentTree, hashSourceTree } from "../../src/baseline-evidence/hash.js";
import { componentIdentityPaths } from "../../src/baseline-evidence/license.js";
import { createCoreBaselineVetRequests } from "../../src/baseline-evidence/scanner-consumer.js";
import {
  prepareDefinitionScannerCoverageV1,
  resolveScannerDefinitionV1,
} from "../../src/baseline-evidence/scanner-definition.js";
import { loadCatalogAuthoringBundleV1 } from "../../src/catalog-package/authoring-bundle.js";
import { canonicalStrictJsonSha256V1 } from "../../src/contract/strict-json-v1.js";
import {
  digest,
  installedSingleSourceBundle,
  sealedSingleSourceBundle,
} from "./candidate-bundle-fixture.js";

interface PackagedRecord {
  source: { repository: string; commit: string };
  sourceBundle: unknown;
}

/** The installed Catalog's own sealed source-data records: real Catalog-compiled bundles. */
function packagedRecord(repository: string): PackagedRecord {
  const record = loadCatalogAuthoringBundleV1()
    .sourceRecords.map((item) => JSON.parse(item.bytes) as PackagedRecord)
    .find((item) => item.source.repository === repository);
  if (record === undefined) throw new Error(`fixture: no packaged record for ${repository}`);
  return record;
}

const notCarried = { carriedCatalog: () => undefined };
let root: string;

function file(name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "aih-definition-coverage-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("definition-route Scanner coverage", () => {
  describe("skill collection with a sealed candidate bundle", () => {
    const PIN = "c".repeat(40);
    const skill = "---\nname: tdd\n---\n# TDD\n";
    const license = "MIT\n";
    const definition = {
      version: "pinned-skill-collection/v1",
      source: {
        id: "mattpocock",
        repository: "https://github.com/mattpocock/skills",
        commit: PIN,
      },
      license: { path: "LICENSE", bytesBase64: Buffer.from(license).toString("base64") },
      skills: [
        {
          id: "tdd",
          files: [
            { path: "skills/tdd/SKILL.md", bytesBase64: Buffer.from(skill).toString("base64") },
          ],
        },
      ],
    };
    const carriedEqual: BaselineCatalog = {
      id: "mattpocock",
      owner: "mattpocock",
      repo: "skills",
      pinnedSha: PIN,
      components: [{ id: "skill:tdd", paths: ["skills/tdd/SKILL.md"], skillContent: true }],
    };
    let source: string;

    beforeEach(() => {
      source = join(root, "mattpocock");
      mkdirSync(join(source, "skills", "tdd"), { recursive: true });
      writeFileSync(join(source, "LICENSE"), license);
      writeFileSync(join(source, "skills", "tdd", "SKILL.md"), skill);
    });

    const prepare = (
      bundle: unknown,
      extra: { vendorLockPath?: string } = {},
      deps: { carriedCatalog?: () => BaselineCatalog | undefined } = notCarried,
    ) =>
      prepareDefinitionScannerCoverageV1(
        {
          sourceRoot: source,
          catalogId: "mattpocock",
          definitionPath: file("mattpocock.definition.json", definition),
          head: PIN,
          sourceBundlePath: file("mattpocock.bundle.json", bundle),
          ...extra,
        },
        deps,
      );

    it("binds every component to the candidate bundle's admitted asset at the pin", () => {
      const prepared = prepare(sealedSingleSourceBundle("mattpocock", PIN, ["tdd"]));
      expect(prepared.catalog).toEqual(carriedEqual);
      expect(prepared.coverage).toMatchObject({
        version: "workbench-scanner-coverage/v1",
        authority: "none",
        compilerInputDigest: `sha256:${canonicalStrictJsonSha256V1(definition)}`,
        source: {
          id: "source:mattpocock",
          revisionId: PIN,
          contentDigest: digest("mattpocock revision"),
          repository: "https://github.com/mattpocock/skills",
          inputFormat: "pinned-skill-collection/v1",
        },
        repository: "mattpocock/skills",
        pinnedCommit: PIN,
        components: [
          {
            componentId: "skill:tdd",
            primaryPath: "skills/tdd/SKILL.md",
            paths: ["skills/tdd/SKILL.md"],
            files: [{ path: "skills/tdd/SKILL.md", digest: digest(skill) }],
            subject: {
              assetId: "mattpocock/skill:tdd",
              sourceId: "source:mattpocock",
              sourceRevisionId: PIN,
              contentDigest: digest("mattpocock/skill:tdd"),
            },
          },
        ],
        unmappedDerivedAssets: [],
      });
      expect(prepared.coverageDigest).toBe(
        `sha256:${canonicalStrictJsonSha256V1(prepared.coverage)}`,
      );
    });

    it("refuses checkout bytes that differ from the definition", () => {
      writeFileSync(join(source, "skills", "tdd", "SKILL.md"), `${skill}changed\n`);
      expect(() => prepare(sealedSingleSourceBundle("mattpocock", PIN, ["tdd"]))).toThrow(
        /skills\/tdd\/SKILL\.md/,
      );
    });

    it("refuses a candidate bundle that admits another revision", () => {
      const other = "d".repeat(40);
      expect(() => prepare(sealedSingleSourceBundle("mattpocock", other, ["tdd"]))).toThrow(
        `baseline definition: candidate source bundle admits mattpocock@${other}, definition pins ${PIN}`,
      );
    });

    it("refuses a candidate bundle that carries another source", () => {
      expect(() => prepare(sealedSingleSourceBundle("ponytail", PIN, ["tdd"]))).toThrow(
        "candidate source bundle must carry exactly source:mattpocock, not source:ponytail",
      );
    });

    it("refuses a candidate bundle whose sealed content was altered", () => {
      const altered = sealedSingleSourceBundle("mattpocock", PIN, ["tdd"]);
      const first = Object.values(altered.assets as Record<string, { contentDigest: string }>)[0];
      if (first === undefined) throw new Error("fixture: no asset");
      first.contentDigest = digest("tampered");
      expect(() => prepare(altered)).toThrow(/candidate source bundle is malformed or unsealed/);
    });

    it("refuses a candidate bundle without an asset for a component", () => {
      expect(() => prepare(sealedSingleSourceBundle("mattpocock", PIN, ["other"]))).toThrow(
        "Scanner component has no exact compiled asset.",
      );
    });

    it("refuses a vendor lock for a collection", () => {
      expect(() =>
        prepare(sealedSingleSourceBundle("mattpocock", PIN, ["tdd"]), {
          vendorLockPath: file("lock.json", {}),
        }),
      ).toThrow("baseline definition: --vendor-lock applies only to ecc and superpowers");
    });

    it("accepts candidate inputs at an identity-equal carried pin", () => {
      const prepared = prepare(
        sealedSingleSourceBundle("mattpocock", PIN, ["tdd"]),
        {},
        { carriedCatalog: () => carriedEqual },
      );
      expect(prepared.catalog).toEqual(carriedEqual);
      expect(prepared.coverage.components).toHaveLength(1);
    });
  });

  describe("carried ECC pin with candidate evidence", () => {
    const PIN = "c".repeat(40);
    const catalog: BaselineCatalog = {
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: PIN,
      components: [{ id: "skill:demo", paths: ["skills/demo/SKILL.md"], skillContent: true }],
    };
    let source: string;

    beforeEach(() => {
      source = join(root, "ecc");
      mkdirSync(join(source, "skills", "demo"), { recursive: true });
      writeFileSync(join(source, "skills", "demo", "SKILL.md"), "# Demo\n");
    });

    const bundle = () => sealedSingleSourceBundle("ecc", PIN, ["demo"]);
    const snapshot = (version: string) => ({
      id: "ecc",
      owner: "affaan-m",
      repo: "ECC",
      pinnedSha: PIN,
      sourceTreeSha256: hashSourceTree(source).treeSha256,
      components: [
        {
          id: "skill:demo",
          paths: ["skills/demo/SKILL.md"],
          treeSha256: hashComponentTree(
            source,
            componentIdentityPaths(source, ["skills/demo/SKILL.md"]),
          ).treeSha256,
          verdict: "no-findings",
          analyzers: [{ name: "fixture", version }],
          findings: [],
          evidenceProblems: [],
        },
      ],
    });
    const prepare = (
      definition: BaselineCatalog = catalog,
      candidateBundle: unknown = bundle(),
      lock?: unknown,
    ) =>
      prepareDefinitionScannerCoverageV1(
        {
          sourceRoot: source,
          catalogId: "ecc",
          definitionPath: file("ecc.definition.json", definition),
          head: PIN,
          sourceBundlePath: file("ecc.bundle.json", candidateBundle),
          ...(lock === undefined ? {} : { vendorLockPath: file("ecc.lock.json", lock) }),
        },
        { carriedCatalog: () => catalog },
      );

    it("binds coverage to the new candidate lock instead of the installed snapshot", () => {
      const oldSnapshot = snapshot("old");
      const newSnapshot = snapshot("new");
      const prepared = prepare(catalog, bundle(), { schemaVersion: 2, sources: [newSnapshot] });
      const admitted = bundle().sources["source:ecc"];
      const expected = `sha256:${canonicalStrictJsonSha256V1({ source: admitted, sourceSnapshot: newSnapshot })}`;
      const previous = `sha256:${canonicalStrictJsonSha256V1({ source: admitted, sourceSnapshot: oldSnapshot })}`;
      expect(prepared.catalog).toEqual(catalog);
      expect(prepared.coverage.compilerInputDigest).toBe(expected);
      expect(prepared.coverage.compilerInputDigest).not.toBe(previous);
      expect(prepared.coverage.components).toHaveLength(1);
    });

    it("refuses a definition different from the carried Catalog declaration", () => {
      const different = {
        ...catalog,
        components: [{ id: "skill:other", paths: ["skills/demo/SKILL.md"] }],
      };
      expect(() =>
        prepare(different, bundle(), { schemaVersion: 2, sources: [snapshot("new")] }),
      ).toThrow(/the definition differs/);
    });

    it("refuses a bundle for another pin", () => {
      expect(() =>
        prepare(catalog, sealedSingleSourceBundle("ecc", "d".repeat(40), ["demo"]), {
          schemaVersion: 2,
          sources: [snapshot("new")],
        }),
      ).toThrow(/candidate source bundle admits ecc@/);
    });

    it("refuses a lock that does not vet this pin", () => {
      const other = { ...snapshot("new"), pinnedSha: "d".repeat(40) };
      expect(() => prepare(catalog, bundle(), { schemaVersion: 2, sources: [other] })).toThrow(
        `vendor lock does not vet ecc@${PIN}`,
      );
    });

    it("requires --vendor-lock for a carried framework pin", () => {
      expect(() => prepare()).toThrow("ecc coverage requires --vendor-lock <assembled lock>");
    });
  });

  describe("collection inventories at new pins (B6)", () => {
    const INVENTORIES = fileURLToPath(
      new URL("../fixtures/baseline-evidence/inventories/", import.meta.url),
    );
    const inventory = (name: string): BaselineCatalog =>
      JSON.parse(readFileSync(join(INVENTORIES, `${name}.inventory.json`), "utf8"));

    /** A checkout holding every inventory path (listed files, or a directory with one file) and `extra`. */
    function checkout(catalog: BaselineCatalog, extra: readonly string[] = []): string {
      const source = join(root, catalog.id);
      for (const path of extra) {
        mkdirSync(dirname(join(source, path)), { recursive: true });
        writeFileSync(join(source, path), `${path}\n`);
      }
      for (const component of catalog.components)
        for (const path of component.paths) {
          const file =
            component.skillContent !== true && (component.paths.length > 1 || path.includes("/"));
          const target = file
            ? join(source, path)
            : join(source, path, component.skillContent ? "SKILL.md" : "x.txt");
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, `${component.id}\n`);
        }
      return source;
    }

    /** The upstream asset ids a bundle admits, sorted. */
    const upstreamIds = (bundle: ReturnType<typeof installedSingleSourceBundle>) =>
      Object.values(bundle.assets)
        .filter((asset) => asset.derivation === "upstream")
        .map((asset) => asset.id)
        .sort();

    /** A checkout of the inventory that also holds every compiled asset's original path. */
    const checkoutFor = (
      catalog: BaselineCatalog,
      bundle: ReturnType<typeof installedSingleSourceBundle>,
    ) =>
      checkout(
        catalog,
        Object.values(bundle.assets).map((asset) => asset.originalPath),
      );

    const subjectsOf = (component: object) =>
      "subjects" in component
        ? (component.subjects as readonly { assetId: string }[])
        : ([] as const);

    const prepareInventory = (
      catalog: BaselineCatalog,
      source: string,
      bundle: unknown,
      extra: { vendorLockPath?: string } = {},
    ) =>
      prepareDefinitionScannerCoverageV1(
        {
          sourceRoot: source,
          catalogId: catalog.id,
          definitionPath: file(`${catalog.id}.inventory.json`, catalog),
          head: catalog.pinnedSha,
          sourceBundlePath: file(`${catalog.id}.bundle.json`, bundle),
          ...extra,
        },
        notCarried,
      );

    it.each([
      // The installed Catalog's own compiled bundle at its own (new) pin, and the same
      // compiled partition re-pinned to the previous-pin inventories.
      ["ponytail-1d95ff7d", false, "https://github.com/DietrichGebert/ponytail", 28],
      ["mattpocock-c55ee460", false, "https://github.com/mattpocock/skills", 22],
      ["ponytail-356918eb", true, "https://github.com/DietrichGebert/ponytail", 28],
      ["mattpocock-3cca18b3", true, "https://github.com/mattpocock/skills", 21],
    ] as const)(
      "binds %s's real compiled assets zero-to-many and keeps every component's scan (re-pinned: %s)",
      (name, repin, locator, withoutAssets) => {
        const catalog = inventory(name);
        const bundle = installedSingleSourceBundle(
          catalog.id,
          repin ? catalog.pinnedSha : undefined,
        );
        const source = checkoutFor(catalog, bundle);
        const prepared = prepareInventory(catalog, source, bundle);
        // The T2 partition is the inventory itself, so its expected publication layout is
        // exactly the requests T1 authored from the same --definition.
        const t1 = resolveScannerDefinitionV1(
          {
            sourceRoot: source,
            catalogId: catalog.id,
            definitionPath: file(`${name}.t1.json`, catalog),
            head: catalog.pinnedSha,
          },
          notCarried,
        );
        expect(prepared.catalog).toEqual(catalog);
        expect(createCoreBaselineVetRequests(source, prepared.catalog)).toEqual(
          createCoreBaselineVetRequests(source, t1.catalog),
        );
        const { components } = prepared.coverage;
        // Every inventory component keeps its scan coverage, whatever its asset count.
        expect(components.map((component) => component.componentId)).toEqual(
          catalog.components.map((component) => component.id),
        );
        for (const [index, component] of components.entries()) {
          expect(component.paths).toEqual(catalog.components[index]?.paths);
          expect(component.files.length).toBeGreaterThan(0);
          for (const subject of subjectsOf(component))
            expect(component.files.map((entry) => entry.path)).toContain(
              bundle.assets[subject.assetId]?.originalPath,
            );
        }
        // Every compiled upstream asset belongs to exactly one inventory component.
        const subjects = components.flatMap(subjectsOf);
        expect(subjects.map((subject) => subject.assetId).sort()).toEqual(upstreamIds(bundle));
        for (const subject of subjects) {
          const asset = bundle.assets[subject.assetId];
          expect(subject).toEqual({
            assetId: asset?.id,
            sourceId: asset?.sourceId,
            sourceRevisionId: catalog.pinnedSha,
            contentDigest: asset?.contentDigest,
          });
        }
        expect(components.filter((component) => subjectsOf(component).length === 0).length).toBe(
          withoutAssets,
        );
        expect(prepared.coverage.unmappedDerivedAssets).toEqual(
          Object.values(bundle.assets)
            .filter((asset) => asset.derivation !== "upstream")
            .map((asset) => asset.id)
            .sort(),
        );
        expect(prepared.coverage).toMatchObject({
          compilerInputDigest: `sha256:${canonicalStrictJsonSha256V1(catalog)}`,
          source: {
            id: `source:${catalog.id}`,
            revisionId: catalog.pinnedSha,
            repository: locator,
          },
          repository: `${catalog.owner}/${catalog.repo}`,
          pinnedCommit: catalog.pinnedSha,
        });
        expect(prepared.coverageDigest).toBe(
          `sha256:${canonicalStrictJsonSha256V1(prepared.coverage)}`,
        );
      },
    );

    it("binds several compiled assets to one component: the five ponytail hooks", () => {
      const catalog = inventory("ponytail-1d95ff7d");
      const bundle = installedSingleSourceBundle(catalog.id, catalog.pinnedSha);
      const hooks = prepareInventory(
        catalog,
        checkoutFor(catalog, bundle),
        bundle,
      ).coverage.components.find((component) => component.paths.join() === "hooks");
      expect(subjectsOf(hooks ?? {}).map((subject) => subject.assetId)).toEqual([
        "ponytail/hook:cursor-before-submit-prompt",
        "ponytail/hook:cursor-session-start",
        "ponytail/hook:session-start",
        "ponytail/hook:subagent-start",
        "ponytail/hook:user-prompt-submit",
      ]);
    });

    it("refuses a compiled upstream asset that no inventory component scans", () => {
      const catalog = inventory("ponytail-1d95ff7d");
      const source = checkoutFor(
        catalog,
        installedSingleSourceBundle(catalog.id, catalog.pinnedSha),
      );
      // Outside every component, and inside a component directory but not a scanned file.
      for (const originalPath of ["absent/x.md", "hooks/unscanned.js"]) {
        const bundle = installedSingleSourceBundle(catalog.id, catalog.pinnedSha, [
          { id: "ponytail/hook:extra", originalPath },
        ]);
        expect(() => prepareInventory(catalog, source, bundle)).toThrow(
          `Scanner provider coverage: admitted upstream asset ponytail/hook:extra names ${originalPath}, which no inventory component scans`,
        );
      }
    });

    it("leaves a derived asset unmapped instead of binding it to a component", () => {
      const catalog = inventory("mattpocock-c55ee460");
      const bundle = installedSingleSourceBundle(catalog.id, catalog.pinnedSha, [
        {
          id: "mattpocock/profile:derived",
          originalPath: "skills/engineering/tdd/SKILL.md",
          derivation: "core-derived",
        },
      ]);
      const { coverage } = prepareInventory(catalog, checkoutFor(catalog, bundle), bundle);
      expect(coverage.unmappedDerivedAssets).toEqual(["mattpocock/profile:derived"]);
      expect(
        coverage.components.flatMap(subjectsOf).map((subject) => subject.assetId),
      ).not.toContain("mattpocock/profile:derived");
    });

    it("refuses a vendor lock for a collection inventory", () => {
      const catalog = inventory("mattpocock-c55ee460");
      const bundle = installedSingleSourceBundle(catalog.id, catalog.pinnedSha);
      expect(() =>
        prepareInventory(catalog, checkoutFor(catalog, bundle), bundle, {
          vendorLockPath: file("lock.json", {}),
        }),
      ).toThrow("baseline definition: --vendor-lock applies only to ecc and superpowers");
    });
  });

  describe("superpowers framework at the carried pin", () => {
    const record = packagedRecord("obra/Superpowers");
    let source: string;
    let definition: BaselineCatalog;

    beforeEach(() => {
      source = join(root, "superpowers");
      definition = baselineCatalogById("superpowers");
      for (const component of definition.components)
        for (const path of component.paths) {
          mkdirSync(join(source, dirname(path)), { recursive: true });
          if (!/\.[a-z]+$/.test(path)) mkdirSync(join(source, path), { recursive: true });
          else writeFileSync(join(source, path), "{}\n");
        }
    });

    const prepare = (vendorLockPath?: string) =>
      prepareDefinitionScannerCoverageV1(
        {
          sourceRoot: source,
          catalogId: "superpowers",
          definitionPath: file("superpowers.definition.json", definition),
          head: definition.pinnedSha,
          sourceBundlePath: file("superpowers.bundle.json", record.sourceBundle),
          ...(vendorLockPath === undefined ? {} : { vendorLockPath }),
        },
        notCarried,
      );

    it("requires the assembled vendor lock for a framework", () => {
      expect(() => prepare()).toThrow(
        "baseline definition: superpowers coverage requires --vendor-lock <assembled lock>",
      );
    });

    it("refuses a vendor lock that does not vet this source at the definition pin", () => {
      expect(() => prepare(file("empty-lock.json", { schemaVersion: 1, sources: [] }))).toThrow(
        /baseline definition: vendor lock/,
      );
    });
  });
});
