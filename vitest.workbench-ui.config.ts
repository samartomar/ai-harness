import { defineConfig } from "vitest/config";

/** Component tests of the Policy Workbench UI (workbench-ui/). Role-based, in happy-dom. */
export default defineConfig({
  test: {
    globals: false,
    environment: "happy-dom",
    include: ["workbench-ui/tests/**/*.test.{ts,tsx}"],
    maxWorkers: 2,
    execArgv: [],
  },
});
