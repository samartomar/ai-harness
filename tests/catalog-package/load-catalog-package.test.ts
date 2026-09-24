import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOG_PACKAGE_INSTALL_COMMAND,
  CATALOG_PACKAGE_PEER_RANGE,
  CATALOG_PACKAGE_PROJECT_INSTALL_COMMAND,
  type CatalogPackageAccessV1,
  catalogPackageRefusalMessage,
  loadCatalogPackageFileV1,
  loadCatalogPackageV1,
} from "../../src/catalog-package/load-catalog-package.js";

// ---------------------------------------------------------------------------
// @aihq/catalog is an optional peer of @aihq/core. Core reaches it only through
// this one module, at run time. `catalog-package-unavailable` means "not
// installed" and nothing else; an installed Catalog that cannot be loaded or
// lacks a needed export or subpath is `catalog-package-incompatible`, which no
// caller may answer with a substitute.
// ---------------------------------------------------------------------------

const requireFromTest = createRequire(import.meta.url);
const installedRoot = dirname(requireFromTest.resolve("@aihq/catalog/package.json"));

function moduleNotFound(name = "@aihq/catalog"): Error {
  return Object.assign(
    new Error(`Cannot find package '${name}' imported from /consumer/node_modules/@aihq/core`),
    { code: "ERR_MODULE_NOT_FOUND" },
  );
}

function access(overrides: Partial<CatalogPackageAccessV1> = {}): CatalogPackageAccessV1 {
  return {
    importPackage: () => import("@aihq/catalog"),
    resolve: (specifier) => requireFromTest.resolve(specifier),
    readFile: (path) => readFileSync(path),
    ...overrides,
  };
}

const READERS = ["readCatalogContentV1Result", "readCatalogRuntimeDescriptorsV1Result"] as const;
const SUBPATHS = ["./catalog-index.json", "./catalog-runtime-descriptors.json"] as const;

