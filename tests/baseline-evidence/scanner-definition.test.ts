import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import {
  resolveScannerDefinitionV1,
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
      { id: "module:hooks-runtime", paths: ["scripts/lib"] },
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

  it("refuses overlapping paths inside one component but keeps overlapping component views", () => {
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
    // runtime:ecc-installer and module:hooks-runtime overlap on purpose (as in the governed lock).
    expect(resolveEcc(eccDefinition()).route).toBe("definition");
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
