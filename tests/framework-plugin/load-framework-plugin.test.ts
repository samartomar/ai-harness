import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogFrameworkPluginIdentitiesLoadV1 } from "../../src/catalog-package/framework-plugins.js";
import { FRAMEWORK_HOST_API_VERSION } from "../../src/framework-host/index.js";
import type { FrameworkIdV1 } from "../../src/framework-plugin/contract-v1.js";
import {
  type FrameworkPluginAccessV1,
  FrameworkPluginRefusalError,
  frameworkPluginRefusalMessage,
  loadFrameworkPluginV1,
} from "../../src/framework-plugin/load-framework-plugin.js";

const COMMIT = "b36e0829c6d0140e93cfef2ca599b1b07d4a7797";

let install: string;
let manifestPath: string;

beforeEach(() => {
  install = mkdtempSync(join(tmpdir(), "aih-framework-plugin-"));
  manifestPath = join(install, "node_modules", "@aihq", "framework-superpowers", "package.json");
});

afterEach(() => {
  rmSync(install, { recursive: true, force: true });
});

function pluginExport(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    hostApiVersion: FRAMEWORK_HOST_API_VERSION,
    frameworkId: "superpowers",
    packageName: "@aihq/framework-superpowers",
    packageVersion: "0.1.0",
    describe: () => ({
      frameworkId: "superpowers",
      displayName: "Superpowers",
      upstream: { repository: "obra/Superpowers", commit: COMMIT },
      supportedHosts: ["claude", "kiro"],
      catalogSubpath: "./catalog-framework-superpowers.json",
      descriptorSections: ["vendorLock", "hookControlInventory"],
      environment: ["AIH_SUPERPOWERS_REF"],
      ownedArtifacts: [{ host: "kiro", path: ".kiro/steering/superpowers-methodology.md" }],
    }),
    identifyComponents: () => ({}),
    hookInventory: () => ({}),
    planHookControls: () => ({}),
    commands: { superpowers: { execute: async () => ({}) } },
    ...over,
  };
}

const CATALOG_ABSENT: CatalogFrameworkPluginIdentitiesLoadV1 = {
  ok: false,
  refusal: { reason: "catalog-package-unavailable", detail: "@aihq/catalog is not installed" },
};

function catalogRecord(over: Record<string, unknown> = {}): CatalogFrameworkPluginIdentitiesLoadV1 {
  return {
    ok: true,
    catalogVersion: "0.3.0",
    sha256: "a".repeat(64),
    entries: [
      {
        frameworkId: "superpowers",
        packageName: "@aihq/framework-superpowers",
        version: "0.1.0",
        contractVersion: 1,
        upstream: { repository: "obra/Superpowers", commit: COMMIT },
        supportedCore: ">=0.7.0 <0.8.0",
        supportedHosts: ["claude"],
        status: "candidate",
        ...over,
      } as never,
    ],
  };
}

interface FakeInstall {
  manifest?: unknown;
  namespace?: unknown;
  importError?: Error;
  importDelayMs?: number;
  resolveError?: Error;
  allowedRoots?: readonly string[];
  catalog?: CatalogFrameworkPluginIdentitiesLoadV1;
}

function access(fake: FakeInstall = {}): FrameworkPluginAccessV1 & { imports: FrameworkIdV1[] } {
  const imports: FrameworkIdV1[] = [];
  return {
    imports,
    importPlugin: async (frameworkId) => {
      imports.push(frameworkId);
      if (fake.importDelayMs !== undefined) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, fake.importDelayMs));
      }
      if (fake.importError !== undefined) throw fake.importError;
      return fake.namespace ?? { aihFrameworkPluginV1: pluginExport() };
    },
    resolvePackageJson: () => {
      if (fake.resolveError !== undefined) throw fake.resolveError;
      return manifestPath;
    },
    readFile: () =>
      new TextEncoder().encode(
        JSON.stringify(fake.manifest ?? { name: "@aihq/framework-superpowers", version: "0.1.0" }),
      ),
    realpath: (path) => path,
    allowedRoots: () => fake.allowedRoots ?? [join(install, "node_modules")],
    loadCatalogIdentities: async () => fake.catalog ?? CATALOG_ABSENT,
  };
}

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

