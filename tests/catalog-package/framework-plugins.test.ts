import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CATALOG_FRAMEWORK_PLUGINS_SUBPATH_V1,
  loadFrameworkPluginIdentitiesV1,
  MAX_CATALOG_FRAMEWORK_PLUGINS_BYTES_V1,
  parseFrameworkPluginIdentitiesV1,
} from "../../src/catalog-package/framework-plugins.js";
import type { CatalogPackageAccessV1 } from "../../src/catalog-package/load-catalog-package.js";

// The C1 plugin identity document, in the shape the Catalog generator emits:
// `{ format, version, entries }`, eight keys per entry.
function entry(frameworkId: "ecc" | "superpowers", over: Record<string, unknown> = {}) {
  return {
    frameworkId,
    packageName: frameworkId === "ecc" ? "@aihq/framework-ecc" : "@aihq/framework-superpowers",
    version: "0.1.0",
    contractVersion: 1,
    upstream:
      frameworkId === "ecc"
        ? { repository: "affaan-m/ECC", commit: "5064474d4d762dc9640234a41617cccb79185cec" }
        : { repository: "obra/Superpowers", commit: "b36e0829c6d0140e93cfef2ca599b1b07d4a7797" },
    supportedCore: ">=0.7.0 <0.8.0",
    supportedHosts: ["claude", "codex"],
    status: "candidate",
    ...over,
  };
}

function document(entries: unknown[] = [entry("ecc"), entry("superpowers")], over = {}) {
  return { format: "aih-catalog-framework-plugins", version: 1, entries, ...over };
}

const bytes = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);

describe("parseFrameworkPluginIdentitiesV1 (Core-owned schema)", () => {
  it("accepts the Catalog identity document", () => {
    const parsed = parseFrameworkPluginIdentitiesV1(bytes(document()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.map((item) => item.packageName)).toEqual([
      "@aihq/framework-ecc",
      "@aihq/framework-superpowers",
    ]);
  });

  it.each([
    ["an unknown format", document(undefined, { format: "aih-catalog-index" })],
    ["another version", document(undefined, { version: 2 })],
    ["an extra top-level key", document(undefined, { extra: true })],
    ["an extra entry key", document([entry("superpowers", { extra: 1 })])],
    [
      "a package name that does not match its framework",
      document([entry("superpowers", { packageName: "@aihq/framework-ecc" })]),
    ],
    [
      "a short commit",
      document([
        entry("superpowers", { upstream: { repository: "obra/Superpowers", commit: "b36e0829" } }),
      ]),
    ],
    ["an unknown host", document([entry("superpowers", { supportedHosts: ["notepad"] })])],
    ["a duplicate framework", document([entry("superpowers"), entry("superpowers")])],
    ["a range where a version belongs", document([entry("superpowers", { version: "^0.1.0" })])],
  ])("refuses %s", (_label, value) => {
    expect(parseFrameworkPluginIdentitiesV1(bytes(value)).ok).toBe(false);
  });

  it("refuses duplicate JSON keys instead of keeping the last one", () => {
    const text = '{"format":"aih-catalog-framework-plugins","version":1,"version":1,"entries":[]}';
    const parsed = parseFrameworkPluginIdentitiesV1(new TextEncoder().encode(text));
    expect(parsed).toEqual({
      ok: false,
      detail: expect.stringContaining("duplicate JSON object key"),
    });
  });

  it("refuses oversize bytes before parsing", () => {
    const parsed = parseFrameworkPluginIdentitiesV1(
      new Uint8Array(MAX_CATALOG_FRAMEWORK_PLUGINS_BYTES_V1 + 1),
    );
    expect(parsed).toEqual({ ok: false, detail: expect.stringContaining("exceeds") });
  });
});

function catalogAccess(file: Uint8Array | undefined): CatalogPackageAccessV1 {
  return {
    importPackage: async () => ({}),
    resolve: (specifier) => {
      if (specifier === "@aihq/catalog/package.json") return "/catalog/package.json";
      if (specifier === `@aihq/catalog/${CATALOG_FRAMEWORK_PLUGINS_SUBPATH_V1.slice(2)}`) {
        if (file === undefined) {
          throw Object.assign(new Error("not exported"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
        }
        return "/catalog/defaults/catalog-framework-plugins-v1.json";
      }
      throw new Error(`unexpected ${specifier}`);
    },
    readFile: (path) =>
      path.endsWith("package.json")
        ? new TextEncoder().encode(JSON.stringify({ name: "@aihq/catalog", version: "0.3.0" }))
        : (file ?? new Uint8Array()),
  };
}

describe("loadFrameworkPluginIdentitiesV1", () => {
  it("reads the installed Catalog's identities with their digest and Catalog version", async () => {
    const file = bytes(document());
    const loaded = await loadFrameworkPluginIdentitiesV1(catalogAccess(file));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.catalogVersion).toBe("0.3.0");
    expect(loaded.sha256).toBe(createHash("sha256").update(file).digest("hex"));
  });

  it("is catalog-package-unavailable only when Catalog is not installed", async () => {
    const loaded = await loadFrameworkPluginIdentitiesV1({
      ...catalogAccess(undefined),
      importPackage: async () => {
        throw Object.assign(new Error("Cannot find package '@aihq/catalog' imported from x"), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
    });
    expect(!loaded.ok && loaded.refusal.reason).toBe("catalog-package-unavailable");
  });

  it("is catalog-package-incompatible for a Catalog without the subpath", async () => {
    const loaded = await loadFrameworkPluginIdentitiesV1(catalogAccess(undefined));
    expect(!loaded.ok && loaded.refusal.reason).toBe("catalog-package-incompatible");
  });

  it("is catalog-package-incompatible for bytes that fail Core's schema", async () => {
    const loaded = await loadFrameworkPluginIdentitiesV1(catalogAccess(bytes({ format: "x" })));
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.reason).toBe("catalog-package-incompatible");
    expect(loaded.refusal.detail).toContain("./catalog-framework-plugins.json is invalid");
  });

  it("finds the currently installed Catalog 0.2.0 incompatible: it publishes no plugin identities", async () => {
    const loaded = await loadFrameworkPluginIdentitiesV1();
    expect(!loaded.ok && loaded.refusal.reason).toBe("catalog-package-incompatible");
  });
});
