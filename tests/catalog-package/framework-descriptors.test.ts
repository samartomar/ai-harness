import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  ACCEPTED_CATALOG_FRAMEWORK_DESCRIPTOR_SHA256_V1,
  loadFrameworkDescriptorBytesV1,
} from "../../src/catalog-package/framework-descriptors.js";
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
  it("returns the exact installed bytes Core's authority table accepts", async () => {
    for (const frameworkId of ["ecc", "superpowers"] as const) {
      const bytes = readFileSync(
        requireFromTest.resolve(`@aihq/catalog/catalog-framework-${frameworkId}.json`),
      );
      const result = await loadFrameworkDescriptorBytesV1(frameworkId, access());
      if (!result.ok) throw new Error(result.refusal.detail);
      const { bytes: loaded, ...identity } = result;
      expect(identity).toEqual({
        ok: true,
        frameworkId,
        sha256: ACCEPTED_CATALOG_FRAMEWORK_DESCRIPTOR_SHA256_V1[frameworkId],
        catalogVersion: "0.3.0",
      });
      expect(Buffer.from(loaded).equals(bytes)).toBe(true);
    }
  });

  it("refuses reader-accepted bytes whose digest Core does not accept", async () => {
    const document = {
      format: "aih-catalog-framework-descriptor",
      version: 1,
      frameworkId: "superpowers",
      sections: { vendorLock: { pinnedSha: "f".repeat(40) } },
    };
    const bytes = Buffer.from(`${JSON.stringify(document)}
`);
    const result = await loadFrameworkDescriptorBytesV1(
      "superpowers",
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
            : "C:/fixture/catalog-framework-superpowers-v1.json",
        readFile: (path) =>
          path.endsWith("package.json") ? Buffer.from('{"version":"0.3.0"}') : bytes,
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      refusal: {
        reason: "catalog-package-incompatible",
        detail: expect.stringContaining(
          `unaccepted authority sha256 ${createHash("sha256").update(bytes).digest("hex")}`,
        ),
      },
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
