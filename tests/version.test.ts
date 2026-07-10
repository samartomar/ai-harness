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
    // Two-segment forms (v2.4, "2.4 AI-Canonical") escaped the original three-segment
    // pattern and shipped stale in the v2.6.0 tarball. Scan rendered text content only
    // (attribute numerics like font-size="12.5" are not version claims); historical
    // journey markers and the license id are the only tokens allowed besides VERSION.
    const allowed = new Set([VERSION, `v${VERSION}`, "0.2", "0.4", "1.0", "v1.0", "2.1"]);
    for (const name of readdirSync(assetsDir).filter((f) => f.endsWith(".svg"))) {
      const text = readFileSync(join(assetsDir, name), "utf8").replace(
        /<style[\s\S]*?<\/style>/g,
        "",
      );
      for (const chunk of text.match(/>[^<>]+</g) ?? []) {
        for (const match of chunk.matchAll(/\bv?\d+\.\d+(?:\.\d+|\.x)?\b/g)) {
          const token = match[0];
          if (chunk.startsWith("Apache-", (match.index ?? 0) - "Apache-".length)) continue;
          if (allowed.has(token)) continue;
          expect(`${name}: ${token}`).toBe(`${name}: ${VERSION}`);
        }
      }
    }
  });

  it("support-policy claims match VERSIONING.md (latest-minor-only)", () => {
    for (const name of ["README.md", "SECURITY.md", "STABILITY.md"]) {
      const text = readFileSync(join(root, name), "utf8");
      expect(`${name} claims N-1 support: ${/previous minor|\(N-1\)/.test(text)}`).toBe(
        `${name} claims N-1 support: false`,
      );
    }
  });

  it("README 'aih vX.Y.Z' claims match VERSION", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    for (const match of readme.match(/\baih v\d+\.\d+\.\d+/g) ?? []) {
      expect(match).toBe(`aih v${VERSION}`);
    }
  });
});
