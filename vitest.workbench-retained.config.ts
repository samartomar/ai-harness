import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
import { WORKBENCH_RETAINED_TEST_PATTERNS } from "./src/internals/workbench-test-ownership.js";
import { testRuntimeForPlatform } from "./vitest.config.js";
import { workbenchCoverage } from "./vitest.workbench.config.js";

const testRuntime = testRuntimeForPlatform(process.platform, availableParallelism());

/** Keeps two CPUs free for concurrent Chromium setup and browser processes. */
export function workbenchRetainedWorkersForParallelAcceptance(parallelism: number): number {
  return Math.max(1, Math.min(4, parallelism - 2));
}

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./tests/setup-git-env.ts"],
    ...testRuntime,
    // Chromium and retained coverage run concurrently in the PR lane.
    maxWorkers: workbenchRetainedWorkersForParallelAcceptance(availableParallelism()),
    include: [...WORKBENCH_RETAINED_TEST_PATTERNS],
    coverage: workbenchCoverage,
  },
});
