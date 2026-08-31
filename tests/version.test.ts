import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string };
const lock = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package-lock.json"), "utf8"),
) as { version: string; packages?: Record<string, { version?: string }> };

// The CLI reports VERSION from a hardcoded constant, separate from package.json. A release
// tags `v-core-X.Y.Z` and publishes the package's version — if the constant drifts, `aih --version`
// lies. Keep the two locked; the release workflow additionally asserts the tag matches.
describe("version coherence", () => {
  it("src/version.ts VERSION matches package.json version", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("package-lock root version matches package.json version", () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages?.[""]?.version).toBe(pkg.version);
  });
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("release-documentation surfaces", () => {
  it("keeps evergreen SVGs independent of the package manifest version", () => {
    for (const name of ["aih-overview.svg", "aih-command-lifecycle.svg", "aih-guide-map.svg"]) {
      const text = readFileSync(join(root, "docs", "assets", name), "utf8");
      expect(text, name).not.toContain(VERSION);
    }
  });

  it("support-policy claims name the promoted stable train rather than every latest minor", () => {
    for (const name of ["README.md", "SECURITY.md", "STABILITY.md"]) {
      const text = readFileSync(join(root, name), "utf8");
      expect(text).not.toMatch(/latest minor|latest-minor-only/iu);
      expect(text).toContain("promoted stable train");
    }
  });

  it("README does not duplicate the mutable current package version", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).not.toContain(`@aihq/core@${VERSION}`);
    expect(readme).not.toContain(`aih v${VERSION}`);
  });
});
