import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Core's tarball never carries framework plugin code: the plugins are separate
 * packages under packages/, optional peers of @aihq/core, loaded at run time.
 */

const repo = resolve(import.meta.dirname, "..", "..");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
  files: string[];
  exports: Record<string, unknown>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  dependencies: Record<string, string>;
};

function npmCli(): string {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find(
    (candidate) =>
      candidate !== undefined && /npm-cli\.js$/.test(candidate) && existsSync(candidate),
  );
  if (found === undefined) throw new Error("npm-cli.js not found for the pack file list");
  return found;
}

describe("Core tarball and framework plugins", () => {
  it("never lists packages/ in Core's files", () => {
    expect(
      manifest.files.filter((entry) => entry.replace(/^!/, "").split("/")[0] === "packages"),
    ).toEqual([]);
  });

  it("packs no framework plugin file", () => {
    const output = execFileSync(
      process.execPath,
      [npmCli(), "pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const packed = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
    const paths = packed[0]?.files.map((file) => file.path.replace(/\\/g, "/")) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith("packages/"))).toEqual([]);
    expect(paths.filter((path) => /framework-(superpowers|ecc)/.test(path))).toEqual([]);
  }, 60_000);

  it("declares both framework plugins as optional peers, never dependencies", () => {
    for (const name of ["@aihq/framework-ecc", "@aihq/framework-superpowers"]) {
      expect(manifest.peerDependencies[name]).toBe(">=0.1.0 <0.2.0");
      expect(manifest.peerDependenciesMeta[name]).toEqual({ optional: true });
      expect(manifest.dependencies[name]).toBeUndefined();
    }
  });

  it("exports the versioned framework host API subpath", () => {
    expect(manifest.exports["./framework-host"]).toEqual({
      types: "./dist/framework-host/index.d.ts",
      import: "./dist/framework-host.js",
    });
  });
});
