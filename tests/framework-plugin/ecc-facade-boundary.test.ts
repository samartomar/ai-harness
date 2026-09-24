import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { moduleSpecifiers, sourceFiles } from "./module-specifiers.js";

/**
 * Phase 2 of the ECC move: the ECC implementation lives in `@aihq/framework-ecc`
 * and Core reaches it only through the plugin loader. The phase-1 facade is
 * gone. The one exemption is the Catalog producers and Workbench data modules
 * W1 is moving to @aihq/catalog or deleting: until they leave Core they still
 * import ECC data helpers, and the ECC modules they reach stay in Core with
 * them — nothing else in Core may reach those modules. Generic runtime modules
 * of `src/ecc-profile/**` (MCP runtimes, hooks runtime, `native-runtime-cli.ts`)
 * are not framework code.
 */

const repo = resolve(import.meta.dirname, "..", "..");
const src = join(repo, "src");
const toPosix = (path: string) => relative(repo, path).split(sep).join("/");

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
 * deleting (work order W1), including Catalog's install-preview tooling. Each
 * entry must keep importing ECC framework code, so this list only shrinks as W1 lands.
 */
const W1_CATALOG_PRODUCERS = new Set([
  "src/baseline-evidence/catalog-providers/ecc.ts",
  "src/baseline-evidence/ecc-preview-boundary.ts",
  "src/ecc/install-preview-generate.ts",
  "src/ecc/install-preview-validate.ts",
  "src/internals/verify-packaged-workbench-source-data.ts",
  "src/org-policy/catalog-providers/ecc.ts",
  "src/org-policy/workbench/core/source-data-scanner.ts",
]);

/**
 * `src/ecc` modules that stay in Core: the state aih itself writes — the
 * materialization receipt, the explicit MCP add receipt and the machine
 * registration ledger — with the receipt's filesystem guards and the install
 * manifest (uninstall, prune and receipts read them without the plugin, so Core
 * can refuse by name when ECC state exists), the runtime descriptor Core
 * evaluates, and Catalog producer tooling for the install preview. The
 * framework-host library re-exports them to the plugin, so they are not ECC
 * framework code.
 */
const KEEP_IN_CORE = new Set([
  "src/ecc/install-manifest.ts",
  "src/ecc/install-preview-generate.ts",
  "src/ecc/install-preview-validate.ts",
  "src/ecc/materialization-fs.ts",
  "src/ecc/materialization-receipt.ts",
  "src/ecc/mcp-explicit-add-receipt.ts",
  "src/ecc/registration.ts",
  "src/ecc/runtime-descriptor.ts",
  "src/ecc/runtime-descriptor-evaluation.ts",
]);

function isEccFrameworkModule(path: string): boolean {
  const withTs = path.replace(/\.js$/, ".ts");
  const rel = toPosix(withTs);
  if (KEEP_IN_CORE.has(rel)) return false;
  if (rel.startsWith("src/ecc/")) return true;
  return (
    rel.startsWith("src/ecc-profile/") &&
    dirname(rel) === "src/ecc-profile" &&
    ECC_PROFILE_FRAMEWORK_MODULES.has(basename(rel))
  );
}

function eccFrameworkImports(file: string): string[] {
  return moduleSpecifiers(readFileSync(file, "utf8"))
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolve(dirname(file), specifier))
    .filter(isEccFrameworkModule)
    .map((target) => toPosix(target.replace(/\.js$/, ".ts")));
}

/** Core files that are not ECC framework code themselves, and the ECC framework modules each one imports. */
function eccImporters(): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  for (const file of sourceFiles(src)) {
    if (isEccFrameworkModule(file)) continue;
    const targets = eccFrameworkImports(file);
    if (targets.length > 0) importers.set(toPosix(file), targets);
  }
  return importers;
}

/** The ECC framework modules still in Core. */
function eccFrameworkModules(): string[] {
  return sourceFiles(src)
    .filter((file) => isEccFrameworkModule(file))
    .map(toPosix)
    .sort();
}

/** The ECC framework modules the W1 producers reach, transitively. */
function w1PinnedModules(): Set<string> {
  const reached = new Set<string>();
  const pending = [...W1_CATALOG_PRODUCERS].flatMap((file) =>
    eccFrameworkImports(join(repo, file)),
  );
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || reached.has(next)) continue;
    reached.add(next);
    pending.push(...eccFrameworkImports(join(repo, next)));
  }
  return reached;
}

describe("ECC framework boundary (phase 2)", () => {
  const importers = eccImporters();

  it("no Core module imports ECC framework code except the W1 Catalog producers", () => {
    const unrouted = [...importers.keys()].filter((file) => !W1_CATALOG_PRODUCERS.has(file));
    expect(unrouted).toEqual([]);
  });

  it("the phase-1 facade is gone", () => {
    expect(existsSync(join(src, "framework-plugin", "ecc-facade.ts"))).toBe(false);
  });

  it("keeps the W1 producer exemptions current (stale entries fail)", () => {
    const stale = [...W1_CATALOG_PRODUCERS].filter((file) => !importers.has(file));
    expect(stale).toEqual([]);
  });

  it("keeps only the ECC framework modules the W1 producers still reach", () => {
    const pinned = w1PinnedModules();
    expect(eccFrameworkModules().filter((file) => !pinned.has(file))).toEqual([]);
  });

  it("classifies generic ecc-profile runtime modules as outside the framework boundary", () => {
    expect(isEccFrameworkModule(join(src, "ecc-profile", "native-runtime-cli.js"))).toBe(false);
    expect(isEccFrameworkModule(join(src, "ecc-profile", "default-mcp-runtime-lock.js"))).toBe(
      false,
    );
    expect(isEccFrameworkModule(join(src, "ecc-profile", "render.js"))).toBe(true);
    expect(isEccFrameworkModule(join(src, "ecc", "pipeline.js"))).toBe(true);
  });
});
