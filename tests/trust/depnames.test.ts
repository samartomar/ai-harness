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

function lockfile(): void {
  write("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: {} }));
}

describe("resolveInternalScopes", () => {
  it("normalizes comma-separated env scopes and defaults empty", () => {
    expect(resolveInternalScopes({ env: {} })).toEqual([]);
    expect(
      resolveInternalScopes({ env: { AIH_TRUST_INTERNAL_SCOPES: "acme, @internal ,,tools" } }),
    ).toEqual(["@acme", "@internal", "@tools"]);
  });

  it("unions env scopes with org-policy trust.internalScopes", () => {
    write(
      "aih-org-policy.json",
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "team",
        references: { repoContract: "ai-coding/project.json" },
        trust: { internalScopes: ["policy", "@shared"] },
      }),
    );

    expect(
      resolveInternalScopes({
        root: dir,
        env: { AIH_TRUST_INTERNAL_SCOPES: "envscope,@shared" },
      }),
    ).toEqual(["@envscope", "@policy", "@shared"]);
  });
});

describe("scanTrustDependencyNames", () => {
  it("flags direct dependencies under configured internal scopes", () => {
    pkg({ "@acme/widget": "1.0.0" });
    lockfile();

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
    lockfile();

    expect(scanTrustDependencyNames(dir, [])).toEqual([]);
  });

  it("flags distance-one popular package typos", () => {
    lockfile();
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

  it("flags scoped package typos when the scope matches a popular scoped package", () => {
    pkg({ "@types/nod": "1.0.0" });
    lockfile();

    expect(scanTrustDependencyNames(dir, [])).toEqual([
      expect.objectContaining({
        verdict: "fail",
        code: "trust.typosquat",
        detail: expect.stringContaining("@types/node"),
        location: expect.objectContaining({ uri: "package.json" }),
      }),
    ]);
  });

  it("does not flag exact popular names or distance-two names", () => {
    pkg({ react: "18.0.0", rxect: "1.0.0", "@types/node": "26.0.0" });
    lockfile();

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

  it("grades floating direct dependency specs by posture", () => {
    lockfile();
    write(
      "package.json",
      JSON.stringify({
        dependencies: {
          caret: "^1.2.3",
          exact: "1.2.3",
          floating: "*",
          latest: "latest",
          gitLoose: "git+https://github.com/acme/tool.git",
          gitPinned: `git+https://github.com/acme/tool.git#${"a".repeat(40)}`,
        },
      }),
    );

    const vibe = scanTrustDependencyNames(dir, [], "vibe").filter(
      (check) => check.name === "trust.unpinned-dependency",
    );
    expect(vibe).toHaveLength(4);
    expect(vibe.every((check) => check.verdict === "pass")).toBe(true);
    expect(vibe.every((check) => check.code === undefined)).toBe(true);
    expect(vibe.map((check) => check.detail ?? "").join("\n")).toContain(
      "warning-only (vibe posture)",
    );
    expect(vibe.map((check) => check.detail ?? "").join("\n")).not.toContain("exact");
    expect(vibe.map((check) => check.detail ?? "").join("\n")).not.toContain("gitPinned");

    const enterprise = scanTrustDependencyNames(dir, [], "enterprise").filter(
      (check) => check.code === "trust.unpinned-dependency",
    );
    expect(enterprise).toHaveLength(4);
    expect(enterprise.every((check) => check.verdict === "fail")).toBe(true);
  });

  it("flags dependencies declared without any lockfile in the trust source", () => {
    pkg({ react: "18.0.0" });

    expect(scanTrustDependencyNames(dir, [], "enterprise")).toEqual([
      expect.objectContaining({
        verdict: "fail",
        code: "trust.unpinned-dependency",
        detail: expect.stringContaining("no lockfile"),
        location: expect.objectContaining({ uri: "package.json" }),
      }),
    ]);

    lockfile();

    expect(scanTrustDependencyNames(dir, [], "enterprise")).toEqual([]);
  });
});
