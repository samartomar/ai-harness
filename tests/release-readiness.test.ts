import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("release readiness metadata", () => {
  it("declares npm package provenance metadata used by enterprise buyers", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/samartomar/ai-harness.git",
    });
    expect(pkg.homepage).toBe("https://github.com/samartomar/ai-harness#readme");
    expect(pkg.bugs).toEqual({ url: "https://github.com/samartomar/ai-harness/issues" });
    expect(pkg.publishConfig).toMatchObject({ access: "public" });
  });

  it("names release SBOM artifacts by their actual format", () => {
    const release = read(".github/workflows/release.yml");
    expect(release).toContain("SPDX SBOM");
    expect(release).not.toContain("CycloneDX SBOM");
    expect(release).toContain("format: spdx-json");
  });

  it("publishes through npm trusted publishing instead of a long-lived token", () => {
    const release = read(".github/workflows/release.yml");
    expect(release).toContain("environment:");
    expect(release).toContain("name: npm-publish");
    expect(release).toMatch(/id-token:\s*write/);
    expect(release).toContain('registry-url: "https://registry.npmjs.org"');
    expect(release).toContain("npm publish ./*.tgz --provenance --access public");
    expect(release).not.toContain("NPM_TOKEN");
    expect(release).not.toContain("NODE_AUTH_TOKEN");
  });

  it("ships basic repository governance files for controlled rollout", () => {
    expect(existsSync(join(root, ".github", "CODEOWNERS"))).toBe(true);
    expect(existsSync(join(root, "DCO.md"))).toBe(true);
    expect(existsSync(join(root, "TRADEMARKS.md"))).toBe(true);
    // The contract tests' drift guidance points breaking changes at STABILITY.md —
    // the v1 stability contract must exist for those messages to mean anything.
    expect(existsSync(join(root, "STABILITY.md"))).toBe(true);
  });
});
