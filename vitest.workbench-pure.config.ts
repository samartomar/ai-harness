import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./tests/setup-git-env.ts"],
    include: ["tests/org-policy/workbench/**/*.test.ts"],
    exclude: [
      "tests/org-policy/workbench/compilers/**",
      "tests/org-policy/workbench/catalog-bundle.test.ts",
      "tests/org-policy/workbench/prepared-catalog.test.ts",
      "tests/org-policy/workbench/core/**",
      "tests/org-policy/workbench/policy-consumption.test.ts",
    ],
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
