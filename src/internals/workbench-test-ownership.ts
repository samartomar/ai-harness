/** Inert ownership shared by Vitest configurations and the CI classifier. */
export const WORKBENCH_EXPLICIT_TEST_PATHS = [
  "tests/ecc/module-selection-closure.test.ts",
  "tests/org-policy/acceptance-hook-registrar.test.ts",
  "tests/org-policy/admin-baseline-evidence-cli-route.test.ts",
  "tests/org-policy/admin-catalog-cli-route.test.ts",
  "tests/org-policy/admin-catalog-fetch-v1.test.ts",
  "tests/org-policy/ecc-hook-controls.test.ts",
  "tests/org-policy/ecc-mcp-approval.test.ts",
  "tests/org-policy/generate.test.ts",
  "tests/org-policy/packed-workbench-cleanup.test.ts",
  "tests/org-policy/supported-cli-subsets.test.ts",
  "tests/org-policy/ui-server.test.ts",
  "tests/tools/prepare-packed-workbench.test.ts",
] as const;

const legacyTestPrefix = "tests/org-policy/studio-";
const typedTestPrefix = "tests/org-policy/workbench/";
const explicitPaths = new Set<string>(WORKBENCH_EXPLICIT_TEST_PATHS);

/** Core/compiler risks remain in the retained UI-coverage project. */
export const WORKBENCH_CONTRACT_TEST_PATTERNS = [
  "tests/org-policy/workbench/compilers/**/*.test.ts",
  "tests/org-policy/workbench/catalog-bundle.test.ts",
  "tests/org-policy/workbench/prepared-catalog.test.ts",
  "tests/org-policy/workbench/core/**/*.test.ts",
  "tests/org-policy/workbench/policy-consumption.test.ts",
] as const;

/** New typed root tests are pure by default unless they are a retained contract risk. */
export const WORKBENCH_PURE_TEST_PATTERNS = [`${typedTestPrefix}**/*.test.ts`] as const;
export const WORKBENCH_PURE_TEST_EXCLUDE_PATTERNS = WORKBENCH_CONTRACT_TEST_PATTERNS;

/** PR retained coverage: legacy/browser-adjacent behavior plus Core contract risks. */
export const WORKBENCH_RETAINED_TEST_PATTERNS = [
  ...WORKBENCH_EXPLICIT_TEST_PATHS,
  `${legacyTestPrefix}*.test.ts`,
  ...WORKBENCH_CONTRACT_TEST_PATTERNS,
] as const;

/** Complete ownership remains for standalone Workbench and CI-selected lanes. */
export const WORKBENCH_TEST_PATTERNS = [
  ...WORKBENCH_EXPLICIT_TEST_PATHS,
  `${legacyTestPrefix}*.test.ts`,
  `${typedTestPrefix}**/*.test.ts`,
] as const;

export function isWorkbenchTestPath(path: string): boolean {
  return (
    explicitPaths.has(path) ||
    ((path.startsWith(legacyTestPrefix) || path.startsWith(typedTestPrefix)) &&
      path.endsWith(".test.ts"))
  );
}
