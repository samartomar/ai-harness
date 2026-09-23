/** Inert retained backend-policy ownership shared by Vitest and CI. */
export const WORKBENCH_EXPLICIT_TEST_PATHS = [
  "tests/ecc/module-selection-closure.test.ts",
  "tests/org-policy/acceptance-hook-registrar.test.ts",
  "tests/org-policy/catalog-providers.test.ts",
  "tests/org-policy/bounded-github-skill-resolver.test.ts",
  "tests/org-policy/connected-github-skill-bridge.test.ts",
  "tests/internals/check-workbench-release-compatibility.test.ts",
  "tests/internals/workbench-publication-roundtrip.test.ts",
  "tests/internals/workbench-publication-installed-source.test.ts",
  "tests/org-policy/ecc-hook-controls.test.ts",
  "tests/org-policy/ecc-mcp-approval.test.ts",
  "tests/tools/packed-consumer.test.ts",
] as const;

const typedTestPrefix = "tests/org-policy/workbench/";
const explicitPaths = new Set<string>(WORKBENCH_EXPLICIT_TEST_PATHS);

export function isWorkbenchTestPath(path: string): boolean {
  return explicitPaths.has(path) || (path.startsWith(typedTestPrefix) && path.endsWith(".test.ts"));
}
