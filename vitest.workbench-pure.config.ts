import { defineConfig } from "vitest/config";
import {
  WORKBENCH_PURE_TEST_EXCLUDE_PATTERNS,
  WORKBENCH_PURE_TEST_PATTERNS,
} from "./src/internals/workbench-test-ownership.js";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./tests/setup-git-env.ts"],
    include: [...WORKBENCH_PURE_TEST_PATTERNS],
    exclude: [...WORKBENCH_PURE_TEST_EXCLUDE_PATTERNS],
    maxWorkers: 2,
    execArgv: [],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/workbench-pure",
      reporter: ["text", "json-summary", "lcov"],
      include: [
        "src/org-policy/workbench/contracts.ts",
        "src/org-policy/workbench/schema-validation.ts",
        "src/org-policy/workbench/authoring-sources.ts",
        "src/org-policy/workbench/command-arguments.ts",
        "src/org-policy/workbench/selection-engine.ts",
        "src/org-policy/workbench/compile-policy.ts",
        "src/org-policy/workbench/policy-import.ts",
      ],
      exclude: ["src/org-policy/workbench/ui/**", "**/*.d.ts"],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
});
