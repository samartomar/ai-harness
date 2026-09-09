import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
import { WORKBENCH_RETAINED_TEST_PATTERNS } from "./src/internals/workbench-test-ownership.js";
import { testRuntimeForPlatform } from "./vitest.config.js";
import { workbenchCoverage } from "./vitest.workbench.config.js";

const testRuntime = testRuntimeForPlatform(process.platform, availableParallelism());

/** Bound CPU work without leaving the four-core runner serial after Chromium exits. */
export function workbenchRetainedWorkersForParallelAcceptance(parallelism: number): number {
  return Math.max(1, Math.min(4, parallelism));
}

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    // Each file keeps a fresh Worker and module environment without fork IPC.
    pool: "threads",
    isolate: true,
    setupFiles: ["./tests/setup-git-env.ts"],
    ...testRuntime,
    // Chromium and retained coverage run concurrently in the PR lane.
    maxWorkers: workbenchRetainedWorkersForParallelAcceptance(availableParallelism()),
    include: [...WORKBENCH_RETAINED_TEST_PATTERNS],
    coverage: workbenchCoverage,
  },
});
