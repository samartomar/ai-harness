import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatedConfigSchemas } from "../../src/config/json-schema.js";
import * as library from "../../src/index.js";

const root = process.cwd();

describe("Capability Package Manager HOLD boundary", () => {
  it("does not expose the unreleased native package-manager library surface", () => {
    for (const name of [
      "CapabilityPackageManifestSchema",
      "resolveCapabilityPackages",
      "readCapabilityPackageIntent",
      "readCapabilityPackageOwnershipReceipt",
      "resolveSkillPackAuthorityBindings",
      "planCapabilityPackageLifecycle",
    ]) {
      expect(name in library).toBe(false);
    }
  });

  it("does not generate or ship the unreleased package manifest schema", () => {
    expect(generatedConfigSchemas().map(({ path }) => path)).not.toContain(
      "schemas/aih-capability-package-manifest.schema.json",
    );
    expect(existsSync(join(root, "schemas/aih-capability-package-manifest.schema.json"))).toBe(
      false,
    );
  });
});
