import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import {
  assertProviderImportTarget,
  isWorkbenchCatalogSharedInputPath,
  providerForWorkbenchPath,
  providerTestsFor,
  validateProviderSourceImports,
  validateWorkbenchProviderOwnership,
  WORKBENCH_PROVIDER_OWNERSHIP,
} from "../../src/internals/workbench-provider-ownership.js";
import { registeredCatalogProvidersV1 } from "../../src/org-policy/workbench/providers/registry.js";

function staticImportClosure(entryPaths: readonly string[]): string[] {
  const root = resolve(process.cwd());
  const targets = new Set<string>();
  const visited = new Set<string>();
  const resolveRelativeModule = (sourcePath: string, specifier: string): string => {
    const unresolved = resolve(dirname(sourcePath), specifier);
    const candidates = unresolved.endsWith(".js")
      ? [`${unresolved.slice(0, -3)}.ts`, unresolved]
      : unresolved.endsWith(".mjs")
        ? [`${unresolved.slice(0, -4)}.mts`, unresolved]
        : unresolved.endsWith(".cjs")
          ? [`${unresolved.slice(0, -4)}.cts`, unresolved]
          : [
              unresolved,
              `${unresolved}.ts`,
              `${unresolved}.tsx`,
              `${unresolved}.mts`,
              `${unresolved}.cts`,
              `${unresolved}.json`,
              resolve(unresolved, "index.ts"),
            ];
    const target = candidates.find((candidate) => existsSync(candidate));
    if (target === undefined)
      throw new Error(`missing relative import target ${specifier} from ${sourcePath}`);
    return target;
  };
  const visit = (sourcePath: string): void => {
    if (visited.has(sourcePath)) return;
    visited.add(sourcePath);
    const source = readFileSync(sourcePath, "utf8");
    const parsed = parse(source, { sourceType: "unambiguous", plugins: ["typescript"] });
    const specifiers = new Map<string, boolean>();
    const addSpecifier = (value: unknown, kind: string, typeOnly = false): void => {
      if (
        typeof value !== "object" ||
        value === null ||
        (value as { type?: unknown }).type !== "StringLiteral" ||
        typeof (value as { value?: unknown }).value !== "string"
      )
        throw new Error(`unsupported ${kind} import in ${sourcePath}`);
      const specifier = (value as { value: string }).value;
      if (!typeOnly || !specifiers.has(specifier)) specifiers.set(specifier, typeOnly);
    };
    const visitNode = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) visitNode(child);
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      if (record.type === "ImportDeclaration") {
        addSpecifier(record.source, "module", record.importKind === "type");
      } else if (
        (record.type === "ExportNamedDeclaration" || record.type === "ExportAllDeclaration") &&
        record.source !== undefined &&
        record.source !== null
      ) {
        addSpecifier(record.source, "module", record.exportKind === "type");
      } else if (record.type === "TSImportEqualsDeclaration") {
        addSpecifier(record.moduleReference, "require");
      } else if (record.type === "TSImportType") {
        addSpecifier(record.argument, "import type", true);
      } else if (record.type === "ImportExpression") {
        addSpecifier(record.source, "dynamic");
      } else if (record.type === "CallExpression") {
        const callee = record.callee as { type?: unknown; name?: unknown } | undefined;
        if (callee?.type === "Import") addSpecifier((record.arguments as unknown[])[0], "dynamic");
        else if (callee?.type === "Identifier" && callee.name === "require")
          addSpecifier((record.arguments as unknown[])[0], "require");
      }
      for (const value of Object.values(record)) visitNode(value);
    };
    visitNode(parsed);
    for (const [specifier, typeOnly] of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const target = resolveRelativeModule(sourcePath, specifier);
      const targetRelativePath = relative(root, target);
      if (isAbsolute(targetRelativePath) || targetRelativePath.startsWith(".."))
        throw new Error(`import escapes repository: ${target}`);
      targets.add(targetRelativePath.replaceAll("\\", "/"));
      if (!typeOnly && !target.endsWith(".json")) visit(target);
    }
  };
  for (const entryPath of entryPaths) visit(resolve(entryPath));
  return [...targets].sort((left, right) => left.localeCompare(right));
}

