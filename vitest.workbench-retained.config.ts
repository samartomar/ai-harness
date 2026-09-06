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
    // Reserve one CPU for concurrent browser/setup work while retaining a four-worker ceiling.
    maxWorkers: Math.max(1, Math.min(4, availableParallelism() - 1)),
    include: [...WORKBENCH_RETAINED_TEST_PATTERNS],
    coverage: workbenchCoverage,
  },
});
