export const WORKBENCH_PROVIDER_IDS = ["aih", "ecc", "organization", "superpowers"] as const;
export type WorkbenchProviderId = (typeof WORKBENCH_PROVIDER_IDS)[number];

export interface WorkbenchProviderOwnership {
  readonly id: WorkbenchProviderId;
  readonly sourceRoots: readonly string[];
  readonly testPath: string;
  readonly consumerTests: readonly string[];
}

/** Inputs that remain shared until an extracted provider proves narrower ownership. */
export const WORKBENCH_CATALOG_SHARED_INPUT_PATHS = [
  "src/baseline-evidence/catalog.ts",
  "src/baseline-evidence/catalog-providers/ecc.ts",
  "src/baseline-evidence/catalog-providers/superpowers.ts",
  "src/internals/baseline-sources.ts",
  "src/baseline-evidence/vendor.ts",
  "src/baseline-evidence/vendor-lock.json",
  "src/ecc/components.ts",
  "src/ecc/evidence.ts",
  "src/ecc/materialize.ts",
  "src/ecc/selection-closure.ts",
  "src/baseline-evidence/ecc-modules.json",
  "src/baseline-evidence/ecc-profiles.json",
  "src/internals/cli-registry.ts",
  "src/mcp/policy.ts",
  "src/mcp/servers.ts",
  "src/usage/capture.ts",
  "src/usage/hooks.ts",
  "src/version.ts",
  "src/org-policy/workbench/assembly.ts",
  "src/org-policy/workbench/compiler-input.ts",
  "src/org-policy/workbench/contracts.ts",
  "src/org-policy/workbench/compilers/built-in.ts",
  "src/org-policy/workbench/compilers/formats.ts",
  "src/org-policy/workbench/compilers/organization-manifest.ts",
  "src/org-policy/workbench/compilers/pinned-baseline.ts",
  "src/org-policy/workbench/providers/contracts.ts",
  "src/org-policy/workbench/providers/pinned.ts",
  "src/org-policy/workbench/providers/registry.ts",
] as const;

const commonConsumerTests = [
  "tests/internals/workbench-provider-ownership.test.ts",
  "tests/org-policy/catalog-providers.test.ts",
  "tests/org-policy/workbench/catalog-bundle.test.ts",
  "tests/org-policy/workbench/compilers/registry.test.ts",
  "tests/org-policy/workbench/contracts.test.ts",
  "tests/org-policy/workbench/prepared-catalog.test.ts",
] as const;

export const WORKBENCH_PROVIDER_OWNERSHIP: readonly WorkbenchProviderOwnership[] = [
  {
    id: "aih",
    sourceRoots: [
      "src/org-policy/catalog-providers/aih.ts",
      "src/org-policy/workbench/providers/aih.ts",
    ],
    testPath: "tests/org-policy/workbench/providers/aih.test.ts",
    consumerTests: commonConsumerTests,
  },
  {
    id: "ecc",
    sourceRoots: [
      "src/org-policy/catalog-providers/ecc.ts",
      "src/org-policy/workbench/providers/ecc.ts",
    ],
    testPath: "tests/org-policy/workbench/providers/ecc.test.ts",
    consumerTests: commonConsumerTests,
  },
  {
    id: "organization",
    sourceRoots: ["src/org-policy/workbench/providers/organization.ts"],
    testPath: "tests/org-policy/workbench/providers/organization.test.ts",
    consumerTests: commonConsumerTests,
  },
  {
    id: "superpowers",
    sourceRoots: [
      "src/org-policy/catalog-providers/superpowers.ts",
      "src/org-policy/workbench/providers/superpowers.ts",
    ],
    testPath: "tests/org-policy/workbench/providers/superpowers.test.ts",
    consumerTests: commonConsumerTests,
  },
] as const;

const providerById = new Map(WORKBENCH_PROVIDER_OWNERSHIP.map((record) => [record.id, record]));
const sharedInputs = new Set<string>(WORKBENCH_CATALOG_SHARED_INPUT_PATHS);

