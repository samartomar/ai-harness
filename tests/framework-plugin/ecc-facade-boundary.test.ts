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

/**
 * D91 source-scan exceptions, agreed 2026-09-26 (D99). These are transitional
 * controls, not permission to add a second installer. The W1 import boundary
 * below checks reachability; this list checks source-owned controls and therefore
 * shares its transitional files without pretending the two checks are identical.
 */
const D91_CONTROL_ALLOWLIST = new Map([
  [
    "src/baseline-evidence/profiles.ts",
    "Registry identity data; no install action. Remove with Cut 2 (U6) Catalog shape.",
  ],
  [
    "src/framework-plugin/ecc-lifecycle.ts",
    "Generic cleanup dispatch for earlier aih writes; SP2 lifecycle hooks.",
  ],
  ["src/init/phases.ts", "Superpowers init and guidance in Core; SP2 (owner topic 3)."],
  ["src/init/index.ts", "Superpowers init and guidance in Core; SP2 (owner topic 3)."],
  ["src/uninstall/index.ts", "Superpowers init/cleanup guidance in Core; SP2 (owner topic 3)."],
  ["src/crispy/templates.ts", "Superpowers install guidance in Core; SP2 (owner topic 3)."],
  [
    "src/ecc/install-preview.ts",
    "Read-only dormant installPreview reader; Cut 2 (U6), with Catalog shape change.",
  ],
  [
    "src/internals/check-baseline-installable.ts",
    "Catalog-build check of dormant preview; Cut 2 (U6).",
  ],
  [
    "src/ecc/materialization-receipt.ts",
    "Legacy receipt reader, including .kiro/agents; Cut 2 (U8) compact legacy bridge.",
  ],
  [
    "src/framework-plugin/ecc-command.ts",
    "Retired Core flags parse for diagnostic; SP2 plugin command surface.",
  ],
  [
    "src/org-policy/ecc-hook-controls.ts",
    "ECC hook-control profiles for today's Catalog import; Cut 2 (U6).",
  ],
]);

const D91_CONTROL_MARKERS = [
  /runtime:ecc-installer/,
  /\b(?:installPreview|readEccInstallPreview)\b/,
  /\.kiro\/agents\/\$\{/,
  /export const ECC_HOOK_PROFILES\b/,
  /\b(?:prepareEccUninstallV1|eccStatePathsV1)\b/,
  /framework: "superpowers"/,
  /superpowers-methodology\.md/,
  /\/plugin install superpowers/,
];

function d91SourceControls(): string[] {
  return sourceFiles(src)
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      const eccCommandFlags =
        /name: "ecc"/.test(source) && /flags: "--(?:profile|with|ecc-path)\b/.test(source);
      return eccCommandFlags || D91_CONTROL_MARKERS.some((marker) => marker.test(source));
    })
    .map(toPosix)
    .sort();
}

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
 * deleting (work order W1). Each
 * entry must keep importing ECC framework code, so this list only shrinks as W1 lands.
 */
const W1_CATALOG_PRODUCERS = new Set([
  "src/internals/check-baseline-installable.ts",
  "src/org-policy/workbench/core/source-data-scanner.ts",
]);

/**
 * `src/ecc` modules that stay in Core: the state aih itself writes — the
 * materialization receipt, the explicit MCP add receipt and the machine
 * registration ledger — with the receipt's filesystem guards and the install
 * manifest (uninstall, prune and receipts read them without the plugin, so Core
 * can refuse by name when ECC state exists), the runtime descriptor Core
 * evaluates, and Catalog producer tooling. The
 * framework-host library re-exports them to the plugin, so they are not ECC
 * framework code.
 */
const KEEP_IN_CORE = new Set([
  "src/ecc/install-manifest.ts",
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

  it("carries no other copy of the plugin's ECC framework code", () => {
    // Each remaining module is reached from Core's entry points or the W1
    // Catalog producer tooling; everything else lives only in @aihq/framework-ecc.
    expect(eccFrameworkModules()).toEqual([
      "src/ecc/install-preview.ts",
      "src/ecc/materialization-target.ts",
      "src/ecc/runtime-adapter-compatibility.ts",
      "src/ecc/runtime-adapter-destination.ts",
    ]);
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

describe("D91 Core framework install controls", () => {
  it("keeps every source-scanned control on the dated D99 allowlist", () => {
    const found = d91SourceControls();
    expect(found.filter((file) => !D91_CONTROL_ALLOWLIST.has(file))).toEqual([]);
    expect([...D91_CONTROL_ALLOWLIST.keys()].filter((file) => !found.includes(file))).toEqual([]);
  });
});
