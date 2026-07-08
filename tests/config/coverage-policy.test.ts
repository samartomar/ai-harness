import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import vitestConfig from "../../vitest.config.js";

interface CoverageShape {
  include?: string[];
  exclude?: string[];
  thresholds?: Record<string, unknown>;
}

const minimumGlobalThresholds = {
  statements: 91,
  branches: 78,
  functions: 94,
  lines: 92,
} as const;

const minimumScopedThresholds = {
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
} as const;

function coverageConfig(): CoverageShape {
  const config = vitestConfig as { test?: { coverage?: CoverageShape } };
  return config.test?.coverage ?? {};
}

function numericMetric(thresholds: Record<string, unknown>, metric: string): number {
  const value = thresholds[metric];
  if (typeof value !== "number") {
    throw new Error(`missing numeric coverage threshold for ${metric}`);
  }
  return value;
}

function thresholdBlock(thresholds: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = thresholds[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`missing coverage threshold block for ${key}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Guards the coverage gate itself (AIH-TEST-001): if a future change silently drops
 * the Vitest coverage thresholds, the gate becomes decorative. These assertions
 * inspect the active config object, not comments or inert source text.
 */
describe("coverage policy", () => {
  const coverage = coverageConfig();
  const thresholds = coverage.thresholds ?? {};

  it("covers source files with the expected explicit exclusions", () => {
    expect(coverage.include).toEqual(["src/**/*.ts"]);
    expect(coverage.exclude).toEqual(["src/**/command.ts", "src/cli.ts", "**/*.d.ts"]);
  });

  it("enforces all four global coverage metrics at or above the ratchet floors", () => {
    for (const [metric, minimum] of Object.entries(minimumGlobalThresholds)) {
      expect(numericMetric(thresholds, metric)).toBeGreaterThanOrEqual(minimum);
    }
  });

  it("keeps high-risk source files under scoped coverage floors", () => {
    for (const [file, expected] of Object.entries(minimumScopedThresholds)) {
      const scoped = thresholdBlock(thresholds, file);
      for (const [metric, minimum] of Object.entries(expected)) {
        expect(numericMetric(scoped, metric)).toBeGreaterThanOrEqual(minimum);
      }
    }
  });

  it("runs the published dist CLI smoke after build in verify", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      main?: string;
      types?: string;
      exports?: Record<string, unknown>;
      scripts?: Record<string, string>;
    };

    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.types).toBe("./dist/index.d.ts");
    expect(pkg.exports?.["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(pkg.scripts?.["check:published-bin"]).toBe(
      "node dist/cli.js --version && node dist/cli.js --help",
    );
    expect(pkg.scripts?.["check:published-library"]).toContain("import('@aihq/harness')");
    expect(pkg.scripts?.verify).toContain(
      "npm run test:cov && npm run build && npm run check:published-bin && npm run check:published-library",
    );
  });
});
