import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adaptSkillPackageGraph,
  classifyPackageGraphResidue,
  normalizeGitHubRepository,
  projectBaselinePackageGraphAuthority,
  projectEccCapabilityPackageAuthority,
  projectEccMaterializationAuthority,
  projectEccMcpCapabilityPackageAuthority,
  projectEccMcpReceiptAuthority,
} from "../../src/index.js";

const root = process.cwd();

describe("Package Graph public package surface", () => {
  it("exports every Package Graph authority adapter from the library root", () => {
    expect([
      projectBaselinePackageGraphAuthority,
      projectEccCapabilityPackageAuthority,
      projectEccMaterializationAuthority,
      projectEccMcpCapabilityPackageAuthority,
      projectEccMcpReceiptAuthority,
      normalizeGitHubRepository,
      adaptSkillPackageGraph,
      classifyPackageGraphResidue,
    ]).toEqual([
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    ]);
  });

  it("ships and exports the committed Package Graph JSON Schema", () => {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm_execpath is required for the cross-platform pack test");
    const output = execFileSync(
      process.execPath,
      [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const packed = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    expect(packed[0]?.files.map((file) => file.path)).toContain(
      "schemas/aih-package-graph.schema.json",
    );

    const resolved = import.meta.resolve("@aihq/harness/schemas/aih-package-graph.schema.json");
    expect(fileURLToPath(resolved)).toBe(join(root, "schemas/aih-package-graph.schema.json"));

    const schema = JSON.parse(readFileSync(fileURLToPath(resolved), "utf8"));
    expect(schema).toMatchObject({ title: "aih-package-graph.schema.json" });
  });
});
