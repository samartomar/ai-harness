import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeNativeDetectorDigest,
  discoverNativeDetectorSourceFiles,
  NATIVE_DETECTOR_DIGEST,
  NATIVE_DETECTOR_SOURCES,
  nativeAnalyzerIdentity,
} from "../../src/baseline-evidence/native-identity.js";
import { checkNativeIdentityDrift } from "../../src/internals/check-native-identity.js";

const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-native-identity-"));
  roots.push(root);
  return root;
}

function writeDeclaredFixture(
  root: string,
  files: Record<string, string> = {
    "src/trust/lint.ts": "export const a = 1;\n",
    "src/trust/detectors.ts": "export const b = 2;\n",
    "src/secrets/scan.ts": "export const c = 3;\n",
    "src/skill/license.ts": "export const d = 4;\n",
    "src/config/posture.ts": "export const e = 5;\n",
  },
): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, ...rel.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("discoverNativeDetectorSourceFiles", () => {
  it("walks the declared closure and returns a sorted, deduplicated relative file list", () => {
    const root = fixtureRoot();
    writeDeclaredFixture(root);
    const files = discoverNativeDetectorSourceFiles(root);
    expect(files).toEqual([
      "src/config/posture.ts",
      "src/secrets/scan.ts",
      "src/skill/license.ts",
      "src/trust/detectors.ts",
      "src/trust/lint.ts",
    ]);
  });

  it("picks up a newly added file under a declared directory glob", () => {
    const root = fixtureRoot();
    writeDeclaredFixture(root);
    writeFileSync(join(root, "src", "trust", "new-detector.ts"), "export const n = 1;\n");
    expect(discoverNativeDetectorSourceFiles(root)).toContain("src/trust/new-detector.ts");
  });

  it("excludes a symlink from the closure even when it points at a declared .ts file", () => {
    const root = fixtureRoot();
    writeDeclaredFixture(root);
    const real = join(root, "src", "trust", "lint.ts");
    const linked = join(root, "src", "trust", "linked.ts");
    symlinkSync(real, linked);
    const files = discoverNativeDetectorSourceFiles(root);
    expect(files).toContain("src/trust/lint.ts");
    expect(files).not.toContain("src/trust/linked.ts");
  });

  it("ignores non-.ts files and files outside the declared closure", () => {
    const root = fixtureRoot();
    writeDeclaredFixture(root);
    writeFileSync(join(root, "src", "trust", "README.md"), "# not a source file\n");
    mkdirSync(join(root, "src", "baseline-evidence"), { recursive: true });
    writeFileSync(join(root, "src", "baseline-evidence", "vet.ts"), "export const outside = 1;\n");
    writeFileSync(
      join(root, "src", "baseline-evidence", "hash.ts"),
      "export const alsoOutside = 1;\n",
    );
    const files = discoverNativeDetectorSourceFiles(root);
    expect(files).not.toContain("src/trust/README.md");
    expect(files).not.toContain("src/baseline-evidence/vet.ts");
    expect(files).not.toContain("src/baseline-evidence/hash.ts");
  });
});

describe("computeNativeDetectorDigest", () => {
  it("produces the identical 12-hex digest for identical declared-closure bytes", () => {
    const rootA = fixtureRoot();
    const rootB = fixtureRoot();
    writeDeclaredFixture(rootA);
    writeDeclaredFixture(rootB);
    const digestA = computeNativeDetectorDigest(rootA);
    const digestB = computeNativeDetectorDigest(rootB);
    expect(digestA).toBe(digestB);
    expect(digestA).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes the digest when a single byte in one declared file changes", () => {
    const root = fixtureRoot();
    writeDeclaredFixture(root);
    const before = computeNativeDetectorDigest(root);
    writeFileSync(join(root, "src", "trust", "lint.ts"), "export const a = 2;\n");
    const after = computeNativeDetectorDigest(root);
    expect(after).not.toBe(before);
  });

  it("is order-independent: file discovery order never changes the digest", () => {
    const root = fixtureRoot();
    writeDeclaredFixture(root, {
      "src/trust/zzz.ts": "export const z = 1;\n",
      "src/trust/aaa.ts": "export const a = 1;\n",
    });
    // Two independent recomputes over the same bytes must agree regardless of
    // filesystem readdir ordering.
    expect(computeNativeDetectorDigest(root)).toBe(computeNativeDetectorDigest(root));
  });
});

describe("nativeAnalyzerIdentity", () => {
  it("renders the digest-only format native.<12hex> with no package-version component", () => {
    expect(nativeAnalyzerIdentity()).toBe(`native.${NATIVE_DETECTOR_DIGEST}`);
    expect(nativeAnalyzerIdentity()).toMatch(/^native\.[0-9a-f]{12}$/);
  });
});

describe("checkNativeIdentityDrift (stale-constant gate)", () => {
  it("reports ok when the committed constants match the live repository tree", () => {
    const report = checkNativeIdentityDrift();
    expect(report).toEqual({
      ok: true,
      addedSources: [],
      removedSources: [],
      digestDrift: false,
      currentDigest: NATIVE_DETECTOR_DIGEST,
    });
    expect(NATIVE_DETECTOR_SOURCES.length).toBeGreaterThan(0);
  });

  it("fails when the committed digest no longer matches a recomputed fixture tree", () => {
    const root = fixtureRoot();
    writeDeclaredFixture(root, { "src/trust/lint.ts": "export const drifted = true;\n" });
    const report = checkNativeIdentityDrift(root);
    expect(report.ok).toBe(false);
    expect(report.digestDrift).toBe(true);
  });

  it("fails and names an added file when a fixture tree has a source outside the committed list", () => {
    const root = fixtureRoot();
    writeDeclaredFixture(root);
    writeFileSync(join(root, "src", "trust", "new-detector.ts"), "export const n = 1;\n");
    const report = checkNativeIdentityDrift(root);
    expect(report.ok).toBe(false);
    expect(report.addedSources).toContain("src/trust/new-detector.ts");
  });
});
