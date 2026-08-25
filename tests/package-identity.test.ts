import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("Core package identity (#866)", () => {
  it("makes @aihq/core primary without changing the command, exports, or feature-branch version", () => {
    const manifest = JSON.parse(read("package.json")) as Record<string, unknown>;

    expect(manifest.name).toBe("@aihq/core");
    expect(manifest.version).toBe("6.1.0");
    expect(manifest.bin).toEqual({ aih: "dist/cli.js" });
    expect(manifest.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./schemas/*.json": "./schemas/*.json",
      "./package.json": "./package.json",
    });
    expect({
      ...(manifest.dependencies as Record<string, string>),
      ...(manifest.devDependencies as Record<string, string>),
      ...(manifest.optionalDependencies as Record<string, string> | undefined),
      ...(manifest.peerDependencies as Record<string, string> | undefined),
    }).not.toHaveProperty("@aihq/harness");

    expect(read("src/version.ts")).toContain('PACKAGE_NAME = "@aihq/core"');
    expect(read("package.json")).toContain("import('@aihq/core')");
    const releaseWorkflow = read(".github/workflows/release.yml");
    expect(releaseWorkflow).toContain("https://www.npmjs.com/package/@aihq/core");
    expect(releaseWorkflow).not.toContain("https://www.npmjs.com/package/@aihq/harness");
  });
});
