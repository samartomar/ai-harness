import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CapabilityPackageManifestSchema, resolveCapabilityPackages } from "../../src/index.js";

const root = process.cwd();

describe("Capability Package Manager public package surface", () => {
  it("exports the strict manifest and pure resolver from the library root", () => {
    expect(CapabilityPackageManifestSchema.safeParse).toEqual(expect.any(Function));
    expect(resolveCapabilityPackages).toEqual(expect.any(Function));
  });

  it("ships and exports the committed Capability Package Manifest JSON Schema", () => {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm_execpath is required for the cross-platform pack test");
    const output = execFileSync(
      process.execPath,
      [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const packed = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    expect(packed[0]?.files.map((file) => file.path)).toContain(
      "schemas/aih-capability-package-manifest.schema.json",
    );

    const resolved = import.meta.resolve(
      "@aihq/harness/schemas/aih-capability-package-manifest.schema.json",
    );
    expect(fileURLToPath(resolved)).toBe(
      join(root, "schemas/aih-capability-package-manifest.schema.json"),
    );

    const schema = JSON.parse(readFileSync(fileURLToPath(resolved), "utf8"));
    expect(schema).toMatchObject({ title: "aih-capability-package-manifest.schema.json" });
  });
});
