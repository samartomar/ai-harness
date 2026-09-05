import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
import { WORKBENCH_RETAINED_TEST_PATTERNS } from "./src/internals/workbench-test-ownership.js";
import { testRuntimeForPlatform } from "./vitest.config.js";
import { workbenchCoverage } from "./vitest.workbench.config.js";

const testRuntime = testRuntimeForPlatform(process.platform, availableParallelism());

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./tests/setup-git-env.ts"],
    ...testRuntime,
    // The PR acceptance project shares the four-core hosted runner with Chromium.
    // Use the available fourth core while retaining the fixed upper bound.
    maxWorkers: Math.min(4, availableParallelism()),
    include: [...WORKBENCH_RETAINED_TEST_PATTERNS],
    coverage: workbenchCoverage,
  },
});
