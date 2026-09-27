/** Inert retained backend-policy ownership shared by Vitest and CI. */
export const WORKBENCH_EXPLICIT_TEST_PATHS = [
  "tests/ecc/module-selection-closure.test.ts",
  "tests/org-policy/acceptance-hook-registrar.test.ts",
  "tests/org-policy/ecc-hook-controls.test.ts",
  "tests/org-policy/ecc-mcp-approval.test.ts",
  "tests/tools/packed-consumer.test.ts",
] as const;

const typedTestPrefix = "tests/org-policy/workbench/";
const explicitPaths = new Set<string>(WORKBENCH_EXPLICIT_TEST_PATHS);

export function isWorkbenchTestPath(path: string): boolean {
  return explicitPaths.has(path) || (path.startsWith(typedTestPrefix) && path.endsWith(".test.ts"));
}
