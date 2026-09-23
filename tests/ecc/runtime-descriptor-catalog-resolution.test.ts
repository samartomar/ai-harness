import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPackageAccessV1 } from "../../src/catalog-package/load-catalog-package.js";
import { canonicalStrictJsonSha256V1 } from "../../src/contract/strict-json-v1.js";

// ---------------------------------------------------------------------------
// WO Step 3A: the historical ECC runtime descriptor is resolved in an explicit,
// recorded order. After Core's own protected local receipts, the INSTALLED
// @aihq/catalog carries the descriptor bytes and Core accepts them only when
// their sha256 is one Core pins. Core's embedded copy is used only when Catalog
// is not installed at all. An installed Catalog that refuses is a refusal,
// never a fallback. These tests use the real Catalog reader (the exact Catalog
// tarball this checkout installs as a devDependency) over fixture copies of its
// published bytes.
// ---------------------------------------------------------------------------

const packaged = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../src/org-policy/workbench/core/packaged-source-data.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../src/org-policy/workbench/core/packaged-source-data.js")
    >();
  return {
    ...original,
    packagedEccRuntimeDescriptorsV1: () => {
      packaged.calls += 1;
      return original.packagedEccRuntimeDescriptorsV1();
    },
  };
});

const {
  ACCEPTED_CATALOG_ECC_RUNTIME_DESCRIPTORS_V1,
  HISTORICAL_ECC_RUNTIME_DESCRIPTOR_RESOLUTION_ORDER_V1,
  HistoricalEccRuntimeDescriptorRefusalError,
  resolveHistoricalEccRuntimeDescriptorV1,
} = await import("../../src/ecc/runtime-descriptor-resolver.js");
const { CatalogPackageRefusalError } = await import(
  "../../src/catalog-package/load-catalog-package.js"
);
const { packagedEccRuntimeDescriptorsV1 } = await import(
  "../../src/org-policy/workbench/core/packaged-source-data.js"
);

const ECC_COMMIT = "5064474d4d762dc9640234a41617cccb79185cec";
const PINNED_SHA256 = "158f63e265f1ca18a7e65c97e372b1259200d6fb60eab87d70c20600d9d9abf0";
const DESCRIPTOR_PATH = `defaults/runtime-descriptors/github.com/affaan-m/ECC/${ECC_COMMIT}/ecc-runtime-descriptor-v1.json`;
const SIDECAR_PATH = "defaults/catalog-runtime-descriptors-v1.json";
const INDEX_PATH = "defaults/catalog-index-v1.json";
const NOW = "2026-09-22T00:00:00.000Z";

const requireFromTest = createRequire(import.meta.url);
const installedRoot = dirname(requireFromTest.resolve("@aihq/catalog/package.json"));
const scratch: string[] = [];
afterAll(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  packaged.calls = 0;
});

function policyFor(commit = ECC_COMMIT) {
  return {
    governance: {
      externalSelections: [
        { framework: "ecc", items: [{ source: { repository: "affaan-m/ECC", commit } }] },
      ],
    },
  };
}

/** A copy of the installed Catalog's published bytes that a test may damage. */
function catalogFixture(): { root: string; access: CatalogPackageAccessV1 } {
  const root = mkdtempSync(join(tmpdir(), "aih-catalog-descriptor-fixture-"));
  scratch.push(root);
  for (const path of ["package.json", INDEX_PATH, SIDECAR_PATH, DESCRIPTOR_PATH]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(installedRoot, path), join(root, path));
  }
  const subpaths: Record<string, string> = {
    "@aihq/catalog/package.json": "package.json",
    "@aihq/catalog/catalog-index.json": INDEX_PATH,
    "@aihq/catalog/catalog-runtime-descriptors.json": SIDECAR_PATH,
  };
  return {
    root,
    access: {
      importPackage: () => import("@aihq/catalog"),
      resolve: (specifier) => {
        const relative = subpaths[specifier];
        if (relative === undefined)
          throw Object.assign(new Error(`not exported: ${specifier}`), {
            code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
          });
        return join(root, relative);
      },
      readFile: (path) => readFileSync(path),
    },
  };
}

