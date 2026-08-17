import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenizer } from "acorn";
import { describe, expect, it } from "vitest";
import {
  canonicalScannerManifestBytesV1,
  canonicalScannerManifestSha256V1,
  createScannerManifestV1,
  parseScannerManifestV1Json,
} from "../../src/observation/scanner-manifest-v1.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function manifestInput() {
  return {
    protocol: "ScannerManifestV1" as const,
    detectors: [
      {
        detectorId: "detector.dependency-audit",
        analyzerIdentity: "native.0123456789ab",
        ociImage: {
          reference:
            "registry.example.invalid/aih/dependency-audit@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sha256: "a".repeat(64),
        },
        adapter: { identity: "adapter.0123456789ab", sha256: sha256("dependency adapter") },
        observationConfigurationSha256: sha256("dependency configuration"),
        executionProfileSha256: sha256("dependency execution profile"),
        supportedPlatforms: [
          { os: "linux", architecture: "amd64" },
          { os: "linux", architecture: "arm64" },
        ],
        sbom: {
          mediaType: "application/spdx+json",
          sha256: sha256("dependency sbom descriptor"),
        },
        provenance: {
          mediaType: "application/vnd.in-toto+json",
          sha256: sha256("dependency provenance descriptor"),
        },
      },
      {
        detectorId: "detector.secret-audit",
        analyzerIdentity: "native.fedcba987654",
        ociImage: {
          reference:
            "registry.example.invalid/aih/secret-audit@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          sha256: "b".repeat(64),
        },
        adapter: { identity: "adapter.fedcba987654", sha256: sha256("secret adapter") },
        observationConfigurationSha256: sha256("secret configuration"),
        executionProfileSha256: sha256("secret execution profile"),
        supportedPlatforms: [{ os: "darwin", architecture: "arm64" }],
        sbom: { mediaType: "application/spdx+json", sha256: sha256("secret sbom descriptor") },
        provenance: {
          mediaType: "application/vnd.in-toto+json",
          sha256: sha256("secret provenance descriptor"),
        },
      },
    ],
  };
}

function expectExactKeys(value: object, keys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

function mustGet<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`expected test fixture entry ${String(index)}`);
  return value;
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function sourceFiles(rel = "src"): string[] {
  const absolute = join(repoRoot(), ...rel.split("/"));
  const files: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...sourceFiles(child));
    else if (entry.isFile() && child.endsWith(".ts")) files.push(child);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function moduleSpecifiers(rel: string): string[] {
  const text = readFileSync(join(repoRoot(), ...rel.split("/")), "utf8");
  const tokens: Array<{ label: string; value: unknown }> = [];
  const scan = tokenizer(text, { ecmaVersion: "latest", sourceType: "module" });
  for (;;) {
    const token = scan.getToken();
    tokens.push({ label: token.type.label, value: (token as { value?: unknown }).value });
    if (token.type.label === "eof") break;
  }
  const stringAt = (index: number): string | undefined => {
    const token = tokens[index];
    return token?.label === "string" && typeof token.value === "string" ? token.value : undefined;
  };
  const fromAt = (start: number): string | undefined => {
    for (let index = start; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === undefined || token.label === ";" || token.label === "eof") return undefined;
      if (token.label === "name" && token.value === "from") return stringAt(index + 1);
    }
    return undefined;
  };
  const specifiers: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.label === "import") {
      const direct = stringAt(index + 1);
      const dynamic = tokens[index + 1]?.label === "(" ? stringAt(index + 2) : undefined;
      const from = fromAt(index + 1);
      if (direct !== undefined) specifiers.push(direct);
      if (dynamic !== undefined) specifiers.push(dynamic);
      if (from !== undefined) specifiers.push(from);
    }
    if (token?.label === "export") {
      const from = fromAt(index + 1);
      if (from !== undefined) specifiers.push(from);
    }
    if (token?.label === "name" && token.value === "require" && tokens[index + 1]?.label === "(") {
      const required = stringAt(index + 2);
      if (required !== undefined) specifiers.push(required);
    }
  }
  return specifiers;
}

