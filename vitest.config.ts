import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/command.ts", "src/cli.ts", "**/*.d.ts"],
      // Enforced floor: set just below the current achieved levels so coverage can
      // only ratchet UP — CI/release fail on regression. Goal: raise branches → 80%
      // (the stated bar) as the branch-heavy safety paths gain tests.
      thresholds: {
        statements: 88,
        branches: 75,
        functions: 90,
        lines: 90,
      },
    },
  },
});