function editSidecar(root: string, edit: (sidecar: Record<string, unknown>) => void): void {
  const path = join(root, SIDECAR_PATH);
  const sidecar = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  edit(sidecar);
  // The publisher's canonical form: sorted keys (preserved by in-place edits) plus a newline.
  writeFileSync(path, `${JSON.stringify(sidecar)}\n`);
}

/**
 * Flip one hex digit of the descriptor's compiler-input digest: still valid,
 * canonical JSON of the same length and identity, but not the pinned bytes.
 */
function mutateOneDescriptorByte(root: string): Buffer {
  const path = join(root, DESCRIPTOR_PATH);
  const bytes = readFileSync(path);
  const marker = Buffer.from('"compilerInputDigest":"sha256:');
  const at = bytes.indexOf(marker) + marker.length;
  expect(at).toBeGreaterThan(marker.length);
  bytes[at] = bytes[at] === "0".charCodeAt(0) ? "1".charCodeAt(0) : "0".charCodeAt(0);
  writeFileSync(path, bytes);
  return bytes;
}

const unavailable: CatalogPackageAccessV1 = {
  importPackage: () =>
    Promise.reject(
      Object.assign(
        new Error("Cannot find package '@aihq/catalog' imported from /consumer/node_modules"),
        { code: "ERR_MODULE_NOT_FOUND" },
      ),
    ),
  resolve: () => {
    throw new Error("unreachable");
  },
  readFile: () => {
    throw new Error("unreachable");
  },
};

function missingDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-no-workbench-data-"));
  scratch.push(root);
  return join(root, "absent");
}

async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