describe("ScannerManifestV1", () => {
  it("binds immutable per-detector OCI, adapter, configuration, platform, SBOM, and provenance identities", () => {
    const input = manifestInput();
    const firstInput = mustGet(input.detectors, 0);
    const forward = createScannerManifestV1(input);
    const reverse = createScannerManifestV1({
      ...input,
      detectors: [...input.detectors].reverse(),
    });
    const detector = forward.detectors[0];
    if (detector === undefined) throw new Error("expected detector");

    expectExactKeys(forward, ["protocol", "detectors", "scannerManifestSha256"]);
    expectExactKeys(detector, [
      "detectorId",
      "analyzerIdentity",
      "ociImage",
      "adapter",
      "observationConfigurationSha256",
      "executionProfileSha256",
      "supportedPlatforms",
      "sbom",
      "provenance",
      "scannerManifestEntrySha256",
    ]);
    expectExactKeys(detector.ociImage, ["reference", "sha256"]);
    expectExactKeys(detector.adapter, ["identity", "sha256"]);
    expectExactKeys(detector.sbom, ["mediaType", "sha256"]);
    expectExactKeys(detector.provenance, ["mediaType", "sha256"]);
    for (const platform of detector.supportedPlatforms)
      expectExactKeys(platform, ["os", "architecture"]);
    expect(forward.detectors.map((entry) => entry.detectorId)).toEqual([
      "detector.dependency-audit",
      "detector.secret-audit",
    ]);
    expect(forward.scannerManifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(detector.scannerManifestEntrySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(forward.scannerManifestSha256).toBe(reverse.scannerManifestSha256);
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.detectors)).toBe(true);
    expect(Object.isFrozen(detector)).toBe(true);
    expect(Object.isFrozen(detector.supportedPlatforms)).toBe(true);
    expect(() => {
      (detector.ociImage as { reference: string }).reference = "forged";
    }).toThrow();
    firstInput.adapter.identity = "adapter.aaaaaaaaaaaa";
    expect(detector.adapter.identity).toBe("adapter.0123456789ab");
  });

  it("domain-separates each exact detector entry from aggregate manifest assembly", () => {
    const input = manifestInput();
    const firstInput = mustGet(input.detectors, 0);
    const secondInput = mustGet(input.detectors, 1);
    const base = createScannerManifestV1(input);
    const changedFirst = createScannerManifestV1({
      ...input,
      detectors: [
        {
          ...firstInput,
          ociImage: {
            ...firstInput.ociImage,
            reference:
              "registry.example.invalid/aih/dependency-audit@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            sha256: "c".repeat(64),
          },
        },
        secondInput,
      ],
    });
    const changedUnrelated = createScannerManifestV1({
      ...input,
      detectors: [
        firstInput,
        {
          ...secondInput,
          adapter: { ...secondInput.adapter, sha256: sha256("other adapter") },
        },
      ],
    });
    const first = base.detectors.find((entry) => entry.detectorId === "detector.dependency-audit");
    const changed = changedFirst.detectors.find(
      (entry) => entry.detectorId === "detector.dependency-audit",
    );
    const unrelated = changedUnrelated.detectors.find(
      (entry) => entry.detectorId === "detector.dependency-audit",
    );
    if (first === undefined || changed === undefined || unrelated === undefined)
      throw new Error("expected detector entry");
    expect(changed.scannerManifestEntrySha256).not.toBe(first.scannerManifestEntrySha256);
    expect(unrelated.scannerManifestEntrySha256).toBe(first.scannerManifestEntrySha256);
    expect(changedUnrelated.scannerManifestSha256).not.toBe(base.scannerManifestSha256);
    for (const detector of [
      {
        ...firstInput,
        adapter: { ...firstInput.adapter, sha256: sha256("other adapter") },
      },
      { ...firstInput, observationConfigurationSha256: sha256("other configuration") },
      { ...firstInput, executionProfileSha256: sha256("other execution profile") },
      { ...firstInput, supportedPlatforms: [{ os: "darwin", architecture: "arm64" }] },
      { ...firstInput, sbom: { ...firstInput.sbom, sha256: sha256("other sbom") } },
      {
        ...firstInput,
        provenance: { ...firstInput.provenance, sha256: sha256("other provenance") },
      },
    ]) {
      const value = createScannerManifestV1({
        ...input,
        detectors: [detector, secondInput],
      });
      const entry = value.detectors.find(
        (candidate) => candidate.detectorId === "detector.dependency-audit",
      );
      if (entry === undefined) throw new Error("expected changed detector entry");
      expect(entry.scannerManifestEntrySha256).not.toBe(first.scannerManifestEntrySha256);
    }
  });

  it("uses domain-separated JCS bytes and brands only validated values", () => {
    const manifest = createScannerManifestV1(manifestInput());
    const bytes = canonicalScannerManifestBytesV1(manifest);
    expect(bytes.toString("utf8")).toContain('"protocol":"ScannerManifestV1"');
    expect(canonicalScannerManifestSha256V1(manifest)).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(() => canonicalScannerManifestBytesV1(structuredClone(manifest) as never)).toThrow(
      /validated|branded|forged/i,
    );
  });

  it("permits Windows structurally in detector platform rows and binds it into entry and aggregate digests", () => {
    const input = manifestInput();
    const firstInput = mustGet(input.detectors, 0);
    const secondInput = mustGet(input.detectors, 1);
    const linux = createScannerManifestV1(input);
    const windows = createScannerManifestV1({
      ...input,
      detectors: [
        { ...firstInput, supportedPlatforms: [{ os: "windows", architecture: "amd64" }] },
        secondInput,
      ],
    });
    const linuxEntry = linux.detectors.find((entry) => entry.detectorId === firstInput.detectorId);
    const windowsEntry = windows.detectors.find(
      (entry) => entry.detectorId === firstInput.detectorId,
    );
    if (linuxEntry === undefined || windowsEntry === undefined)
      throw new Error("expected detector entry");
    expect(windowsEntry.supportedPlatforms[0]?.os).toBe("windows");
    expect(windowsEntry.scannerManifestEntrySha256).not.toBe(linuxEntry.scannerManifestEntrySha256);
    expect(windows.scannerManifestSha256).not.toBe(linux.scannerManifestSha256);
    expect(JSON.stringify(windows)).not.toContain("qualification");
  });

  it("rejects strict JSON ambiguity, mutable OCI references, malformed identities, and duplicate detector/platform rows", () => {
    const input = manifestInput();
    const firstInput = mustGet(input.detectors, 0);
    const secondInput = mustGet(input.detectors, 1);
    for (const ociImage of [
      {
        ...firstInput.ociImage,
        reference: "registry.example.invalid/aih/dependency-audit:latest",
      },
      {
        ...firstInput.ociImage,
        reference: "registry.example.invalid/aih/dependency-audit@sha256:*",
      },
      { ...firstInput.ociImage, sha256: "A".repeat(64) },
      {
        ...firstInput.ociImage,
        reference: "registry.example.invalid/aih/dependency-audit",
      },
    ]) {
      expect(() =>
        createScannerManifestV1({
          ...input,
          detectors: [{ ...firstInput, ociImage }, secondInput],
        }),
      ).toThrow(/oci|digest|immutable|reference/i);
    }
    for (const change of [
      { analyzerIdentity: "native.0123456789AB" },
      { adapter: { ...firstInput.adapter, identity: "adapter.generic" } },
      { detectorId: "detector.*" },
      { observationConfigurationSha256: "bad" },
      { sbom: { ...firstInput.sbom, sha256: "A".repeat(64) } },
      { provenance: { ...firstInput.provenance, mediaType: "text/plain" } },
    ]) {
      expect(() =>
        createScannerManifestV1({
          ...input,
          detectors: [{ ...firstInput, ...change }, secondInput],
        }),
      ).toThrow(/identity|detector|digest|descriptor|media|platform/i);
    }
    expect(() =>
      createScannerManifestV1({ ...input, detectors: [firstInput, firstInput] }),
    ).toThrow(/duplicate|ambiguous/i);
    expect(() =>
      createScannerManifestV1({
        ...input,
        detectors: [
          firstInput,
          {
            ...firstInput,
            adapter: { ...firstInput.adapter, sha256: sha256("conflict") },
          },
        ],
      }),
    ).toThrow(/duplicate|ambiguous|conflict/i);
    expect(() =>
      createScannerManifestV1({
        ...input,
        detectors: [
          {
            ...firstInput,
            supportedPlatforms: [
              mustGet(firstInput.supportedPlatforms, 0),
              mustGet(firstInput.supportedPlatforms, 0),
            ],
          },
          secondInput,
        ],
      }),
    ).toThrow(/duplicate|ambiguous|platform/i);
    for (const detector of [
      { ...firstInput, extra: true },
      { ...firstInput, ociImage: { ...firstInput.ociImage, extra: true } },
      { ...firstInput, adapter: { ...firstInput.adapter, extra: true } },
      {
        ...firstInput,
        supportedPlatforms: [{ ...mustGet(firstInput.supportedPlatforms, 0), extra: true }],
      },
      { ...firstInput, sbom: { ...firstInput.sbom, extra: true } },
      { ...firstInput, provenance: { ...firstInput.provenance, extra: true } },
    ]) {
      expect(() =>
        createScannerManifestV1({ ...input, detectors: [detector, secondInput] }),
      ).toThrow(/unknown|unexpected|unrecognized/i);
    }
    expect(() =>
      parseScannerManifestV1Json('{"protocol":"ScannerManifestV1","protocol":"ScannerManifestV1"}'),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseScannerManifestV1Json('{"protocol":"ScannerManifestV1","extra":true}'),
    ).toThrow(/unknown|unexpected|unrecognized/i);
    expect(() =>
      parseScannerManifestV1Json('{"protocol":"ScannerManifestV1","x":"e\\u0300"}'),
    ).toThrow(/NFC|Unicode/i);
  });

  it("remains an internal dormant contract with no static runtime consumer or public export", () => {
    const owner = "src/observation/scanner-manifest-v1.ts";
    for (const file of sourceFiles().filter((candidate) => candidate !== owner)) {
      expect(
        moduleSpecifiers(file).filter((specifier) => specifier.includes("scanner-manifest-v1")),
      ).toEqual([]);
    }
    expect(
      moduleSpecifiers("src/index.ts").filter((specifier) =>
        specifier.includes("scanner-manifest-v1"),
      ),
    ).toEqual([]);
    const packageJson = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")) as {
      exports?: unknown;
    };
    expect(JSON.stringify(packageJson.exports)).not.toContain("observation/scanner-manifest-v1");
  });
});
