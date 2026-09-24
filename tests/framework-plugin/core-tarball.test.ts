import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * The ECC implementation modules phase 2 moved into @aihq/framework-ecc (or
 * deleted as unreachable). Core's source tree and tarball carry none of them.
 * The ECC modules still in Core are only those the W1 Catalog producers import
 * (tests/framework-plugin/ecc-facade-boundary.test.ts pins that set).
 */
const ABSENT_ECC_IMPLEMENTATION_PATHS = [
  "src/framework-plugin/ecc-facade.ts",
  "src/ecc/codex.ts",
  "src/ecc/effective-discovery.ts",
  "src/ecc/governed-lifecycle.ts",
  "src/ecc/index.ts",
  "src/ecc/install.ts",
  "src/ecc/materialization-plan.ts",
  "src/ecc/materialization-target-claude.ts",
  "src/ecc/materialization.ts",
  "src/ecc/mcp-explicit-add.ts",
  "src/ecc/mcp.ts",
  "src/ecc/pipeline.ts",
  "src/ecc/prune-reconcile.ts",
  "src/ecc/reconcile-driver.ts",
  "src/ecc/reconcile.ts",
  "src/ecc/runtime-descriptor-resolver.ts",
  "src/ecc/verified.ts",
  "src/ecc-profile/command.ts",
  "src/ecc-profile/governed-codex-roles.ts",
  "src/ecc-profile/lifecycle.ts",
  "src/ecc-profile/parity-receipt.ts",
  "src/binding/frameworks/ecc.ts",
  "src/internals/check-ecc-installer.ts",
];

/**
 * Names of ECC implementation functions, one per moved area. Core's build keeps
 * function names (tsup `keepNames`), so a bundled copy would carry the name.
 */
const ECC_IMPLEMENTATION_NAMES = [
  "executeEccCommand",
  "applyPreparedGovernedEccDelivery",
  "eccPruneReconciliationActions",
  "planGovernedCodexRoleRegistration",
  "buildEccProfileParityReceipt",
  "describeEccEffectiveDiscovery",
  "planEccMaterialization",
];

function packedPaths(): string[] {
  const output = execFileSync(
    process.execPath,
    [npmCli(), "pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const packed = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>;
  return packed[0]?.files.map((file) => file.path.replace(/\\/g, "/")) ?? [];
}

const dist = join(repo, "dist");

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

  it("packs no framework plugin file and none of the moved ECC implementation paths", () => {
    const paths = packedPaths();
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.startsWith("packages/"))).toEqual([]);
    expect(paths.filter((path) => /framework-(superpowers|ecc)/.test(path))).toEqual([]);
    expect(paths.filter((path) => ABSENT_ECC_IMPLEMENTATION_PATHS.includes(path))).toEqual([]);
  }, 60_000);

  it("lists the ECC implementation paths absent from Core's source tree", () => {
    expect(ABSENT_ECC_IMPLEMENTATION_PATHS.filter((path) => existsSync(join(repo, path)))).toEqual(
      [],
    );
  });

  it.skipIf(!existsSync(join(dist, "cli.js")))(
    "bundles no ECC implementation function into Core's built dist",
    () => {
      const bundled = readdirSync(dist)
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFileSync(join(dist, name), "utf8"))
        .join("\n");
      expect(ECC_IMPLEMENTATION_NAMES.filter((name) => bundled.includes(name))).toEqual([]);
    },
  );

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
