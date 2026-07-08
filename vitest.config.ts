import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      // lcov feeds the Codecov upload in CI; text/html stay for humans.
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/command.ts", "src/cli.ts", "**/*.d.ts"],
      // Enforced floor: set just below the current achieved levels so coverage can
      // only ratchet UP — CI/release fail on regression. Branches are at ~79%; the
      // remaining gap to the 80% bar is concentrated in doctor.ts (verification
      // command) — raise this to 80 as that path gains dedicated tests.
      thresholds: {
        statements: 91,
        branches: 78,
        functions: 94,
        lines: 92,
        "src/internals/execute.ts": {
          statements: 92,
          branches: 80,
          functions: 95,
          lines: 94,
        },
        "src/trust/scan.ts": {
          statements: 90,
          branches: 80,
          functions: 95,
          lines: 94,
        },
        "src/workspace/acquire.ts": {
          statements: 88,
          branches: 75,
          functions: 90,
          lines: 90,
        },
        "src/verification/pipeline.ts": {
          statements: 85,
          branches: 78,
          functions: 100,
          lines: 88,
        },
      },
    },
  },
});