async function refusalOf(fake: FakeInstall, timeoutMs?: number) {
  const loaded = await loadFrameworkPluginV1("superpowers", {
    access: access(fake),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (loaded.ok) throw new Error("expected a refusal");
  return loaded.refusal;
}

describe("loadFrameworkPluginV1 — success", () => {
  it("loads a contract-1 plugin and records that Catalog is not installed", async () => {
    const fake = access();
    const loaded = await loadFrameworkPluginV1("superpowers", { access: fake });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.packageName).toBe("@aihq/framework-superpowers");
    expect(loaded.version).toBe("0.1.0");
    expect(loaded.description.upstream.commit).toBe(COMMIT);
    expect(loaded.catalogIdentity).toEqual({ state: "catalog-not-installed" });
    expect(fake.imports).toEqual(["superpowers"]);
  });

  it("confirms the installed version against Catalog's identity record", async () => {
    const loaded = await loadFrameworkPluginV1("superpowers", {
      access: access({ catalog: catalogRecord() }),
    });
    expect(loaded.ok && loaded.catalogIdentity).toEqual({
      state: "matched",
      catalogVersion: "0.3.0",
      sha256: "a".repeat(64),
    });
  });
});

describe("loadFrameworkPluginV1 — framework-plugin-unavailable", () => {
  it("refuses by name with the install command when the package is not installed", async () => {
    const refusal = await refusalOf({
      resolveError: withCode(
        "Cannot find module '@aihq/framework-superpowers/package.json'",
        "MODULE_NOT_FOUND",
      ),
    });
    expect(refusal.reason).toBe("framework-plugin-unavailable");
    expect(refusal.packageName).toBe("@aihq/framework-superpowers");
    expect(refusal.detail).toContain("npm install -g @aihq/core @aihq/framework-superpowers");
    expect(refusal.detail).toContain("npm install @aihq/core @aihq/framework-superpowers");
  });

  it("reports the real installed state: this checkout has no plugin package installed", async () => {
    const loaded = await loadFrameworkPluginV1("superpowers");
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.reason).toBe("framework-plugin-unavailable");
  });
});

