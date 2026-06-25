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
      // only ratchet UP — CI/release fail on regression. Branches are at ~79%; the
      // remaining gap to the 80% bar is concentrated in doctor.ts (verification
      // command) — raise this to 80 as that path gains dedicated tests.
      thresholds: {
        statements: 91,
        branches: 78,
        functions: 94,
        lines: 92,
      },
    },
  },
});
