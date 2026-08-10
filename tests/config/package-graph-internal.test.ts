import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PackageGraphSchema } from "../../src/capability/package-graph/schema.js";
import { generatedConfigSchemas } from "../../src/config/json-schema.js";
import * as library from "../../src/index.js";

const root = process.cwd();

describe("Package Graph internal boundary", () => {
  it("retains the read-only parser without publishing a package-management surface", () => {
    expect(PackageGraphSchema.safeParse).toEqual(expect.any(Function));
    expect("PackageGraphSchema" in library).toBe(false);
    expect("buildPackageGraphIndex" in library).toBe(false);
  });

  it("does not generate or ship a public Package Graph schema", () => {
    expect(generatedConfigSchemas().map(({ path }) => path)).not.toContain(
      "schemas/aih-package-graph.schema.json",
    );
    expect(existsSync(join(root, "schemas/aih-package-graph.schema.json"))).toBe(false);
  });
});