/** Provider import authority is narrower than the CI trigger scope above. */
const NEUTRAL_PROVIDER_IMPORT_PATHS = [
  "src/contract/strict-json-v1.ts",
  "src/org-policy/catalog-provider-types.ts",
  "src/org-policy/workbench/compiler-input.ts",
  "src/org-policy/workbench/contracts.ts",
  "src/org-policy/workbench/compilers/formats.ts",
  "src/org-policy/workbench/providers/contracts.ts",
] as const;
const PROVIDER_IMPORT_ALLOWED_PATHS: Readonly<Record<WorkbenchProviderId, ReadonlySet<string>>> = {
  aih: new Set([
    ...NEUTRAL_PROVIDER_IMPORT_PATHS,
    "src/org-policy/workbench/compilers/built-in.ts",
    "src/capability/package-graph/canonical.ts",
  ]),
  ecc: new Set([
    ...NEUTRAL_PROVIDER_IMPORT_PATHS,
    "src/baseline-evidence/acceptance-decisions.json",
    "src/baseline-evidence/ecc-modules.json",
    "src/baseline-evidence/ecc-profiles.json",
    "src/baseline-evidence/schema.ts",
    "src/baseline-evidence/vendor-lock.json",
    "src/capability/package-graph/canonical.ts",
    "src/errors.ts",
    "src/org-policy/ecc-content-metadata.snapshot.json",
    "src/org-policy/ecc-skill-catalog.snapshot.json",
    "src/baseline-evidence/verify.ts",
    "src/config/posture.ts",
    "src/ecc/registration.ts",
    "src/ecc/select.ts",
    "src/internals/clis.ts",
    "src/profile/scan.ts",
    "src/baseline-evidence/catalog.ts",
    "src/baseline-evidence/vendor.ts",
    "src/ecc/components.ts",
    "src/ecc/evidence.ts",
    "src/ecc/materialize.ts",
    "src/ecc/selection-closure.ts",
    "src/org-policy/ecc-content-metadata.ts",
    "src/org-policy/ecc-skill-catalog.ts",
    "src/org-policy/workbench/compilers/pinned-baseline.ts",
    "src/org-policy/workbench/providers/pinned.ts",
  ]),
  organization: new Set([
    ...NEUTRAL_PROVIDER_IMPORT_PATHS,
    "src/org-policy/workbench/compilers/organization-manifest.ts",
    "src/capability/package-graph/canonical.ts",
  ]),
  superpowers: new Set([
    ...NEUTRAL_PROVIDER_IMPORT_PATHS,
    "src/baseline-evidence/catalog.ts",
    "src/baseline-evidence/vendor.ts",
    "src/baseline-evidence/schema.ts",
    "src/baseline-evidence/vendor-lock.json",
    "src/capability/package-graph/canonical.ts",
    "src/org-policy/workbench/compilers/pinned-baseline.ts",
    "src/org-policy/workbench/providers/pinned.ts",
  ]),
};
const PROVIDER_IMPORT_DENIED_PATHS = new Set([
  "src/org-policy/catalog.ts",
  "src/baseline-evidence/catalogs.ts",
  "src/org-policy/workbench/compilers/registry.ts",
  "src/org-policy/workbench/assembly.ts",
  "src/org-policy/workbench/prepared-catalog.ts",
  "src/org-policy/workbench/providers/registry.ts",
]);
const PROVIDER_IMPORT_DENIED_PREFIXES = [
  "src/org-policy/workbench/core/",
  "src/org-policy/workbench/ui/",
];
const assemblyTest = "tests/org-policy/workbench/providers/assembly.test.ts";

export function isWorkbenchCatalogSharedInputPath(path: string): boolean {
  return sharedInputs.has(path);
}

export function providerForWorkbenchPath(path: string): WorkbenchProviderId | undefined {
  return WORKBENCH_PROVIDER_OWNERSHIP.find(
    (record) => path === record.testPath || record.sourceRoots.some((root) => path === root),
  )?.id;
}

/** Exact tests a provider-local receipt must execute before its packed smoke. */
export function providerTestsFor(providerIds: readonly WorkbenchProviderId[]): string[] {
  const tests = new Set<string>(providerIds.length === 0 ? [] : [assemblyTest]);
  for (const providerId of providerIds) {
    const record = providerById.get(providerId);
    if (record === undefined) throw new Error(`unknown Workbench provider ${providerId}`);
    tests.add(record.testPath);
    for (const consumer of record.consumerTests) tests.add(consumer);
  }
  return [...tests].sort((left, right) => left.localeCompare(right));
}

/** Validate actual relative-import targets discovered by one provider test. */
export function assertProviderImportTarget(
  providerId: WorkbenchProviderId,
  targetPath: string,
): void {
  const targetProvider = providerForWorkbenchPath(targetPath);
  if (targetProvider !== undefined && targetProvider !== providerId) {
    throw new Error(`${providerId} provider imports ${targetProvider} provider internals`);
  }
  if (
    PROVIDER_IMPORT_DENIED_PATHS.has(targetPath) ||
    PROVIDER_IMPORT_DENIED_PREFIXES.some((prefix) => targetPath.startsWith(prefix))
  ) {
    throw new Error(`${providerId} provider imports forbidden authority: ${targetPath}`);
  }
  if (targetProvider === undefined && !PROVIDER_IMPORT_ALLOWED_PATHS[providerId].has(targetPath)) {
    throw new Error(`${providerId} provider imports an unreviewed dependency: ${targetPath}`);
  }
}

/** Read source imports mechanically so provider tests do not duplicate per-import assertions. */
export function validateProviderSourceImports(
  providerId: WorkbenchProviderId,
  sourcePath: string,
  resolvedImportTargets: readonly string[],
): void {
  if (providerForWorkbenchPath(sourcePath) !== providerId) {
    throw new Error(`${sourcePath} is not owned by ${providerId}`);
  }
  for (const targetPath of resolvedImportTargets)
    assertProviderImportTarget(providerId, targetPath);
}

/** Fail closed when reviewed ownership is incomplete or ambiguous. */
export function validateWorkbenchProviderOwnership(): void {
  const ids = new Set<string>();
  const roots = new Set<string>();
  const tests = new Set<string>();
  for (const record of WORKBENCH_PROVIDER_OWNERSHIP) {
    if (ids.has(record.id)) throw new Error(`duplicate Workbench provider ${record.id}`);
    ids.add(record.id);
    if (!record.testPath.startsWith("tests/") || tests.has(record.testPath))
      throw new Error(`invalid provider test ownership for ${record.id}`);
    tests.add(record.testPath);
    if (record.consumerTests.length === 0)
      throw new Error(`incomplete Workbench provider ownership for ${record.id}`);
    for (const root of record.sourceRoots) {
      if (
        !root.startsWith("src/") ||
        !(root.endsWith("/") || root.endsWith(".ts")) ||
        roots.has(root)
      )
        throw new Error(`invalid provider source root ${root}`);
      roots.add(root);
    }
  }
  if (ids.size !== WORKBENCH_PROVIDER_IDS.length)
    throw new Error("Workbench provider ownership does not cover every provider");
}
