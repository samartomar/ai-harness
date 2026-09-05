import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./tests/setup-git-env.ts"],
    include: [
      "tests/org-policy/workbench/compilers/**/*.test.ts",
      "tests/org-policy/workbench/catalog-bundle.test.ts",
      "tests/org-policy/workbench/prepared-catalog.test.ts",
      "tests/org-policy/workbench/core/**/*.test.ts",
      "tests/org-policy/workbench/policy-consumption.test.ts",
    ],
    maxWorkers: 2,
    execArgv: [],
  },
});
