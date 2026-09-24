import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import {
  resolveScannerDefinitionV1,
  SCANNER_DEFINITION_OVERLAP_MODES_V1,
  SCANNER_DEFINITION_SOURCES_V1,
} from "../../src/baseline-evidence/scanner-definition.js";

const PIN = "5064474d4d762dc9640234a41617cccb79185cec";
const OLD = "5caf398a91599029a176ca6d806409b00d1052c4";

let root: string;
let source: string;

function write(relative: string, text: string): void {
  const path = join(source, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function definitionFile(value: unknown, name = "definition.json"): string {
  const path = join(root, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

function eccDefinition(overrides: Partial<BaselineCatalog> = {}): BaselineCatalog {
  return {
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: PIN,
    components: [
      { id: "runtime:ecc-installer", paths: ["package.json", "scripts/lib/install"] },
      { id: "module:hooks-runtime", paths: ["scripts/lib/other.js"] },
      { id: "skill:tdd", paths: ["skills/tdd"], skillContent: true },
    ],
    ...overrides,
  };
}

const notCarried = { carriedCatalog: () => undefined };

function resolveEcc(
  value: unknown,
  deps: Parameters<typeof resolveScannerDefinitionV1>[1] = notCarried,
) {
  return resolveScannerDefinitionV1(
    { sourceRoot: source, catalogId: "ecc", definitionPath: definitionFile(value), head: PIN },
    deps,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "aih-scanner-definition-"));
  source = join(root, "source");
  mkdirSync(source);
  write("package.json", "{}\n");
  write("scripts/lib/install/plan.js", "module.exports = {};\n");
  write("scripts/lib/other.js", "module.exports = {};\n");
  write("skills/tdd/SKILL.md", "---\nname: tdd\n---\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("definition-driven Scanner catalog resolution", () => {
  it("names the closed set of upstream subjects a definition may describe", () => {
    expect(SCANNER_DEFINITION_SOURCES_V1).toEqual({
      ecc: { repository: "affaan-m/ECC", kind: "framework" },
      superpowers: { repository: "obra/Superpowers", kind: "framework" },
      mattpocock: {
        repository: "mattpocock/skills",
        kind: "collection",
        version: "pinned-skill-collection/v1",
      },
      ponytail: {
        repository: "DietrichGebert/ponytail",
        kind: "collection",
        version: "pinned-component-collection/v1",
      },
    });
  });

  it("uses the definition when the installed Catalog does not carry that pin", () => {
    const resolved = resolveEcc(eccDefinition(), {
      carriedCatalog: () => eccDefinition({ pinnedSha: OLD }),
    });
    expect(resolved.route).toBe("definition");
    expect(resolved.catalog).toEqual(eccDefinition());
  });

  it("defers to the installed Catalog route only when it carries the identical definition", () => {
    const reordered = eccDefinition();
    reordered.components = [...reordered.components].reverse();
    expect(resolveEcc(eccDefinition(), { carriedCatalog: () => reordered }).route).toBe(
      "installed",
    );
  });

  it("refuses when the installed Catalog carries that pin with a different definition", () => {
    const carried = eccDefinition({
      components: [{ id: "runtime:ecc-installer", paths: ["package.json"] }],
    });
    expect(() => resolveEcc(eccDefinition(), { carriedCatalog: () => carried })).toThrow(
      /installed Catalog carries ecc@5064474d4d762dc9640234a41617cccb79185cec \(sha256:[0-9a-f]{64}\); the definition differs \(sha256:[0-9a-f]{64}\)/,
    );
  });

  it("propagates an unusable installed Catalog instead of falling back to the definition", () => {
    expect(() =>
      resolveEcc(eccDefinition(), {
        carriedCatalog: () => {
          throw new Error("catalog-package-unavailable");
        },
      }),
    ).toThrow("catalog-package-unavailable");
  });

  it("refuses a checkout that is not at the definition pin", () => {
    expect(() =>
      resolveScannerDefinitionV1(
        {
          sourceRoot: source,
          catalogId: "ecc",
          definitionPath: definitionFile(eccDefinition()),
          head: OLD,
        },
        notCarried,
      ),
    ).toThrow(`ecc checkout is ${OLD}, definition pins ${PIN}`);
  });

  it.each([
    ["an unknown subject", "anthropics-skills", eccDefinition({ id: "anthropics-skills" })],
    ["a mismatched id", "ecc", eccDefinition({ id: "superpowers" })],
    ["a moved repository", "ecc", eccDefinition({ owner: "someone-else" })],
    ["a case-changed repository", "ecc", eccDefinition({ repo: "ecc" })],
  ])("refuses %s", (_label, catalogId, value) => {
    expect(() =>
      resolveScannerDefinitionV1(
        { sourceRoot: source, catalogId, definitionPath: definitionFile(value), head: PIN },
        notCarried,
      ),
    ).toThrow(/baseline definition/);
  });

  it.each([
    ["duplicate keys", `{"id":"ecc","id":"ecc"}`],
    ["non-JSON", "not json"],
    ["an array", "[]"],
    ["extra fields", { ...eccDefinition(), extra: true }],
    ["an unsafe path", eccDefinition({ components: [{ id: "x:y", paths: ["../outside"] }] })],
    ["a short pin", eccDefinition({ pinnedSha: "5064474d" })],
  ])("rejects a malformed definition with %s", (_label, value) => {
    expect(() => resolveEcc(value)).toThrow(/baseline definition/);
  });

  it("refuses a missing component path", () => {
    expect(() =>
      resolveEcc(eccDefinition({ components: [{ id: "skill:gone", paths: ["skills/gone"] }] })),
    ).toThrow("baseline definition: path does not exist: skills/gone");
  });

  it("refuses a component path that is or traverses a link", () => {
    symlinkSync(join(source, "skills", "tdd"), join(source, "linked"), "junction");
    expect(() =>
      resolveEcc(eccDefinition({ components: [{ id: "skill:linked", paths: ["linked"] }] })),
    ).toThrow("baseline definition: path traverses a link: linked");
    expect(() =>
      resolveEcc(
        eccDefinition({ components: [{ id: "skill:linked", paths: ["linked/SKILL.md"] }] }),
      ),
    ).toThrow("baseline definition: path traverses a link: linked/SKILL.md");
  });

  it("refuses overlapping paths inside one component", () => {
    expect(() =>
      resolveEcc(
        eccDefinition({
          components: [
            { id: "runtime:ecc-installer", paths: ["scripts/lib", "scripts/lib/install"] },
          ],
        }),
      ),
    ).toThrow(
      "baseline definition: component runtime:ecc-installer paths overlap: scripts/lib, scripts/lib/install",
    );
  });

  it("compares path segments, not adjacent sorted strings", () => {
    write("a/c", "c\n");
    write("a-b", "b\n");
    expect(() =>
      resolveEcc(eccDefinition({ components: [{ id: "skill:a", paths: ["a", "a-b", "a/c"] }] })),
    ).toThrow("baseline definition: component skill:a paths overlap: a, a/c");
    // "a-b" shares a string prefix with "a" but not a path segment.
    expect(
      resolveEcc(
        eccDefinition({
          components: [
            { id: "skill:a", paths: ["a"] },
            { id: "skill:a-b", paths: ["a-b"] },
          ],
        }),
      ).route,
    ).toBe("definition");
  });

  it("refuses a path repeated inside one component", () => {
    expect(() =>
      resolveEcc(
        eccDefinition({
          components: [{ id: "runtime:ecc-installer", paths: ["package.json", "package.json"] }],
        }),
      ),
    ).toThrow(/^baseline definition: ecc definition is malformed/);
  });

  it("refuses overlap between components across the whole inventory by default", () => {
    const overlapping = eccDefinition({
      components: [
        { id: "runtime:ecc-installer", paths: ["package.json", "scripts/lib/install"] },
        { id: "module:hooks-runtime", paths: ["scripts/lib"] },
      ],
    });
    expect(() => resolveEcc(overlapping)).toThrow(
      "baseline definition: components module:hooks-runtime and runtime:ecc-installer overlap: scripts/lib, scripts/lib/install",
    );
    const equal = eccDefinition({
      components: [
        { id: "runtime:ecc-installer", paths: ["package.json"] },
        { id: "module:hooks-runtime", paths: ["package.json"] },
      ],
    });
    expect(() => resolveEcc(equal)).toThrow(
      "baseline definition: components runtime:ecc-installer and module:hooks-runtime overlap: package.json, package.json",
    );
  });

  it("keeps overlapping component views only in the named compiler-catalog mode", () => {
    const views = eccDefinition({
      components: [
        { id: "runtime:ecc-installer", paths: ["package.json", "scripts/lib/install"] },
        { id: "module:hooks-runtime", paths: ["scripts/lib"] },
        { id: "module:all", paths: ["package.json"] },
      ],
    });
    const resolveViews = (overlap?: "disjoint" | "compiler-catalog") =>
      resolveScannerDefinitionV1(
        {
          sourceRoot: source,
          catalogId: "ecc",
          definitionPath: definitionFile(views),
          head: PIN,
          ...(overlap === undefined ? {} : { overlap }),
        },
        notCarried,
      );
    expect(() => resolveViews()).toThrow(/overlap/);
    expect(() => resolveViews("disjoint")).toThrow(/overlap/);
    expect(resolveViews("compiler-catalog").route).toBe("definition");
    // Within one component the named mode still refuses.
    const inner = eccDefinition({
      components: [{ id: "runtime:ecc-installer", paths: ["scripts/lib", "scripts/lib/install"] }],
    });
    expect(() =>
      resolveScannerDefinitionV1(
        {
          sourceRoot: source,
          catalogId: "ecc",
          definitionPath: definitionFile(inner),
          head: PIN,
          overlap: "compiler-catalog",
        },
        notCarried,
      ),
    ).toThrow("component runtime:ecc-installer paths overlap: scripts/lib, scripts/lib/install");
  });

  it("refuses paths that differ only by case anywhere in the inventory, in every mode", () => {
    // `skills/tdd` and `Skills/tdd` name one directory on a case-insensitive file system.
    const aliases = eccDefinition({
      components: [
        { id: "skill:tdd", paths: ["skills/tdd"], skillContent: true },
        { id: "skill:tdd-upper", paths: ["Skills/tdd"], skillContent: true },
      ],
    });
    for (const overlap of ["disjoint", "compiler-catalog"] as const)
      expect(() =>
        resolveScannerDefinitionV1(
          {
            sourceRoot: source,
            catalogId: "ecc",
            definitionPath: definitionFile(aliases),
            head: PIN,
            overlap,
          },
          notCarried,
        ),
      ).toThrow("baseline definition: paths differ only by case: skills, Skills");
    // An ancestor spelled two ways collides even when the leaves differ.
    const ancestors = eccDefinition({
      components: [
        { id: "skill:tdd", paths: ["skills/tdd"], skillContent: true },
        { id: "skill:other", paths: ["SKILLS/other"], skillContent: true },
      ],
    });
    expect(() => resolveEcc(ancestors)).toThrow(
      "baseline definition: paths differ only by case: skills, SKILLS",
    );
    // Inside one component, too.
    const inner = eccDefinition({
      components: [{ id: "runtime:ecc-installer", paths: ["package.json", "Package.json"] }],
    });
    expect(() => resolveEcc(inner)).toThrow(
      "baseline definition: paths differ only by case: package.json, Package.json",
    );
  });

  it.each([
    // `I` and `ı` lowercase to different keys yet name one directory on Windows.
    [
      "a dotless i beside a capital I",
      ["I/SKILL.md", "ı/x"],
      "ı/x",
      "a character outside printable ASCII",
    ],
    ["a non-ASCII letter", ["docs/café.md"], "docs/café.md", "a character outside printable ASCII"],
    ["a long s", ["ſkills/x.md"], "ſkills/x.md", "a character outside printable ASCII"],
    ["a colon", ["a:b/x.md"], "a:b/x.md", "a Windows-reserved character"],
    ...["<", ">", '"', "|", "?", "*"].map(
      (character) =>
        [
          `the Windows-reserved character ${character}`,
          [`a${character}b/x.md`],
          `a${character}b/x.md`,
          "a Windows-reserved character",
        ] as const,
    ),
    ["a segment ending in a dot", ["docs./x.md"], "docs./x.md", "a trailing dot or space"],
    ["a segment ending in a space", ["notes .md "], "notes .md ", "a trailing dot or space"],
    ...["CON", "prn", "Aux", "nul.txt", "COM1.md", "lpt9", "com0.tar.gz", "NUL .md"].map(
      (name) =>
        [
          `the Windows-reserved name ${name}`,
          [`skills/${name}/SKILL.md`],
          `skills/${name}/SKILL.md`,
          "a Windows-reserved name",
        ] as const,
    ),
    ["an 8.3 short-name shape", ["LONGNA~1.MD"], "LONGNA~1.MD", "an 8.3 short-name shape"],
  ] as const)(
    "refuses %s before reading the checkout, as the Catalog emitter does",
    (_label, paths, path, reason) => {
      for (const overlap of ["disjoint", "compiler-catalog"] as const)
        expect(() =>
          resolveScannerDefinitionV1(
            {
              sourceRoot: source,
              catalogId: "ecc",
              definitionPath: definitionFile(
                eccDefinition({ components: [{ id: "runtime:x", paths: [...paths] }] }),
              ),
              head: PIN,
              overlap,
            },
            notCarried,
          ),
        ).toThrow(`baseline definition: non-portable path ${JSON.stringify(path)}: ${reason}`);
    },
  );

  it("accepts portable near misses of the refused spellings", () => {
    const paths = [
      "a b/x.md",
      ".github/ci.yml",
      "CONSOLE.md",
      "con-fig/x.md",
      "com10.md",
      "x~y.md",
    ];
    for (const path of paths) write(path, "x\n");
    expect(
      resolveEcc(eccDefinition({ components: [{ id: "runtime:x", paths }] })).catalog.components,
    ).toEqual([{ id: "runtime:x", paths }]);
  });

  it("requires the exact file-system spelling of every path segment on every platform", () => {
    expect(() =>
      resolveEcc(
        eccDefinition({
          components: [{ id: "skill:tdd", paths: ["Skills/tdd"], skillContent: true }],
        }),
      ),
    ).toThrow("baseline definition: path spelling differs from the file system: Skills/tdd");
    expect(() =>
      resolveEcc(
        eccDefinition({
          components: [{ id: "skill:tdd", paths: ["skills/tdd/skill.md"], skillContent: true }],
        }),
      ),
    ).toThrow(
      "baseline definition: path spelling differs from the file system: skills/tdd/skill.md",
    );
  });

  it("names the overlap modes a definition may be resolved in", () => {
    expect(SCANNER_DEFINITION_OVERLAP_MODES_V1).toEqual(["disjoint", "compiler-catalog"]);
  });

  describe("collections", () => {
    const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");

    function ponytail(overrides: Record<string, unknown> = {}) {
      return {
        version: "pinned-component-collection/v1",
        source: {
          id: "ponytail",
          repository: "https://github.com/DietrichGebert/ponytail",
          commit: PIN,
          version: "4.10.0",
          licenseFileRef: "LICENSE",
        },
        files: [
          { path: "LICENSE", bytesBase64: base64("MIT\n"), sha256: sha("MIT\n"), size: 4 },
          {
            path: "skills/ponytail/SKILL.md",
            bytesBase64: base64("# P\n"),
            sha256: sha("# P\n"),
            size: 4,
          },
        ],
        components: [
          {
            id: "skill:ponytail",
            kind: "skill",
            label: "Ponytail",
            fileRefs: ["skills/ponytail/SKILL.md"],
            description: "Main skill.",
            primaryPath: "skills/ponytail/SKILL.md",
          },
        ],
        profile: { id: "ponytail" },
        template: { kind: "opaque" },
        ...overrides,
      };
    }

    function resolvePonytail(value: unknown) {
      return resolveScannerDefinitionV1(
        {
          sourceRoot: source,
          catalogId: "ponytail",
          definitionPath: definitionFile(value, "ponytail.json"),
          head: PIN,
        },
        notCarried,
      );
    }

    beforeEach(() => {
      write("LICENSE", "MIT\n");
      write("skills/ponytail/SKILL.md", "# P\n");
    });

    it("derives the Scanner catalog from a pinned component collection", () => {
      const resolved = resolvePonytail(ponytail());
      expect(resolved).toEqual({
        route: "definition",
        catalog: {
          id: "ponytail",
          owner: "DietrichGebert",
          repo: "ponytail",
          pinnedSha: PIN,
          components: [
            { id: "skill:ponytail", paths: ["skills/ponytail/SKILL.md"], skillContent: true },
          ],
        },
      });
    });

    it("derives the Scanner catalog from a pinned skill collection", () => {
      write("skills/tdd/SKILL.md", "# T\n");
      const resolved = resolveScannerDefinitionV1(
        {
          sourceRoot: source,
          catalogId: "mattpocock",
          definitionPath: definitionFile({
            version: "pinned-skill-collection/v1",
            collectionDigest: `sha256:${"0".repeat(64)}`,
            source: {
              id: "mattpocock",
              repository: "https://github.com/mattpocock/skills",
              commit: PIN,
              version: "1.2.3",
            },
            license: { path: "LICENSE", bytesBase64: base64("MIT\n"), sha256: sha("MIT\n") },
            skills: [
              {
                id: "tdd",
                files: [{ path: "skills/tdd/SKILL.md", bytesBase64: base64("# T\n") }],
              },
            ],
          }),
          head: PIN,
        },
        notCarried,
      );
      expect(resolved.catalog.components).toEqual([
        { id: "skill:tdd", paths: ["skills/tdd/SKILL.md"], skillContent: true },
      ]);
    });

    it("accepts a whole-repository inventory for a collection subject", () => {
      const inventory: BaselineCatalog = {
        components: [
          { id: "runtime:root-4813494d137e", paths: ["LICENSE"] },
          {
            id: "skill:skills-ponytail-000000000000",
            paths: ["skills/ponytail"],
            skillContent: true,
          },
        ],
        id: "ponytail",
        owner: "DietrichGebert",
        pinnedSha: PIN,
        repo: "ponytail",
      };
      expect(resolvePonytail(inventory)).toEqual({ route: "definition", catalog: inventory });
      // The inventory route keeps every other definition check.
      expect(() => resolvePonytail({ ...inventory, repo: "other" })).toThrow(
        "ponytail must name DietrichGebert/ponytail, not DietrichGebert/other",
      );
      expect(() =>
        resolvePonytail({
          ...inventory,
          components: [...inventory.components, { id: "runtime:skills-1", paths: ["skills"] }],
        }),
      ).toThrow("overlap: skills, skills/ponytail");
      // A carried pin with a different catalog is refused, never replaced by the inventory.
      expect(() =>
        resolveScannerDefinitionV1(
          {
            sourceRoot: source,
            catalogId: "ponytail",
            definitionPath: definitionFile(inventory, "carried.json"),
            head: PIN,
          },
          {
            carriedCatalog: () => ({ ...inventory, components: inventory.components.slice(0, 1) }),
          },
        ),
      ).toThrow(/installed Catalog carries ponytail@/);
    });

    it("parses a collection-shaped definition only as a collection", () => {
      // A definition that declares a collection version is never re-read as an inventory.
      expect(() => resolvePonytail({ ...ponytail(), components: undefined })).toThrow(
        /ponytail collection is malformed/,
      );
    });

    it("refuses a carried file outside the portable path set before reading the checkout", () => {
      const files = [
        ...ponytail().files,
        { path: "NUL.md", bytesBase64: base64("x\n"), sha256: sha("x\n"), size: 2 },
      ];
      expect(() => resolvePonytail(ponytail({ files }))).toThrow(
        'baseline definition: non-portable path "NUL.md": a Windows-reserved name',
      );
    });

    it("refuses snapshot bytes that differ from the checkout", () => {
      write("skills/ponytail/SKILL.md", "# changed\n");
      expect(() => resolvePonytail(ponytail())).toThrow(
        "Scanner source differs from reviewed snapshot bytes: skills/ponytail/SKILL.md",
      );
    });

    it.each([
      ["a wrong version", { version: "pinned-skill-collection/v1" }],
      [
        "a declared sha256 that disagrees with the bytes",
        {
          files: [{ path: "LICENSE", bytesBase64: base64("MIT\n"), sha256: "0".repeat(64) }],
          components: [],
        },
      ],
      [
        "a component naming a file it does not carry",
        {
          components: [{ id: "skill:x", kind: "skill", fileRefs: ["skills/x/SKILL.md"] }],
        },
      ],
      [
        "a non-GitHub repository",
        {
          source: {
            id: "ponytail",
            repository: "https://example.com/DietrichGebert/ponytail",
            commit: PIN,
          },
        },
      ],
      ["an unknown field", { extra: 1 }],
    ])("rejects a collection definition with %s", (_label, overrides) => {
      expect(() => resolvePonytail(ponytail(overrides))).toThrow(/baseline definition/);
    });
  });
});
