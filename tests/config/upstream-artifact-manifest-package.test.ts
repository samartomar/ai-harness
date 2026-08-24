import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Upstream Artifact Manifest public package surface", () => {
  it("ships the portable manifest schema and public parser", async () => {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm_execpath is required for the cross-platform pack test");
    const output = execFileSync(
      process.execPath,
      [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const packed = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    expect(packed[0]?.files.map((file) => file.path)).toContain(
      "schemas/aih-upstream-artifact-manifest-v1.schema.json",
    );

    const resolved = import.meta.resolve(
      "@aihq/harness/schemas/aih-upstream-artifact-manifest-v1.schema.json",
    );
    expect(fileURLToPath(resolved)).toBe(
      join(root, "schemas/aih-upstream-artifact-manifest-v1.schema.json"),
    );
    expect(JSON.parse(readFileSync(fileURLToPath(resolved), "utf8"))).toMatchObject({
      title: "aih-upstream-artifact-manifest-v1.schema.json",
    });

    const library = await import("../../src/index.js");
    expect(library.parseUpstreamArtifactManifestV1Bytes).toBeTypeOf("function");
    expect(library.UpstreamArtifactManifestV1Schema).toBeDefined();
  }, 20_000);
});
