import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { moduleSpecifiers, sourceFiles } from "./module-specifiers.js";

/**
 * Phase 1 of the ECC move: `src/framework-plugin/ecc-facade.ts` is the ONE Core
 * module that reaches ECC framework code — `src/ecc/**` and the ECC profile
 * modules of `src/ecc-profile/**`. Phase 2 swaps that one module to the
 * `@aihq/framework-ecc` plugin. Generic runtime modules of `src/ecc-profile/**`
 * (MCP runtimes, hooks runtime, `native-runtime-cli.ts`) are not framework code.
 */

const repo = resolve(import.meta.dirname, "..", "..");
const src = join(repo, "src");
const toPosix = (path: string) => relative(repo, path).split(sep).join("/");

const FACADE = "src/framework-plugin/ecc-facade.ts";

/** The ECC profile modules that are framework code (the rest of src/ecc-profile is generic runtime). */
const ECC_PROFILE_FRAMEWORK_MODULES = new Set([
  "index.ts",
  "command.ts",
  "lifecycle.ts",
  "render.ts",
  "source-closure.ts",
  "projection-policy.ts",
  "parity-receipt.ts",
  "governed-codex-roles.ts",
]);

/**
 * Catalog producers and Workbench data modules W1 is moving to @aihq/catalog or
 * deleting (work order W1). They still import ECC data helpers directly; each
 * entry must keep doing so, so this list only shrinks as W1 lands.
 */
const W1_CATALOG_PRODUCERS = new Set([
  "src/baseline-evidence/catalog-providers/ecc.ts",
  "src/baseline-evidence/ecc-preview-boundary.ts",
  "src/internals/prepare-packaged-workbench-source-data.ts",
  "src/internals/verify-packaged-workbench-source-data.ts",
  "src/org-policy/catalog-providers/ecc.ts",
  "src/org-policy/workbench/core/packaged-source-data.ts",
  "src/org-policy/workbench/core/source-data-local-receipt.ts",
  "src/org-policy/workbench/core/source-data-runtime-descriptor-custody.ts",
  "src/org-policy/workbench/core/source-data-scanner.ts",
  "src/org-policy/workbench/core/source-data.ts",
]);

function isEccFrameworkModule(path: string): boolean {
  const withTs = path.replace(/\.js$/, ".ts");
  const rel = toPosix(withTs);
  if (rel.startsWith("src/ecc/")) return true;
  return (
    rel.startsWith("src/ecc-profile/") &&
    dirname(rel) === "src/ecc-profile" &&
    ECC_PROFILE_FRAMEWORK_MODULES.has(basename(rel))
  );
}

function isInsideEcc(file: string): boolean {
  const rel = toPosix(file);
  return rel.startsWith("src/ecc/") || rel.startsWith("src/ecc-profile/");
}

/** Core files (outside ECC itself) and the ECC framework modules each one imports. */
function eccImporters(): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  for (const file of sourceFiles(src)) {
    if (isInsideEcc(file)) continue;
    const targets = moduleSpecifiers(readFileSync(file, "utf8"))
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => resolve(dirname(file), specifier))
      .filter(isEccFrameworkModule)
      .map(toPosix);
    if (targets.length > 0) importers.set(toPosix(file), targets);
  }
  return importers;
}

describe("ECC facade boundary (phase 1)", () => {
  const importers = eccImporters();

  it("routes every Core ECC call site through src/framework-plugin/ecc-facade.ts", () => {
    const unrouted = [...importers.keys()].filter(
      (file) => file !== FACADE && !W1_CATALOG_PRODUCERS.has(file),
    );
    expect(unrouted).toEqual([]);
  });

  it("the facade is an importer of ECC framework code", () => {
    expect(importers.get(FACADE)?.length ?? 0).toBeGreaterThan(0);
  });

  it("keeps the W1 producer exemptions current (stale entries fail)", () => {
    const stale = [...W1_CATALOG_PRODUCERS].filter((file) => !importers.has(file));
    expect(stale).toEqual([]);
  });

  it("classifies generic ecc-profile runtime modules as outside the framework boundary", () => {
    expect(isEccFrameworkModule(join(src, "ecc-profile", "native-runtime-cli.js"))).toBe(false);
    expect(isEccFrameworkModule(join(src, "ecc-profile", "default-mcp-runtime-lock.js"))).toBe(
      false,
    );
    expect(isEccFrameworkModule(join(src, "ecc-profile", "governed-codex-roles.js"))).toBe(true);
    expect(isEccFrameworkModule(join(src, "ecc", "pipeline.js"))).toBe(true);
  });
});