describe("load-catalog-package", () => {
  it("states the supported install arrangement", () => {
    expect(CATALOG_PACKAGE_INSTALL_COMMAND).toBe(
      "npm install -g @aihq/core @aihq/scan @aihq/catalog",
    );
    expect(CATALOG_PACKAGE_PROJECT_INSTALL_COMMAND).toBe(
      "npm install @aihq/core @aihq/scan @aihq/catalog",
    );
    expect(CATALOG_PACKAGE_PEER_RANGE).toBe(">=0.3.0 <0.4.0");
  });

  it("hands back the installed readers and the exact bytes of the named public subpaths", async () => {
    const loaded = await loadCatalogPackageV1(READERS, SUBPATHS, access());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const catalog = await import("@aihq/catalog");
    expect(loaded.exports.readCatalogRuntimeDescriptorsV1Result).toBe(
      catalog.readCatalogRuntimeDescriptorsV1Result,
    );
    expect(Object.keys(loaded.exports).sort()).toEqual([...READERS].sort());
    expect(loaded.root).toBe(installedRoot);
    expect(loaded.version).toBe("0.3.0");
    const sidecar = loaded.files["./catalog-runtime-descriptors.json"];
    expect(sidecar.path).toBe(
      join(installedRoot, "defaults", "catalog-runtime-descriptors-v1.json"),
    );
    expect(Buffer.from(sidecar.bytes).equals(readFileSync(sidecar.path))).toBe(true);
    expect(Buffer.from(loaded.files["./catalog-index.json"].bytes).length).toBeGreaterThan(0);
  });

  it("refuses as catalog-package-unavailable only when the package is not installed", async () => {
    const loaded = await loadCatalogPackageV1(
      READERS,
      SUBPATHS,
      access({ importPackage: () => Promise.reject(moduleNotFound()) }),
    );
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.reason).toBe("catalog-package-unavailable");
    expect(loaded.refusal.detail).toContain("@aihq/catalog is not installed");
    expect(loaded.refusal.detail).toContain(CATALOG_PACKAGE_INSTALL_COMMAND);
    expect(loaded.refusal.detail).toContain(CATALOG_PACKAGE_PROJECT_INSTALL_COMMAND);
    expect(catalogPackageRefusalMessage(loaded.refusal)).toBe(
      `catalog-package-unavailable: ${loaded.refusal.detail}`,
    );
  });

  it("treats an installed Catalog that fails to load as incompatible, never as absent", async () => {
    for (const error of [
      new SyntaxError(`broken install ${"x".repeat(1_000)}`),
      moduleNotFound("zod"),
      Object.assign(new Error("Cannot find module '/c/node_modules/@aihq/catalog/dist/index.js'"), {
        code: "ERR_MODULE_NOT_FOUND",
      }),
    ]) {
      const loaded = await loadCatalogPackageV1(
        READERS,
        SUBPATHS,
        access({ importPackage: () => Promise.reject(error) }),
      );
      expect(loaded.ok).toBe(false);
      if (loaded.ok) continue;
      expect(loaded.refusal.reason).toBe("catalog-package-incompatible");
      expect(loaded.refusal.detail).toContain("could not be loaded");
      expect(loaded.refusal.detail).toContain(CATALOG_PACKAGE_INSTALL_COMMAND);
      expect(loaded.refusal.detail.length).toBeLessThan(800);
    }
  });

  it("does not mistake a broken installed package path for an absent package", async () => {
    for (const brokenPath of [
      "/consumer/node_modules/@aihq/catalog/dist/missing.js",
      "C:\\consumer\\node_modules\\@aihq\\catalog\\dist\\missing.js",
    ]) {
      const loaded = await loadCatalogPackageV1(
        READERS,
        SUBPATHS,
        access({
          importPackage: () =>
            Promise.reject(
              Object.assign(new Error(`Cannot find module '${brokenPath}'`), {
                code: "MODULE_NOT_FOUND",
              }),
            ),
          resolve: (specifier) =>
            specifier.endsWith("package.json")
              ? `${brokenPath.slice(0, brokenPath.lastIndexOf("dist"))}package.json`
              : requireFromTest.resolve(specifier),
        }),
      );
      expect(loaded).toMatchObject({
        ok: false,
        refusal: { reason: "catalog-package-incompatible" },
      });
    }
  });

  it("refuses an installed Catalog outside the exact compatible minor range", async () => {
    const loaded = await loadCatalogPackageV1(
      [],
      [],
      access({
        resolve: (specifier) =>
          specifier.endsWith("/package.json") ? "C:/catalog/package.json" : specifier,
        readFile: () => Buffer.from('{"name":"@aihq/catalog","version":"0.2.0"}'),
      }),
    );
    expect(loaded).toMatchObject({
      ok: false,
      refusal: {
        reason: "catalog-package-incompatible",
        detail: expect.stringContaining("version 0.2.0"),
      },
    });
  });

  it("refuses as incompatible when a needed reader is not a function", async () => {
    const loaded = await loadCatalogPackageV1(
      READERS,
      SUBPATHS,
      access({
        importPackage: () =>
          Promise.resolve({ readCatalogContentV1Result: () => ({}), unrelated: 1 }),
      }),
    );
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.reason).toBe("catalog-package-incompatible");
    expect(loaded.refusal.detail).toContain(
      "does not export readCatalogRuntimeDescriptorsV1Result",
    );
    expect(loaded.refusal.detail).not.toContain("readCatalogContentV1Result,");
    expect(loaded.refusal.detail).toContain(CATALOG_PACKAGE_PEER_RANGE);
  });

  it("treats an export that throws on access, or a non-object module, as incompatible", async () => {
    const hostile = {};
    Object.defineProperty(hostile, "readCatalogContentV1Result", {
      get() {
        throw new Error("no such export on this mock");
      },
    });
    for (const namespace of [hostile, undefined]) {
      const loaded = await loadCatalogPackageV1(
        ["readCatalogContentV1Result"],
        [],
        access({ importPackage: () => Promise.resolve(namespace) }),
      );
      expect(loaded).toMatchObject({
        ok: false,
        refusal: { reason: "catalog-package-incompatible" },
      });
    }
  });

  it("refuses as incompatible when the installed Catalog does not publish a needed subpath", async () => {
    // An installed Catalog without the required subpath is incompatible.
    const loaded = await loadCatalogPackageV1(
      READERS,
      SUBPATHS,
      access({
        resolve: (specifier) => {
          if (specifier.endsWith("/catalog-runtime-descriptors.json"))
            throw Object.assign(new Error("Package subpath is not defined by exports"), {
              code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
            });
          return requireFromTest.resolve(specifier);
        },
      }),
    );
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.reason).toBe("catalog-package-incompatible");
    expect(loaded.refusal.detail).toContain("does not export ./catalog-runtime-descriptors.json");
  });

  it("refuses as incompatible when a published subpath cannot be read", async () => {
    const loaded = await loadCatalogPackageV1(
      READERS,
      SUBPATHS,
      access({
        readFile: (path) => {
          if (path.endsWith("catalog-index-v1.json")) throw new Error("EACCES: permission denied");
          return readFileSync(path);
        },
      }),
    );
    expect(loaded).toMatchObject({
      ok: false,
      refusal: { reason: "catalog-package-incompatible" },
    });
    if (loaded.ok) return;
    expect(loaded.refusal.detail).toContain("./catalog-index.json could not be read");
  });

  describe("an installed candidate Catalog", () => {
    const manifestPath = join(installedRoot, "package.json");
    const markerPath = join(installedRoot, "CANDIDATE.json");
    const marker = { format: "aih-catalog-candidate", version: 1, inputsSha256: "0".repeat(64) };
    /** The installed release, marked the way the Catalog candidate build marks a candidate. */
    function marked(field: boolean, file: boolean): CatalogPackageAccessV1 {
      return access({
        readFile: (path) => {
          if (path === manifestPath && field)
            return Buffer.from(
              JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), aihCandidate: marker }),
            );
          if (path === markerPath && file) return Buffer.from(JSON.stringify(marker));
          return readFileSync(path);
        },
      });
    }

    it.each([
      ["both markers", true, true, "CANDIDATE.json, package.json#aihCandidate"],
      ["CANDIDATE.json alone", false, true, "CANDIDATE.json"],
      ["package.json#aihCandidate alone", true, false, "package.json#aihCandidate"],
    ])(
      "refuses one carrying %s on every ordinary load path",
      async (_label, field, file, named) => {
        const detail = `the installed @aihq/catalog carries ${named}: a candidate Catalog is not a release`;
        const loaded = await loadCatalogPackageV1(READERS, SUBPATHS, marked(field, file));
        expect(loaded).toMatchObject({
          ok: false,
          refusal: {
            reason: "catalog-package-incompatible",
            detail: expect.stringContaining(detail),
          },
        });
        expect(loadCatalogPackageFileV1("./catalog-index.json", marked(field, file))).toMatchObject(
          {
            ok: false,
            refusal: {
              reason: "catalog-package-incompatible",
              detail: expect.stringContaining(detail),
            },
          },
        );
      },
    );

    it("refuses when the candidate marker cannot be checked", () => {
      const loaded = loadCatalogPackageFileV1(
        "./catalog-index.json",
        access({
          readFile: (path) => {
            if (path === markerPath) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
            return readFileSync(path);
          },
        }),
      );
      expect(loaded).toMatchObject({
        ok: false,
        refusal: {
          reason: "catalog-package-incompatible",
          detail: expect.stringContaining("could not be checked for a candidate marker"),
        },
      });
    });

    it("leaves a release without either marker unaffected", async () => {
      expect((await loadCatalogPackageV1(READERS, SUBPATHS, marked(false, false))).ok).toBe(true);
      expect(loadCatalogPackageFileV1("./catalog-index.json", marked(false, false)).ok).toBe(true);
    });
  });
});
