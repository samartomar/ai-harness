import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
import fullConfig, { testRuntimeForPlatform } from "./vitest.config.js";
import { WORKBENCH_TEST_PATTERNS } from "./vitest.workbench.config.js";

const testRuntime = testRuntimeForPlatform(process.platform, availableParallelism());
const fullCoverage = (fullConfig as { test?: { coverage?: Record<string, unknown> } }).test
  ?.coverage;

if (fullCoverage === undefined) throw new Error("full Vitest coverage configuration is missing");

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./tests/setup-git-env.ts"],
    ...testRuntime,
    include: ["tests/**/*.test.ts"],
    exclude: [...WORKBENCH_TEST_PATTERNS],
    coverage: {
      ...fullCoverage,
      reportsDirectory: "coverage/core",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/command.ts",
        "src/cli.ts",
        "src/ecc-runtime.ts",
        "**/*.d.ts",
        "src/org-policy/adoption-recipe.ts",
        "src/org-policy/generate.ts",
        "src/org-policy/studio-*.ts",
        "src/org-policy/ui-server.ts",
      ],
      thresholds: {
        ...(fullCoverage.thresholds as Record<string, unknown>),
        // Independently ratcheted from the measured non-Workbench baseline.
        statements: 90,
        branches: 83,
        functions: 96,
        lines: 92.5,
      },
    },
  },
});
