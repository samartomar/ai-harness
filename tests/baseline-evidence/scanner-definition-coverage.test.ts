import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { prepareDefinitionScannerCoverageV1 } from "../../src/baseline-evidence/scanner-definition.js";
import { loadCatalogAuthoringBundleV1 } from "../../src/catalog-package/authoring-bundle.js";
import { canonicalStrictJsonSha256V1 } from "../../src/contract/strict-json-v1.js";
import { digest, sealedSingleSourceBundle } from "./candidate-bundle-fixture.js";

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

    it("refuses candidate inputs at a pin the installed Catalog carries", () => {
      expect(() =>
        prepare(
          sealedSingleSourceBundle("mattpocock", PIN, ["tdd"]),
          {},
          { carriedCatalog: () => carriedEqual },
        ),
      ).toThrow(
        `baseline definition: the installed Catalog carries mattpocock@${PIN}; run without candidate inputs`,
      );
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
