import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
import { testRuntimeForPlatform } from "./vitest.config.js";

export const WORKBENCH_TEST_PATTERNS = [
  "tests/ecc/module-selection-closure.test.ts",
  "tests/org-policy/acceptance-hook-registrar.test.ts",
  "tests/org-policy/admin-baseline-evidence-cli-route.test.ts",
  "tests/org-policy/admin-catalog-cli-route.test.ts",
  "tests/org-policy/admin-catalog-fetch-v1.test.ts",
  "tests/org-policy/ecc-hook-controls.test.ts",
  "tests/org-policy/ecc-mcp-approval.test.ts",
  "tests/org-policy/generate.test.ts",
  "tests/org-policy/packed-workbench-cleanup.test.ts",
  "tests/org-policy/studio-*.test.ts",
  "tests/org-policy/supported-cli-subsets.test.ts",
  "tests/org-policy/ui-server.test.ts",
] as const;

const testRuntime = testRuntimeForPlatform(process.platform, availableParallelism());

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./tests/setup-git-env.ts"],
    ...testRuntime,
    include: [...WORKBENCH_TEST_PATTERNS],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/workbench",
      reporter: ["text", "html", "lcov"],
      include: [
        "src/org-policy/adoption-recipe.ts",
        "src/org-policy/generate.ts",
        "src/org-policy/studio-*.ts",
        "src/org-policy/ui-server.ts",
      ],
      thresholds: {
        // Independently ratcheted from the measured Workbench baseline. These
        // floors preserve the current lane's real coverage with a sub-point
        // instrumentation cushion; they are not derived from the Core gate.
        statements: 89,
        branches: 80,
        functions: 94,
        lines: 92,
      },
    },
  },
});
