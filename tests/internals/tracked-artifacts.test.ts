import { describe, expect, it } from "vitest";
import {
  findTrackedArtifactViolations,
  formatTrackedArtifactViolations,
} from "../../src/internals/tracked-artifacts.js";

describe("tracked artifact guard", () => {
  it("flags generated dependency, build, coverage, and TypeScript cache paths", () => {
    const violations = findTrackedArtifactViolations([
      "src/index.ts",
      "node_modules/typescript/package.json",
      "dist/index.js",
      "coverage/lcov.info",
      "tsconfig.tsbuildinfo",
      "packages/app/tsconfig.tsbuildinfo",
    ]);

    expect(violations.map((v) => v.path)).toEqual([
      "node_modules/typescript/package.json",
      "dist/index.js",
      "coverage/lcov.info",
      "tsconfig.tsbuildinfo",
      "packages/app/tsconfig.tsbuildinfo",
    ]);
  });

  it("forbids any tracked file under .aih, including the retired usage recorder", () => {
    const violations = findTrackedArtifactViolations([
      ".aih/usage-record.mjs",
      ".aih/report.html",
      ".aih/history/events.jsonl",
    ]);

    expect(violations.map((v) => v.path)).toEqual([
      ".aih/usage-record.mjs",
      ".aih/report.html",
      ".aih/history/events.jsonl",
    ]);
  });

  it("normalizes Windows path separators before matching", () => {
    const violations = findTrackedArtifactViolations([
      "node_modules\\typescript\\package.json",
      ".aih\\usage-record.mjs",
      ".aih\\scratch\\report.html",
    ]);

    expect(violations.map((v) => v.path)).toEqual([
      "node_modules/typescript/package.json",
      ".aih/usage-record.mjs",
      ".aih/scratch/report.html",
    ]);
  });

  it("formats an actionable failure message with index-only cleanup guidance", () => {
    const message = formatTrackedArtifactViolations(
      findTrackedArtifactViolations(["node_modules/typescript/package.json", ".aih/report.html"]),
    );

    expect(message).toContain("Tracked generated artifacts are forbidden");
    expect(message).toContain("node_modules/typescript/package.json");
    expect(message).toContain(".aih/report.html");
    expect(message).toContain("git rm --cached");
    expect(message).toContain("index only");
  });
});
