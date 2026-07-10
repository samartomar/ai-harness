import { readdirSync, readFileSync } from "node:fs";
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
// tags `vX.Y.Z` and publishes the package's version — if the constant drifts, `aih --version`
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

// Versioned marketing surfaces ship in the npm tarball (`docs/assets` is in package.json
// `files`). Stale v2.4.3 SVG wording shipped inside the v2.5.0 tarball; this lock makes
// surface drift fail `npm run verify` before any tag exists (RELEASING.md step 5).
describe("versioned surfaces", () => {
  it("docs/assets SVGs carry no version string other than VERSION", () => {
    const assetsDir = join(root, "docs", "assets");
    for (const name of readdirSync(assetsDir).filter((f) => f.endsWith(".svg"))) {
      const text = readFileSync(join(assetsDir, name), "utf8");
      for (const match of text.match(/\d+\.\d+\.\d+/g) ?? []) {
        expect(`${name}: ${match}`).toBe(`${name}: ${VERSION}`);
      }
    }
  });

  it("README 'aih vX.Y.Z' claims match VERSION", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    for (const match of readme.match(/\baih v\d+\.\d+\.\d+/g) ?? []) {
      expect(match).toBe(`aih v${VERSION}`);
    }
  });
});
