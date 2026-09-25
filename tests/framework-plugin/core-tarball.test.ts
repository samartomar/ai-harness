import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The framework plugins ship INSIDE Core's tarball (D71): each plugin's built
 * package at its source layout under packages/, loaded at run time from Core's
 * own package root. Core's own dist never carries plugin code, and nothing but
 * each plugin's manifest and its own `files` is packed: no sources, no tests.
 */

const repo = resolve(import.meta.dirname, "..", "..");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
  files: string[];
  exports: Record<string, unknown>;
  scripts: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  dependencies: Record<string, string>;
};

const PLUGINS = [
  { name: "@aihq/framework-ecc", directory: "packages/framework-ecc" },
  { name: "@aihq/framework-superpowers", directory: "packages/framework-superpowers" },
] as const;

function pluginManifest(directory: string): { files: string[] } {
  return JSON.parse(readFileSync(join(repo, directory, "package.json"), "utf8"));
}

/** Each plugin's manifest plus exactly what the plugin's own `files` lists. */
function bundledEntries(): string[] {
  return PLUGINS.flatMap(({ directory }) => [
    `${directory}/package.json`,
    ...pluginManifest(directory).files.map((entry) => `${directory}/${entry}`),
  ]);
}

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
  "executeEccEvidencePipeline",
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
  it("lists each plugin's manifest and its own files in Core's files, nothing else under packages/", () => {
    expect(
      manifest.files.filter((entry) => entry.replace(/^!/, "").split("/")[0] === "packages"),
    ).toEqual(bundledEntries());
  });

  it("builds both plugins as part of Core's build", () => {
    for (const { directory } of PLUGINS) {
      expect(manifest.scripts.build).toContain(`npm run build --prefix ${directory}`);
    }
  });

  it("packs only the bundled plugin entries and none of the moved ECC implementation paths", () => {
    const paths = packedPaths();
    expect(paths.length).toBeGreaterThan(0);
    const allowed = bundledEntries();
    const unexpected = paths.filter(
      (path) =>
        path.startsWith("packages/") &&
        !allowed.some((entry) => path === entry || path.startsWith(`${entry}/`)),
    );
    expect(unexpected).toEqual([]);
    for (const { directory } of PLUGINS) {
      expect(paths).toContain(`${directory}/package.json`);
      if (existsSync(join(repo, directory, "dist", "index.js")))
        expect(paths).toContain(`${directory}/dist/index.js`);
    }
    expect(paths.filter((path) => /(^|\/)tests?\//.test(path))).toEqual([]);
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
    for (const { name } of PLUGINS) {
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
