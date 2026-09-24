import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { loadFrameworkDescriptorBytesV1 } from "../../src/catalog-package/framework-descriptors.js";
import type { CatalogPackageAccessV1 } from "../../src/catalog-package/load-catalog-package.js";

const requireFromTest = createRequire(import.meta.url);

function access(overrides: Partial<CatalogPackageAccessV1> = {}): CatalogPackageAccessV1 {
  return {
    importPackage: () => import("@aihq/catalog"),
    resolve: (specifier) => requireFromTest.resolve(specifier),
    readFile: (path) => readFileSync(path),
    ...overrides,
  };
}

describe("loadFrameworkDescriptorBytesV1", () => {
  it("returns exact validated bytes and their digest", async () => {
    const document = {
      format: "aih-catalog-framework-descriptor",
      version: 1,
      frameworkId: "ecc",
      sections: { components: [] },
    };
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
    const result = await loadFrameworkDescriptorBytesV1(
      "ecc",
      access({
        importPackage: () =>
          Promise.resolve({
            readCatalogFrameworkDescriptorV1Result: () => ({
              state: "read",
              descriptor: document,
            }),
          }),
        resolve: (specifier) =>
          specifier.endsWith("package.json")
            ? "C:/fixture/package.json"
            : "C:/fixture/catalog-framework-ecc-v1.json",
        readFile: (path) =>
          path.endsWith("package.json") ? Buffer.from('{"version":"0.3.0"}') : bytes,
      }),
    );
    expect(result).toEqual({
      ok: true,
      frameworkId: "ecc",
      bytes: Uint8Array.from(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      catalogVersion: "0.3.0",
    });
  });

  it("preserves unavailable and incompatible package refusals", async () => {
    const unavailable = await loadFrameworkDescriptorBytesV1(
      "ecc",
      access({
        importPackage: () =>
          Promise.reject(
            Object.assign(new Error("Cannot find package '@aihq/catalog' imported from test"), {
              code: "ERR_MODULE_NOT_FOUND",
            }),
          ),
      }),
    );
    expect(unavailable).toMatchObject({
      ok: false,
      refusal: { reason: "catalog-package-unavailable" },
    });

    const incompatible = await loadFrameworkDescriptorBytesV1(
      "ecc",
      access({ importPackage: () => Promise.resolve({}) }),
    );
    expect(incompatible).toMatchObject({
      ok: false,
      refusal: { reason: "catalog-package-incompatible" },
    });
  });
});
