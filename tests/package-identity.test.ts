import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("Core package identity (#866)", () => {
  it("keeps direct runtime dependency engines compatible with the advertised Node floor", () => {
    const manifest = JSON.parse(read("package.json")) as {
      engines: { node: string };
      dependencies: Record<string, string>;
    };
    const lock = JSON.parse(read("package-lock.json")) as {
      packages: Record<string, { engines?: { node?: string } }>;
    };
    const minimum = (range: string): number => {
      const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range);
      if (!match) throw new Error(`Review unsupported Node engine range: ${range}`);
      return Number(match[1]) * 1_000_000 + Number(match[2] ?? 0) * 1_000 + Number(match[3] ?? 0);
    };
    const floor = minimum(manifest.engines.node);
    for (const name of Object.keys(manifest.dependencies)) {
      const dependency = lock.packages[`node_modules/${name}`];
      expect(dependency, `${name} must have a locked runtime identity`).toBeDefined();
      if (dependency?.engines?.node) {
        expect(
          minimum(dependency.engines.node),
          `${name} must support ${manifest.engines.node}`,
        ).toBeLessThanOrEqual(floor);
      }
    }
  });

  it("uses the current Core release identity without changing the command or exports", () => {
    const manifest = JSON.parse(read("package.json")) as Record<string, unknown>;

    expect(manifest.name).toBe("@aihq/core");
    expect(manifest.version).toBe(VERSION);
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
    expect(read("src/program.ts")).toContain(
      '"AIH — AI Development Assurance governance for enterprise workstations and repositories"',
    );
    const releaseWorkflow = read(".github/workflows/release.yml");
    expect(releaseWorkflow).toContain("https://www.npmjs.com/package/@aihq/core");
    expect(releaseWorkflow).not.toContain("https://www.npmjs.com/package/@aihq/harness");
    expect(releaseWorkflow).toContain('tags: ["v-core-*"]');
    expect(releaseWorkflow).toContain('test "$GITHUB_REF_NAME" = "v-core-$version"');
  });

  it("packs under the Core identity without running lifecycle scripts", () => {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm_execpath is required for the package identity test");

    const output = execFileSync(
      process.execPath,
      [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const packed = JSON.parse(output) as Array<{
      filename?: string;
      id?: string;
      name?: string;
      version?: string;
    }>;

    expect(packed).toHaveLength(1);
    expect(packed[0]).toMatchObject({
      filename: `aihq-core-${VERSION}.tgz`,
      id: `@aihq/core@${VERSION}`,
      name: "@aihq/core",
      version: VERSION,
    });
  });
});
