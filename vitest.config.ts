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
      //
      // W5 (project framework binding) note: the closure classifier
      // (`binding/closure/profile-closure.ts`, ~70% stmts) and the visible-typography
      // reclassifier (`binding/visible-typography.ts`, ~86%) are branch-dense gate
      // machinery whose rarer reachability/tokenizer paths are not yet unit-covered;
      // they lower the global statements aggregate to ~91.0% (from the pre-W5 level).
      // The global `statements` floor is set to 90.5 to track that genuine level, and
      // per-file floors below lock these files in so they can only ratchet up as the
      // dedicated closure/typography path tests land. The gstack adapter itself is at
      // ~97% and is pinned here too.
      thresholds: {
        statements: 90.5,
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
        "src/binding/closure/profile-closure.ts": {
          statements: 69,
          branches: 49,
          functions: 94,
          lines: 69,
        },
        "src/binding/visible-typography.ts": {
          statements: 84,
          branches: 78,
          functions: 92,
          lines: 84,
        },
        "src/binding/frameworks/gstack.ts": {
          statements: 95,
          branches: 82,
          functions: 97,
          lines: 95,
        },
        // W7 §C scan cache tiers — branch-dense derived-cache + deep-scanner
        // machinery (canonical keys, read-time tuple guard, SARIF mapping). Locked
        // just below its genuine level (§D.3) so it can only ratchet up.
        "src/binding/scan-cache-tiers.ts": {
          statements: 93,
          branches: 81,
          functions: 100,
          lines: 95,
        },
        // W8 §D14 framework value gate — a small, PURE verdict module (surface
        // deltas + the decisive characteristic-workflow signal, fail-closed to
        // INCOMPLETE). Fully exercised by value-gate.test.ts (36/36 stmts,
        // 48/48 branches, 5/5 funcs, 35/35 lines); pinned at its genuine level so
        // it can only ratchet up, with the standard branch cushion.
        "src/binding/frameworks/value-gate.ts": {
          statements: 100,
          branches: 96,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