describe("loadFrameworkPluginV1 — framework-plugin-incompatible", () => {
  it("refuses a package without the aihFrameworkPluginV1 export", async () => {
    const refusal = await refusalOf({ namespace: { somethingElse: true } });
    expect(refusal.reason).toBe("framework-plugin-incompatible");
    expect(refusal.detail).toContain("does not export aihFrameworkPluginV1");
  });

  it("refuses another contract version", async () => {
    const refusal = await refusalOf({
      namespace: { aihFrameworkPluginV1: pluginExport({ contractVersion: 2 }) },
    });
    expect(refusal.reason).toBe("framework-plugin-incompatible");
    expect(refusal.detail).toContain("declares contract version 2");
  });

  it("refuses a plugin built against another host API version", async () => {
    const refusal = await refusalOf({
      namespace: { aihFrameworkPluginV1: pluginExport({ hostApiVersion: 99 }) },
    });
    expect(refusal.detail).toContain("framework host API 99");
  });

  it("refuses an export that names another package", async () => {
    const refusal = await refusalOf({
      namespace: { aihFrameworkPluginV1: pluginExport({ packageName: "@evil/plugin" }) },
    });
    expect(refusal.reason).toBe("framework-plugin-incompatible");
    expect(refusal.detail).toContain('declares package name "@evil/plugin"');
  });

  it("refuses an installed package.json that names another package", async () => {
    const refusal = await refusalOf({ manifest: { name: "@evil/plugin", version: "0.1.0" } });
    expect(refusal.detail).toContain('package.json names "@evil/plugin"');
  });

  it("refuses an export whose version differs from its own package.json", async () => {
    const refusal = await refusalOf({
      namespace: { aihFrameworkPluginV1: pluginExport({ packageVersion: "0.1.1" }) },
    });
    expect(refusal.detail).toContain('declares version "0.1.1" but its package.json is 0.1.0');
  });

  it("refuses an installed version that does not equal Catalog's identity record", async () => {
    const refusal = await refusalOf({ catalog: catalogRecord({ version: "0.1.9" }) });
    expect(refusal.reason).toBe("framework-plugin-incompatible");
    expect(refusal.detail).toContain(
      "0.1.0 does not equal @aihq/catalog 0.3.0's identity record @aihq/framework-superpowers 0.1.9",
    );
  });

  it("refuses when Catalog records another upstream than the plugin supports", async () => {
    const refusal = await refusalOf({
      catalog: catalogRecord({
        upstream: { repository: "obra/Superpowers", commit: "c".repeat(40) },
      }),
    });
    expect(refusal.detail).toContain(`supports obra/Superpowers@${COMMIT}`);
    expect(refusal.detail).toContain(`records obra/Superpowers@${"c".repeat(40)}`);
  });

  it("refuses when an installed Catalog has no record for the framework", async () => {
    const catalog = catalogRecord();
    const refusal = await refusalOf({
      catalog: catalog.ok ? { ...catalog, entries: [] } : catalog,
    });
    expect(refusal.detail).toContain("has no identity record in @aihq/catalog 0.3.0");
  });

  it("never treats an incompatible Catalog as absent", async () => {
    const refusal = await refusalOf({
      catalog: {
        ok: false,
        refusal: {
          reason: "catalog-package-incompatible",
          detail: "the installed @aihq/catalog does not export ./catalog-framework-plugins.json",
        },
      },
    });
    expect(refusal.reason).toBe("framework-plugin-incompatible");
    expect(refusal.detail).toContain("catalog-package-incompatible");
  });

  it("refuses a package whose import throws, naming the failure", async () => {
    const refusal = await refusalOf({ importError: new Error("boom in module body") });
    expect(refusal.reason).toBe("framework-plugin-incompatible");
    expect(refusal.detail).toContain("could not be loaded (boom in module body)");
  });

  it("treats a missing transitive module as broken, not absent", async () => {
    const refusal = await refusalOf({
      importError: withCode(
        "Cannot find module 'left-pad' imported from x",
        "ERR_MODULE_NOT_FOUND",
      ),
    });
    expect(refusal.reason).toBe("framework-plugin-incompatible");
  });

  it("refuses a package that does not finish loading within the budget", async () => {
    const refusal = await refusalOf({ importDelayMs: 200 }, 20);
    expect(refusal.reason).toBe("framework-plugin-incompatible");
    expect(refusal.detail).toContain("did not finish loading within 20ms");
  });

  it("refuses a package resolved outside Core's own install tree", async () => {
    const refusal = await refusalOf({ allowedRoots: [join(install, "elsewhere")] });
    expect(refusal.reason).toBe("framework-plugin-incompatible");
    expect(refusal.detail).toContain("resolves outside @aihq/core's own install tree");
  });

  it("refuses a package that does not export ./package.json", async () => {
    const refusal = await refusalOf({
      resolveError: withCode(
        "Package subpath './package.json' is not defined",
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
      ),
    });
    expect(refusal.detail).toContain("does not export ./package.json");
  });

  it("refuses a plugin that does not implement a command Core dispatches to", async () => {
    const refusal = await refusalOf({
      namespace: { aihFrameworkPluginV1: pluginExport({ commands: {} }) },
    });
    expect(refusal.detail).toContain('does not implement the "superpowers" command');
  });

  it("refuses a malformed describe() result", async () => {
    const refusal = await refusalOf({
      namespace: {
        aihFrameworkPluginV1: pluginExport({
          describe: () => ({
            ...(pluginExport().describe as () => object)(),
            environment: ["lower"],
          }),
        }),
      },
    });
    expect(refusal.detail).toContain("malformed describe() result at environment.0");
  });

  it("refuses a describe() that names another Catalog subpath", async () => {
    const refusal = await refusalOf({
      namespace: {
        aihFrameworkPluginV1: pluginExport({
          describe: () => ({
            ...(pluginExport().describe as () => object)(),
            catalogSubpath: "./catalog-index.json",
          }),
        }),
      },
    });
    expect(refusal.detail).toContain('names Catalog subpath "./catalog-index.json"');
  });

  it("keeps control characters from a hostile plugin out of the refusal", async () => {
    const refusal = await refusalOf({ importError: new Error("bad\u001b[31m\nred") });
    const controls = [...refusal.detail].filter((character) => character.charCodeAt(0) < 0x20);
    expect(controls).toEqual([]);
  });
});

describe("FrameworkPluginRefusalError", () => {
  it("carries the refusal under the AIH_FRAMEWORK_PLUGIN code", async () => {
    const refusal = await refusalOf({
      resolveError: withCode(
        "Cannot find module '@aihq/framework-superpowers/package.json'",
        "MODULE_NOT_FOUND",
      ),
    });
    const error = new FrameworkPluginRefusalError(refusal);
    expect(error.code).toBe("AIH_FRAMEWORK_PLUGIN");
    expect(error.message).toBe(frameworkPluginRefusalMessage(refusal));
    expect(error.message.startsWith("framework-plugin-unavailable: ")).toBe(true);
  });
});