describe("Workbench provider ownership", () => {
  it.each([
    "src/baseline-evidence/vendor-lock.json",
    "src/baseline-evidence/catalog-providers/ecc.ts",
    "src/ecc/components.ts",
    "src/ecc/evidence.ts",
    "src/ecc/selection-closure.ts",
    "src/baseline-evidence/ecc-modules.json",
    "src/mcp/policy.ts",
    "src/mcp/servers.ts",
    "src/internals/cli-registry.ts",
    "src/usage/hooks.ts",
    "src/baseline-evidence/catalog-providers/superpowers.ts",
    "src/internals/baseline-sources.ts",
    "src/ecc/materialize.ts",
    "src/baseline-evidence/ecc-profiles.json",
    "src/usage/capture.ts",
    "src/version.ts",
  ])("keeps the shared catalog input %s in the conservative Workbench scope", (path) => {
    expect(isWorkbenchCatalogSharedInputPath(path)).toBe(true);
  });

  it("maps only registered provider source roots to their provider and complete execution set", () => {
    expect(providerForWorkbenchPath("src/org-policy/catalog-providers/ecc.ts")).toBe("ecc");
    expect(providerForWorkbenchPath("tests/org-policy/workbench/providers/ecc.test.ts")).toBe(
      "ecc",
    );
    expect(
      providerForWorkbenchPath("src/baseline-evidence/catalog-providers/ecc.ts"),
    ).toBeUndefined();
    expect(
      providerForWorkbenchPath("src/org-policy/catalog-providers/unknown/catalog.ts"),
    ).toBeUndefined();
    expect(providerTestsFor(["ecc"])).toEqual([
      "tests/internals/workbench-provider-ownership.test.ts",
      "tests/org-policy/catalog-providers.test.ts",
      "tests/org-policy/ecc-mcp-catalog.test.ts",
      "tests/org-policy/workbench/catalog-bundle.test.ts",
      "tests/org-policy/workbench/compilers/registry.test.ts",
      "tests/org-policy/workbench/contracts.test.ts",
      "tests/org-policy/workbench/policy-consumption.test.ts",
      "tests/org-policy/workbench/prepared-catalog.test.ts",
      "tests/org-policy/workbench/providers/assembly.test.ts",
      "tests/org-policy/workbench/providers/ecc.test.ts",
    ]);
  });

  it("routes the pinned Matt provider source and data payload through its exact contract set", () => {
    expect(providerForWorkbenchPath("src/org-policy/workbench/providers/mattpocock.ts")).toBe(
      "mattpocock",
    );
    expect(
      providerForWorkbenchPath("src/org-policy/workbench/providers/mattpocock.snapshot.json"),
    ).toBe("mattpocock");
    expect(providerTestsFor(["mattpocock"] as never)).toEqual(
      expect.arrayContaining([
        "tests/org-policy/workbench/providers/mattpocock.test.ts",
        "tests/org-policy/workbench/compilers/pinned-skill-collection.test.ts",
        "tests/org-policy/workbench/core/mattpocock-consumption.test.ts",
      ]),
    );
  });

  it("routes the static Ponytail provider source and data payload through its exact contract set", () => {
    expect(providerForWorkbenchPath("src/org-policy/workbench/providers/ponytail.ts")).toBe(
      "ponytail",
    );
    expect(
      providerForWorkbenchPath("src/org-policy/workbench/providers/ponytail.snapshot.json"),
    ).toBe("ponytail");
    expect(providerTestsFor(["ponytail"] as never)).toEqual(
      expect.arrayContaining([
        "tests/org-policy/workbench/providers/ponytail.test.ts",
        "tests/org-policy/workbench/compilers/pinned-component-collection.test.ts",
        "tests/org-policy/workbench/core/ponytail-consumption.test.ts",
      ]),
    );
  });
  it("enrolls the static Superpowers metadata snapshot with its provider", () => {
    expect(
      providerForWorkbenchPath("src/org-policy/superpowers-content-metadata.snapshot.json"),
    ).toBe("superpowers");
  });
  it("enrolls the source-locked ECC MCP catalog and payload with the ECC provider", () => {
    expect(providerForWorkbenchPath("src/org-policy/ecc-mcp-catalog.ts")).toBe("ecc");
    expect(providerForWorkbenchPath("src/org-policy/ecc-mcp-catalog.snapshot.json")).toBe("ecc");
  });
  it("does not turn a broad CI trigger into provider import authority", () => {
    expect(() => assertProviderImportTarget("aih", "src/mcp/servers.ts")).toThrow(
      /unreviewed dependency/u,
    );
    expect(() => assertProviderImportTarget("ecc", "src/org-policy/workbench/assembly.ts")).toThrow(
      /forbidden authority/u,
    );
    expect(() =>
      assertProviderImportTarget("ecc", "src/org-policy/workbench/providers/registry.ts"),
    ).toThrow(/forbidden authority/u);
    expect(() =>
      assertProviderImportTarget(
        "ecc",
        "src/org-policy/workbench/core/organization-preparation.ts",
      ),
    ).toThrow(/forbidden authority/u);
  });
  expect(() => assertProviderImportTarget("ecc", "src/baseline-evidence/catalogs.ts")).toThrow(
    /forbidden authority/u,
  );
  expect(() =>
    assertProviderImportTarget("ecc", "src/org-policy/workbench/compilers/registry.ts"),
  ).toThrow(/forbidden authority/u);

  it("mechanically validates every provider's recursive static import closure", () => {
    for (const record of WORKBENCH_PROVIDER_OWNERSHIP) {
      const staticTargets = new Set<string>();
      for (const sourceRoot of record.sourceRoots) {
        // Data payloads are not TypeScript modules, but must be imported by an owned entry.
        if (sourceRoot.endsWith(".json")) continue;
        const targets = staticImportClosure([sourceRoot]);
        for (const target of targets) staticTargets.add(target);
        validateProviderSourceImports(record.id, sourceRoot, targets);
      }
      for (const sourceRoot of record.sourceRoots) {
        if (sourceRoot.endsWith(".json")) expect(staticTargets.has(sourceRoot)).toBe(true);
      }
    }
  });

  it("keeps the shared target vocabulary limited to its inert schema dependency", () => {
    const path = "src/internals/cli-registry.ts";
    const parsed = parse(readFileSync(path, "utf8"), {
      sourceType: "module",
      plugins: ["typescript"],
    });
    const imports: unknown[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.type === "ImportDeclaration")
        imports.push((record.source as { value?: unknown }).value);
      if (record.type === "ExportAllDeclaration" || record.type === "ExportNamedDeclaration")
        expect(record.source ?? null).toBeNull();
      expect(record.type).not.toBe("ImportExpression");
      expect(record.type).not.toBe("TSImportEqualsDeclaration");
      if (record.type === "Identifier") {
        expect([
          "require",
          "process",
          "fetch",
          "WebSocket",
          "globalThis",
          "eval",
          "Function",
          "Bun",
          "Deno",
        ]).not.toContain(record.name);
      }
      if (record.type === "CallExpression")
        expect((record.callee as { type?: unknown }).type).not.toBe("Import");
      for (const child of Object.values(record)) visit(child);
    };
    visit(parsed);
    expect(imports).toEqual(["zod"]);
    expect(staticImportClosure([path])).toEqual([]);
    for (const { id } of WORKBENCH_PROVIDER_OWNERSHIP)
      expect(() => assertProviderImportTarget(id, path)).not.toThrow();
    expect(isWorkbenchCatalogSharedInputPath(path)).toBe(true);
  });

  it("rejects unreviewed and shared JSON as provider source ownership", () => {
    for (const providerId of ["mattpocock", "ponytail"] as const) {
      const record = WORKBENCH_PROVIDER_OWNERSHIP.find(({ id }) => id === providerId);
      if (record === undefined) throw new Error("Missing " + providerId + " provider ownership");
      const mutableRecord = record as unknown as { sourceRoots: string[] };
      const originalRoots = mutableRecord.sourceRoots;
      try {
        for (const path of [
          "src/org-policy/workbench/providers/unreviewed.snapshot.json",
          "src/baseline-evidence/ecc-modules.json",
        ]) {
          mutableRecord.sourceRoots = [...originalRoots, path];
          expect(() => validateWorkbenchProviderOwnership()).toThrow(
            /invalid provider source root/u,
          );
        }
      } finally {
        mutableRecord.sourceRoots = originalRoots;
      }
    }
  });

  it("matches registrations and names only existing provider source, test, and consumer paths", () => {
    expect(registeredCatalogProvidersV1.map((provider) => provider.providerId).sort()).toEqual(
      [...WORKBENCH_PROVIDER_OWNERSHIP.map((record) => record.id)].sort(),
    );
    for (const record of WORKBENCH_PROVIDER_OWNERSHIP) {
      expect(existsSync(resolve(record.testPath)), `${record.id} provider test`).toBe(true);
      for (const path of [...record.sourceRoots, ...record.consumerTests])
        expect(existsSync(resolve(path)), `${record.id} provider path ${path}`).toBe(true);
    }
    expect(() => validateWorkbenchProviderOwnership()).not.toThrow();
  });
});
