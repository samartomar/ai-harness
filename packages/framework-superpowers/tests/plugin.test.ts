import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FRAMEWORK_HOST_API_VERSION,
  FRAMEWORK_PLUGIN_CONTRACT_VERSION,
} from "@aihq/core/framework-host";
import { describe, expect, it } from "vitest";
// Core's own loader, from this repository's source: the export must pass exactly
// the checks an installed Core applies.
import { loadFrameworkPluginV1 } from "../../../src/framework-plugin/load-framework-plugin.js";
import { aihFrameworkPluginV1 } from "../src/index.js";

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  name: string;
  version: string;
  peerDependencies: Record<string, string>;
};

describe("aihFrameworkPluginV1", () => {
  it("names its own package and version", () => {
    expect(aihFrameworkPluginV1.packageName).toBe(manifest.name);
    expect(aihFrameworkPluginV1.packageVersion).toBe(manifest.version);
    expect(aihFrameworkPluginV1.frameworkId).toBe("superpowers");
  });

  it("declares the contract and host API versions it was built against", () => {
    expect(aihFrameworkPluginV1.contractVersion).toBe(FRAMEWORK_PLUGIN_CONTRACT_VERSION);
    expect(aihFrameworkPluginV1.hostApiVersion).toBe(FRAMEWORK_HOST_API_VERSION);
  });

  it("peers on the Core minor it was built for", () => {
    expect(manifest.peerDependencies).toEqual({ "@aihq/core": ">=0.7.0 <0.8.0" });
  });

  it("passes Core's framework plugin loader", async () => {
    const root = realpathSync(dirname(manifestPath));
    const loaded = await loadFrameworkPluginV1("superpowers", {
      access: {
        importPlugin: async () => ({ aihFrameworkPluginV1 }),
        resolvePackageJson: () => manifestPath,
        readFile: (path) => readFileSync(path),
        realpath: (path) => realpathSync(path),
        allowedRoots: () => [dirname(root)],
        loadCatalogIdentities: async () => ({
          ok: false,
          refusal: { reason: "catalog-package-unavailable", detail: "not installed" },
        }),
      },
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.description).toEqual(aihFrameworkPluginV1.describe());
  });

  it("describes its upstream, Catalog subpath, environment and owned artifact", () => {
    const description = aihFrameworkPluginV1.describe();
    expect(description.upstream).toEqual({
      repository: "obra/Superpowers",
      commit: "b36e0829c6d0140e93cfef2ca599b1b07d4a7797",
    });
    expect(description.catalogSubpath).toBe("./catalog-framework-superpowers.json");
    expect(description.descriptorSections).toEqual(["vendorLock", "hookControlInventory"]);
    expect(description.environment).toEqual(["AIH_SUPERPOWERS_REF"]);
    expect(description.ownedArtifacts).toEqual([
      { host: "kiro", path: ".kiro/steering/superpowers-methodology.md" },
    ]);
  });

  it("is frozen so a caller cannot rewire it", () => {
    expect(Object.isFrozen(aihFrameworkPluginV1)).toBe(true);
    expect(Object.isFrozen(aihFrameworkPluginV1.commands)).toBe(true);
  });
});
