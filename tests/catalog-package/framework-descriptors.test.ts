import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { readVendorBaselineLock } from "../../src/baseline-evidence/vendor.js";
import {
  FRAMEWORK_DESCRIPTOR_FORMAT_V1,
  loadFrameworkDescriptorBytesV1,
} from "../../src/catalog-package/framework-descriptors.js";

// Phase-1 stub over Core's embedded data, with the C1 signature W1 implements
// against the installed Catalog.

const MODULE_URL = new URL("../../src/catalog-package/framework-descriptors.ts", import.meta.url);

/** Whether the Catalog Core would load publishes the Superpowers descriptor subpath. */
function installedCatalogPublishesSuperpowersDescriptor(): boolean {
  try {
    createRequire(MODULE_URL).resolve("@aihq/catalog/catalog-framework-superpowers.json");
    return true;
  } catch {
    return false;
  }
}

describe("the phase-1 descriptor stub guard", () => {
  it("fails once the installed Catalog publishes the descriptor while the stub is still wired", () => {
    const source = readFileSync(MODULE_URL, "utf8");
    if (installedCatalogPublishesSuperpowersDescriptor()) {
      expect(
        source,
        "replace the phase-1 stub with W1's Catalog-backed loadFrameworkDescriptorBytesV1",
      ).not.toContain("PHASE-1 STUB");
    } else {
      expect(source).toContain("PHASE-1 STUB");
    }
  });
});

describe("loadFrameworkDescriptorBytesV1 (phase-1 stub)", () => {
  it("serves canonical Superpowers descriptor bytes with their digest", async () => {
    const loaded = await loadFrameworkDescriptorBytesV1("superpowers");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.frameworkId).toBe("superpowers");
    expect(loaded.sha256).toBe(createHash("sha256").update(loaded.bytes).digest("hex"));
    const text = new TextDecoder().decode(loaded.bytes);
    expect(text.endsWith("}\n")).toBe(true);
    const parsed = JSON.parse(text) as {
      format: string;
      version: number;
      frameworkId: string;
      sections: Record<string, { pinnedSha?: string; hooks?: unknown[] }>;
    };
    expect(Object.keys(parsed)).toEqual(["format", "frameworkId", "sections", "version"]);
    expect(parsed.format).toBe(FRAMEWORK_DESCRIPTOR_FORMAT_V1);
    expect(parsed.version).toBe(1);
    expect(parsed.frameworkId).toBe("superpowers");
    const vendor = readVendorBaselineLock().sources.find((source) => source.id === "superpowers");
    expect(parsed.sections.vendorLock).toEqual(vendor);
    expect(parsed.sections.hookControlInventory?.hooks).toHaveLength(1);
  });

  it("serves exactly the bytes the Superpowers plugin's own tests pin", async () => {
    const loaded = await loadFrameworkDescriptorBytesV1("superpowers");
    const pinned = readFileSync(
      new URL(
        "../../packages/framework-superpowers/tests/fixtures/catalog-framework-superpowers.json",
        import.meta.url,
      ),
    );
    expect(loaded.ok && Buffer.from(loaded.bytes).equals(pinned)).toBe(true);
  });

  it("serves identical bytes on every call", async () => {
    const first = await loadFrameworkDescriptorBytesV1("superpowers");
    const second = await loadFrameworkDescriptorBytesV1("superpowers");
    expect(first.ok && second.ok && first.sha256 === second.sha256).toBe(true);
  });

  it("refuses a framework the stub does not carry instead of inventing data", async () => {
    const loaded = await loadFrameworkDescriptorBytesV1("ecc");
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.reason).toBe("catalog-package-incompatible");
    expect(loaded.refusal.detail).toContain("./catalog-framework-ecc.json");
  });
});
