import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCatalogAuthoringBundleV1 } from "../../src/catalog-package/authoring-bundle.js";
import {
  CATALOG_FRAMEWORK_PLUGINS_SUBPATH_V1,
  parseFrameworkPluginIdentitiesV1,
} from "../../src/catalog-package/framework-plugins.js";
import {
  type CatalogPackageAccessV1,
  CatalogPackageRefusalError,
  loadCatalogPackageFileV1,
} from "../../src/catalog-package/load-catalog-package.js";
import {
  candidateDescriptorBytes,
  candidateDirectory,
  candidateListingDigest,
  candidatePackageFiles,
  releaseAt,
} from "./candidate-catalog-fixture.js";

// Every Catalog document and manifest Core reads is decoded as exact UTF-8: a byte
// order mark stays in the text (and is refused as not JSON), and invalid UTF-8 is
// refused rather than replaced with U+FFFD.

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const withBom = (bytes: Uint8Array) => Buffer.concat([BOM, bytes]);
/** Canonical-looking JSON whose one string value holds a byte that is not UTF-8. */
const invalidUtf8 = (before: string, after = '"}\n') =>
  Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)]);

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function refusalOf(run: () => unknown) {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CatalogPackageRefusalError);
  return (thrown as CatalogPackageRefusalError).refusal;
}

/** A release double serving `document` at every data subpath and `manifest` as package.json. */
function release(document: Uint8Array, manifest: Uint8Array = Buffer.from('{"version":"0.3.0"}')) {
  return {
    importPackage: () => Promise.resolve({}),
    resolve: (specifier: string) =>
      specifier.endsWith("package.json") ? "C:/fixture/package.json" : "C:/fixture/document.json",
    ...releaseAt("C:/fixture/package.json"),
    readFile: (path: string) => (path.endsWith("package.json") ? manifest : document),
  } satisfies CatalogPackageAccessV1;
}

/**
 * Activates a candidate Catalog serving `bytes` at `subpath`: the named digest stands in for
 * Core's anchor, so the loader reaches its decoding step. Activation is once per process.
 */
async function activatedCandidate(subpath: string, bytes: Uint8Array) {
  vi.resetModules();
  const candidate = await import("../../src/catalog-package/candidate-catalog.js");
  const file = `defaults/${subpath.slice(2)}`;
  const files = candidatePackageFiles({
    "package.json": JSON.stringify({
      name: "@aihq/catalog",
      version: "0.3.0",
      exports: { [subpath]: `./${file}`, "./package.json": "./package.json" },
    }),
    "defaults/catalog-framework-superpowers-v1.json": undefined,
    [file]: Buffer.from(bytes),
  });
  const root = candidateDirectory(files);
  temporary.push(root);
  candidate.activateCandidateCatalogV1(
    candidate.openCandidateCatalogV1(root, candidateListingDigest(files)),
  );
  return {
    descriptors: await import("../../src/catalog-package/framework-descriptors.js"),
    loader: await import("../../src/catalog-package/load-catalog-package.js"),
    materials: await import("../../src/catalog-package/core-materials.js"),
  };
}

async function candidateRefusalOf(run: () => unknown) {
  const { CatalogPackageRefusalError: Refusal } = await import(
    "../../src/catalog-package/load-catalog-package.js"
  );
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Refusal);
  return (thrown as CatalogPackageRefusalError).refusal;
}

describe("Catalog loaders decode exact UTF-8", () => {
  it.each([
    ["a byte order mark", withBom(Buffer.from('{"format":"aih-catalog-authoring-bundle"}\n'))],
    ["invalid UTF-8", invalidUtf8('{"format":"aih-catalog-authoring-bundle","note":"')],
  ])("the authoring bundle refuses %s as not JSON", (_, bytes) => {
    expect(refusalOf(() => loadCatalogAuthoringBundleV1(release(bytes)))).toEqual({
      reason: "catalog-package-incompatible",
      detail: "the installed @aihq/catalog authoring bundle is not JSON",
    });
  });

  it.each([
    [
      "a byte order mark",
      withBom(Buffer.from('{"format":"aih-catalog-core-qualification","version":1}\n')),
    ],
    ["invalid UTF-8", invalidUtf8('{"format":"aih-catalog-core-qualification","note":"')],
  ])("a core material refuses %s as not JSON", async (_, bytes) => {
    const { materials } = await activatedCandidate("./catalog-core-qualification.json", bytes);
    expect(
      await candidateRefusalOf(() => materials.loadCatalogCoreMaterialV1("qualification")),
    ).toEqual({
      reason: "catalog-package-incompatible",
      detail: "the installed @aihq/catalog qualification material is not JSON",
    });
  });

  it.each([
    ["a byte order mark", withBom(candidateDescriptorBytes)],
    ["invalid UTF-8", invalidUtf8('{"format":"aih-catalog-framework-descriptor","note":"')],
  ])("a framework descriptor refuses %s as not JSON", async (_, bytes) => {
    const { descriptors } = await activatedCandidate("./catalog-framework-superpowers.json", bytes);
    expect(
      await candidateRefusalOf(() =>
        descriptors.loadFrameworkDescriptorSectionV1("superpowers", "vendorLock"),
      ),
    ).toMatchObject({
      reason: "catalog-package-incompatible",
      detail: expect.stringContaining("superpowers framework descriptor is not JSON;"),
    });
  });

  it.each([
    [
      "a byte order mark",
      withBom(Buffer.from('{"format":"aih-catalog-framework-plugins","version":1,"entries":[]}\n')),
    ],
    ["invalid UTF-8", invalidUtf8('{"format":"aih-catalog-framework-plugins","note":"')],
  ])("the framework plugin identities refuse %s as not strict JSON", (_, bytes) => {
    const parsed = parseFrameworkPluginIdentitiesV1(bytes);
    expect(parsed).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/^is not strict JSON/),
    });
  });

  it.each([
    ["a byte order mark", withBom(Buffer.from('{"version":"0.3.0"}'))],
    ["invalid UTF-8", invalidUtf8('{"version":"0.3.0","description":"')],
  ])("the package manifest refuses %s as an unreadable version", (_, manifest) => {
    const loaded = loadCatalogPackageFileV1(
      CATALOG_FRAMEWORK_PLUGINS_SUBPATH_V1,
      release(Buffer.from("{}\n"), manifest),
    );
    expect(loaded).toMatchObject({
      ok: false,
      refusal: {
        reason: "catalog-package-incompatible",
        detail: expect.stringContaining("version is unreadable"),
      },
    });
  });

  it("still loads a clean release manifest and document", () => {
    const loaded = loadCatalogPackageFileV1(
      CATALOG_FRAMEWORK_PLUGINS_SUBPATH_V1,
      release(Buffer.from("{}\n")),
    );
    expect(loaded.ok).toBe(true);
  });
});
