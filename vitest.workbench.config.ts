import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
import { WORKBENCH_TEST_PATTERNS } from "./src/internals/workbench-test-ownership.js";
import { testRuntimeForPlatform } from "./vitest.config.js";

export { WORKBENCH_TEST_PATTERNS } from "./src/internals/workbench-test-ownership.js";

const testRuntime = testRuntimeForPlatform(process.platform, availableParallelism());

/** Shared by complete standalone and PR-retained coverage projects. */
export const workbenchCoverage = {
  provider: "v8" as const,
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
};

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./tests/setup-git-env.ts"],
    ...testRuntime,
    include: [...WORKBENCH_TEST_PATTERNS],
    coverage: workbenchCoverage,
  },
});
