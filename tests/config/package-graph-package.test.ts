import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Package Graph public package surface", () => {
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
