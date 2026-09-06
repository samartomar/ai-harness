import { defineConfig } from "vitest/config";
import { WORKBENCH_CONTRACT_TEST_PATTERNS } from "./src/internals/workbench-test-ownership.js";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./tests/setup-git-env.ts"],
    include: [...WORKBENCH_CONTRACT_TEST_PATTERNS],
    maxWorkers: 2,
    execArgv: [],
  },
});