describe("historical ECC runtime descriptor resolution order", () => {
  it("states the order it follows", () => {
    expect(HISTORICAL_ECC_RUNTIME_DESCRIPTOR_RESOLUTION_ORDER_V1).toEqual([
      "local-source-data",
      "installed-catalog",
      "core-embedded",
    ]);
  });

  it("pins exactly the bytes Core embeds today, which are the bytes the Catalog tarball carries", () => {
    expect(ACCEPTED_CATALOG_ECC_RUNTIME_DESCRIPTORS_V1).toEqual([
      {
        framework: "ecc",
        format: "ecc-runtime-descriptor/v1",
        repository: "affaan-m/ECC",
        commit: ECC_COMMIT,
        sha256: PINNED_SHA256,
      },
    ]);
    const embedded = packagedEccRuntimeDescriptorsV1().find(
      (descriptor) => descriptor.source.commit === ECC_COMMIT,
    );
    if (embedded === undefined) throw new Error("the embedded ECC descriptor is required");
    expect(canonicalStrictJsonSha256V1(embedded)).toBe(PINNED_SHA256);
    const carried = readFileSync(join(installedRoot, DESCRIPTOR_PATH));
    expect(createHash("sha256").update(carried).digest("hex")).toBe(PINNED_SHA256);
  });

  it("resolves from the installed Catalog when its bytes match Core's pin, and records the source", async () => {
    const { access } = catalogFixture();
    const resolved = await resolveHistoricalEccRuntimeDescriptorV1(policyFor(), {
      now: NOW,
      dataRoot: missingDataRoot(),
      catalog: access,
    });
    expect(resolved.descriptorSource).toBe("installed-catalog");
    expect(resolved.descriptorResolution).toEqual([
      { stage: "local-source-data", outcome: "no-match" },
      { stage: "installed-catalog", outcome: "selected" },
    ]);
    expect(resolved.descriptorCarrier).toMatchObject({
      package: "@aihq/catalog",
      version: "0.2.0",
      runtimeDescriptorsFormat: "aih-catalog-runtime-descriptors",
      runtimeDescriptorsVersion: 1,
    });
    expect(resolved.descriptorSha256).toBe(`sha256:${PINNED_SHA256}`);
    expect(resolved.source).toMatchObject({ repository: "affaan-m/ECC", commit: ECC_COMMIT });
    // The embedded copy was never consulted.
    expect(packaged.calls).toBe(0);
  });

  it("resolves the same context from the embedded copy only when Catalog is not installed", async () => {
    const dataRoot = missingDataRoot();
    const fromCatalog = await resolveHistoricalEccRuntimeDescriptorV1(policyFor(), {
      now: NOW,
      dataRoot,
      catalog: catalogFixture().access,
    });
    const embedded = await resolveHistoricalEccRuntimeDescriptorV1(policyFor(), {
      now: NOW,
      dataRoot,
      catalog: unavailable,
    });
    expect(embedded.descriptorSource).toBe("core-embedded");
    expect(embedded.descriptorResolution).toEqual([
      { stage: "local-source-data", outcome: "no-match" },
      { stage: "installed-catalog", outcome: "catalog-package-unavailable" },
      { stage: "core-embedded", outcome: "selected" },
    ]);
    expect(embedded.descriptorCarrier).toBeUndefined();
    expect(packaged.calls).toBe(1);
    // Same bytes, same digest, same derived context: the carrier changed, nothing else.
    expect(embedded.descriptorSha256).toBe(fromCatalog.descriptorSha256);
    expect(embedded.evidence.rawReportDigest).toBe(fromCatalog.evidence.rawReportDigest);
    expect([...embedded.componentPathsById]).toEqual([...fromCatalog.componentPathsById]);
  });

  it("refuses when one descriptor byte differs from what the Catalog sidecar declares", async () => {
    const { root, access } = catalogFixture();
    mutateOneDescriptorByte(root);
    const error = await refusalOf(
      resolveHistoricalEccRuntimeDescriptorV1(policyFor(), {
        now: NOW,
        dataRoot: missingDataRoot(),
        catalog: access,
      }),
    );
    expect(error).toBeInstanceOf(HistoricalEccRuntimeDescriptorRefusalError);
    expect(
      (error as InstanceType<typeof HistoricalEccRuntimeDescriptorRefusalError>).refusal,
    ).toMatchObject({
      reason: "catalog-descriptor-unverified",
      catalogReason: "descriptor-digest-mismatch",
    });
    expect(packaged.calls).toBe(0);
  });

  it("refuses bytes the Catalog vouches for when Core has not pinned their digest", async () => {
    const { root, access } = catalogFixture();
    const mutated = mutateOneDescriptorByte(root);
    const digest = createHash("sha256").update(mutated).digest("hex");
    editSidecar(root, (sidecar) => {
      const [entry] = sidecar.descriptors as Array<{ descriptor: { sha256: string } }>;
      if (entry === undefined) throw new Error("sidecar entry is required");
      entry.descriptor.sha256 = digest;
    });
    const error = await refusalOf(
      resolveHistoricalEccRuntimeDescriptorV1(policyFor(), {
        now: NOW,
        dataRoot: missingDataRoot(),
        catalog: access,
      }),
    );
    expect(error).toBeInstanceOf(HistoricalEccRuntimeDescriptorRefusalError);
    const refusal = (error as InstanceType<typeof HistoricalEccRuntimeDescriptorRefusalError>)
      .refusal;
    expect(refusal.reason).toBe("catalog-descriptor-not-accepted");
    expect(refusal.detail).toContain(digest);
    expect(refusal.detail).toContain(PINNED_SHA256);
    expect((error as Error).message).toMatch(/^catalog-descriptor-not-accepted: /u);
    expect(packaged.calls).toBe(0);
  });

  it("refuses an unknown runtime-descriptors sidecar version and names what it declared", async () => {
    const { root, access } = catalogFixture();
    editSidecar(root, (sidecar) => {
      sidecar.version = 2;
    });
    const error = await refusalOf(
      resolveHistoricalEccRuntimeDescriptorV1(policyFor(), {
        now: NOW,
        dataRoot: missingDataRoot(),
        catalog: access,
      }),
    );
    expect(error).toBeInstanceOf(HistoricalEccRuntimeDescriptorRefusalError);
    expect(
      (error as InstanceType<typeof HistoricalEccRuntimeDescriptorRefusalError>).refusal,
    ).toMatchObject({
      reason: "catalog-runtime-descriptors-refused",
      catalogReason: "unknown-version",
      observed: "2",
    });
    expect(packaged.calls).toBe(0);
  });

  it("refuses when the Catalog reader refuses the sidecar or the index it is bound to", async () => {
    const sidecarFixture = catalogFixture();
    editSidecar(sidecarFixture.root, (sidecar) => {
      (sidecar.index as { sha256: string }).sha256 = "0".repeat(64);
    });
    const sidecarError = await refusalOf(
      resolveHistoricalEccRuntimeDescriptorV1(policyFor(), {
        now: NOW,
        dataRoot: missingDataRoot(),
        catalog: sidecarFixture.access,
      }),
    );
    expect(
      (sidecarError as InstanceType<typeof HistoricalEccRuntimeDescriptorRefusalError>).refusal,
    ).toMatchObject({
      reason: "catalog-runtime-descriptors-refused",
      catalogReason: "index-mismatch",
    });

    const indexFixture = catalogFixture();
    writeFileSync(join(indexFixture.root, INDEX_PATH), "{}\n");
    const indexError = await refusalOf(
      resolveHistoricalEccRuntimeDescriptorV1(policyFor(), {
        now: NOW,
        dataRoot: missingDataRoot(),
        catalog: indexFixture.access,
      }),
    );
    expect(indexError).toBeInstanceOf(HistoricalEccRuntimeDescriptorRefusalError);
    expect(
      (indexError as InstanceType<typeof HistoricalEccRuntimeDescriptorRefusalError>).refusal
        .reason,
    ).toBe("catalog-index-refused");
    expect(packaged.calls).toBe(0);
  });

  it("refuses a source revision the installed Catalog does not carry instead of substituting", async () => {
    const error = await refusalOf(
      resolveHistoricalEccRuntimeDescriptorV1(policyFor("b".repeat(40)), {
        now: NOW,
        dataRoot: missingDataRoot(),
        catalog: catalogFixture().access,
      }),
    );
    expect(error).toBeInstanceOf(HistoricalEccRuntimeDescriptorRefusalError);
    expect(
      (error as InstanceType<typeof HistoricalEccRuntimeDescriptorRefusalError>).refusal.reason,
    ).toBe("catalog-descriptor-absent");
    expect(packaged.calls).toBe(0);
  });

  it("refuses an installed but incompatible Catalog; it never falls back to the embedded copy", async () => {
    const { access } = catalogFixture();
    for (const importPackage of [
      () => Promise.resolve({ readCatalogContentV1Result: () => ({}) }),
      () => Promise.reject(new SyntaxError("broken install")),
    ]) {
      const error = await refusalOf(
        resolveHistoricalEccRuntimeDescriptorV1(policyFor(), {
          now: NOW,
          dataRoot: missingDataRoot(),
          catalog: { ...access, importPackage },
        }),
      );
      expect(error).toBeInstanceOf(CatalogPackageRefusalError);
      expect((error as InstanceType<typeof CatalogPackageRefusalError>).refusal.reason).toBe(
        "catalog-package-incompatible",
      );
    }
    // The registry's 0.2.0 publishes no runtime-descriptors subpath.
    const withoutSubpath = await refusalOf(
      resolveHistoricalEccRuntimeDescriptorV1(policyFor(), {
        now: NOW,
        dataRoot: missingDataRoot(),
        catalog: {
          ...access,
          resolve: (specifier) => {
            if (specifier.endsWith("catalog-runtime-descriptors.json"))
              throw Object.assign(new Error("not exported"), {
                code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
              });
            return access.resolve(specifier);
          },
        },
      }),
    );
    expect(
      (withoutSubpath as InstanceType<typeof CatalogPackageRefusalError>).refusal.detail,
    ).toContain("does not export ./catalog-runtime-descriptors.json");
    expect(packaged.calls).toBe(0);
  });
});
