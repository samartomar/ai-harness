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
    // Two Vitest workers leave CPU capacity for simultaneous Chromium and fixture preparation on four-core runners.
    maxWorkers: Math.min(2, availableParallelism()),
    include: [...WORKBENCH_RETAINED_TEST_PATTERNS],
    coverage: workbenchCoverage,
  },
});
