import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInternalScopes, scanTrustDependencyNames } from "../../src/trust/depnames.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-trust-deps-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function pkg(deps: Record<string, string>): void {
  write("package.json", JSON.stringify({ dependencies: deps }));
}

describe("resolveInternalScopes", () => {
  it("normalizes comma-separated env scopes and defaults empty", () => {
    expect(resolveInternalScopes({ env: {} })).toEqual([]);
    expect(
      resolveInternalScopes({ env: { AIH_TRUST_INTERNAL_SCOPES: "acme, @internal ,,tools" } }),
    ).toEqual(["@acme", "@internal", "@tools"]);
  });
});

describe("scanTrustDependencyNames", () => {
  it("flags direct dependencies under configured internal scopes", () => {
    pkg({ "@acme/widget": "1.0.0" });

    const checks = scanTrustDependencyNames(dir, ["@acme"]);

    expect(checks).toEqual([
      expect.objectContaining({
        verdict: "fail",
        code: "trust.dependency-confusion",
        location: expect.objectContaining({ uri: "package.json" }),
        fingerprint: expect.stringMatching(/^trust-dependency-confusion:/),
      }),
    ]);
  });

  it("does not flag internal-looking scopes when env scopes are unset", () => {
    pkg({ "@acme/widget": "1.0.0" });

    expect(scanTrustDependencyNames(dir, [])).toEqual([]);
  });

  it("flags distance-one popular package typos", () => {
    write(
      "package.json",
      JSON.stringify({
        dependencies: { reqeusts: "1.0.0" },
        devDependencies: { expresss: "1.0.0" },
      }),
    );

    expect(scanTrustDependencyNames(dir, []).map((check) => check.code)).toEqual([
      "trust.typosquat",
      "trust.typosquat",
    ]);
  });

  it("does not flag exact popular names or distance-two names", () => {
    pkg({ react: "18.0.0", "dist-2": "1.0.0" });

    expect(scanTrustDependencyNames(dir, [])).toEqual([]);
  });

  it("does not scan transitive lockfile packages", () => {
    write("package.json", JSON.stringify({ dependencies: { react: "18.0.0" } }));
    write(
      "package-lock.json",
      JSON.stringify({ packages: { "node_modules/expresss": { version: "1.0.0" } } }),
    );

    expect(scanTrustDependencyNames(dir, [])).toEqual([]);
  });
});
