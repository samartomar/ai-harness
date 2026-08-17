import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenizer } from "acorn";
import { describe, expect, it } from "vitest";
import {
  canonicalEvidenceAnnexBytesV1,
  canonicalObservationKeyBytesV1,
  canonicalObservationSetBytesV1,
  createEvidenceAnnexV1,
  createObservationKeyV1,
  createObservationSetV1,
  parseEvidenceAnnexV1Json,
  parseObservationKeyV1Json,
  parseObservationSetV1Json,
} from "../../src/observation/observation-evidence-v1.js";
import { createScannerManifestV1 } from "../../src/observation/scanner-manifest-v1.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function keyInput() {
  return {
    protocol: "ObservationKeyV1" as const,
    sourceSeal: {
      protocol: "SourceSealV1" as const,
      sourceTreeSha256: sha256("source tree"),
      selectedClosureSha256: sha256("selected closure"),
    },
    nativeAnalyzerIdentity: "native.0123456789ab",
    observationConfigurationSha256: sha256("configuration"),
    platform: {
      os: "linux" as const,
      architecture: "amd64" as const,
      relevantFactsSha256: sha256("facts"),
    },
    scannerManifestEntrySha256: sha256("dependency manifest entry"),
  };
}

function setInput() {
  return {
    protocol: "ObservationSetV1" as const,
    observationKey: keyInput(),
    facts: [
      { rawOccurrenceFingerprint: `raw-occurrence-v1:${sha256("first")}`, multiplicity: 2 },
      { rawOccurrenceFingerprint: `raw-occurrence-v1:${sha256("second")}`, multiplicity: 1 },
    ],
    coverage: [
      { coverageKind: "selected-closure" as const, coverageSha256: sha256("selected coverage") },
      { coverageKind: "source-tree" as const, coverageSha256: sha256("source coverage") },
    ],
  };
}

function annexInput() {
  return {
    protocol: "EvidenceAnnexV1" as const,
    descriptors: [
      {
        descriptorId: "annex.native-log",
        mediaType: "application/json",
        sha256: sha256("native log"),
        byteLength: 128,
        uri: "annex/native-log.json",
      },
      {
        descriptorId: "annex.sbom",
        mediaType: "application/spdx+json",
        sha256: sha256("sbom"),
        byteLength: 256,
        uri: "annex/sbom.spdx.json",
      },
    ],
  };
}

function expectExactKeys(value: object, keys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
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
  const scan = tokenizer(readFileSync(join(repoRoot(), ...rel.split("/")), "utf8"), {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const tokens: Array<{ label: string; value: unknown }> = [];
  for (;;) {
    const token = scan.getToken();
    tokens.push({ label: token.type.label, value: (token as { value?: unknown }).value });
    if (token.type.label === "eof") break;
  }
  const literal = (index: number) => {
    const token = tokens[index];
    return token?.label === "string" && typeof token.value === "string" ? token.value : undefined;
  };
  const from = (start: number) => {
    for (let index = start; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === undefined || token.label === ";" || token.label === "eof") return undefined;
      if (token.label === "name" && token.value === "from") return literal(index + 1);
    }
    return undefined;
  };
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.label === "import") {
      for (const value of [
        literal(index + 1),
        tokens[index + 1]?.label === "(" ? literal(index + 2) : undefined,
        from(index + 1),
      ])
        if (value !== undefined) result.push(value);
    }
    if (token?.label === "export") {
      const value = from(index + 1);
      if (value !== undefined) result.push(value);
    }
    if (token?.label === "name" && token.value === "require" && tokens[index + 1]?.label === "(") {
      const value = literal(index + 2);
      if (value !== undefined) result.push(value);
    }
  }
  return result;
}

describe("ObservationKeyV1 and ObservationSetV1", () => {
  it("binds execution identity, scanner manifest, multiplicity, and coverage with schema-defined stable ordering", () => {
    const input = setInput();
    const forward = createObservationSetV1(input);
    const reverse = createObservationSetV1({
      ...input,
      facts: [...input.facts].reverse(),
      coverage: [...input.coverage].reverse(),
    });
    const key = createObservationKeyV1(keyInput());
    const fact = forward.facts[0];
    const coverage = forward.coverage[0];
    if (fact === undefined || coverage === undefined)
      throw new Error("expected observation entries");

    expectExactKeys(key, [
      "protocol",
      "sourceSeal",
      "nativeAnalyzerIdentity",
      "observationConfigurationSha256",
      "platform",
      "scannerManifestEntrySha256",
      "observationKeySha256",
    ]);
    expectExactKeys(forward, [
      "protocol",
      "observationKey",
      "facts",
      "coverage",
      "observationSetSha256",
    ]);
    expectExactKeys(fact, ["rawOccurrenceFingerprint", "multiplicity"]);
    expectExactKeys(coverage, ["coverageKind", "coverageSha256"]);
    expect(forward.observationKey.observationKeySha256).toBe(key.observationKeySha256);
    expect(forward.observationSetSha256).toBe(reverse.observationSetSha256);
    expect(forward.facts.map((entry) => entry.rawOccurrenceFingerprint)).toEqual(
      [...input.facts].map((entry) => entry.rawOccurrenceFingerprint).sort(),
    );
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.observationKey)).toBe(true);
    expect(Object.isFrozen(forward.facts)).toBe(true);
    expect(Object.isFrozen(fact)).toBe(true);
    expect(Object.isFrozen(forward.coverage)).toBe(true);
    expect(Object.isFrozen(coverage)).toBe(true);
    input.facts[0].multiplicity = 9;
    expect(fact.multiplicity).toBe(2);
    expect(() => {
      (fact as { multiplicity: number }).multiplicity = 9;
    }).toThrow();
  });

  it("changes the observation key for every execution-relevant identity field but has no policy or run-noise fields", () => {
    const input = keyInput();
    const base = createObservationKeyV1(input);
    const changed = [
      createObservationKeyV1({
        ...input,
        sourceSeal: { ...input.sourceSeal, sourceTreeSha256: sha256("other tree") },
      }),
      createObservationKeyV1({
        ...input,
        sourceSeal: { ...input.sourceSeal, selectedClosureSha256: sha256("other closure") },
      }),
      createObservationKeyV1({ ...input, nativeAnalyzerIdentity: "native.fedcba987654" }),
      createObservationKeyV1({ ...input, observationConfigurationSha256: sha256("other config") }),
      createObservationKeyV1({ ...input, platform: { ...input.platform, os: "darwin" } }),
      createObservationKeyV1({ ...input, platform: { ...input.platform, architecture: "arm64" } }),
      createObservationKeyV1({
        ...input,
        platform: { ...input.platform, relevantFactsSha256: sha256("other facts") },
      }),
      createObservationKeyV1({
        ...input,
        scannerManifestEntrySha256: sha256("other manifest entry"),
      }),
    ];
    for (const value of changed)
      expect(value.observationKeySha256).not.toBe(base.observationKeySha256);
    for (const forbidden of [
      "posture",
      "policy",
      "severity",
      "message",
      "timestamp",
      "runId",
      "absolutePath",
    ]) {
      expect(() => createObservationKeyV1({ ...input, [forbidden]: "forbidden" })).toThrow(
        /unknown|unexpected|unrecognized/i,
      );
    }
  });

  it("binds only the matching detector entry, not aggregate manifest assembly", () => {
    const scanner = createScannerManifestV1({
      protocol: "ScannerManifestV1",
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
          observationConfigurationSha256: sha256("configuration"),
          executionProfileSha256: sha256("dependency execution profile"),
          supportedPlatforms: [{ os: "linux", architecture: "amd64" }],
          sbom: { mediaType: "application/spdx+json", sha256: sha256("dependency sbom") },
          provenance: {
            mediaType: "application/vnd.in-toto+json",
            sha256: sha256("dependency provenance"),
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
          supportedPlatforms: [{ os: "linux", architecture: "amd64" }],
          sbom: { mediaType: "application/spdx+json", sha256: sha256("secret sbom") },
          provenance: {
            mediaType: "application/vnd.in-toto+json",
            sha256: sha256("secret provenance"),
          },
        },
      ],
    });
    const { scannerManifestSha256: ignoredManifestDigest, ...scannerInput } = scanner;
    void ignoredManifestDigest;
    const changedUnrelated = createScannerManifestV1({
      ...scannerInput,
      detectors: scanner.detectors.map(({ scannerManifestEntrySha256, ...entry }) => {
        void scannerManifestEntrySha256;
        return entry.detectorId === "detector.secret-audit"
          ? { ...entry, adapter: { ...entry.adapter, sha256: sha256("other secret adapter") } }
          : entry;
      }),
    });
    const first = scanner.detectors.find(
      (entry) => entry.detectorId === "detector.dependency-audit",
    );
    const unrelated = changedUnrelated.detectors.find(
      (entry) => entry.detectorId === "detector.dependency-audit",
    );
    if (first === undefined || unrelated === undefined)
      throw new Error("expected dependency detector");
    const base = createObservationKeyV1({
      ...keyInput(),
      scannerManifestEntrySha256: first.scannerManifestEntrySha256,
    });
    const unchanged = createObservationKeyV1({
      ...keyInput(),
      scannerManifestEntrySha256: unrelated.scannerManifestEntrySha256,
    });
    expect(changedUnrelated.scannerManifestSha256).not.toBe(scanner.scannerManifestSha256);
    expect(unrelated.scannerManifestEntrySha256).toBe(first.scannerManifestEntrySha256);
    expect(unchanged.observationKeySha256).toBe(base.observationKeySha256);
    expect(() =>
      createObservationKeyV1({
        ...keyInput(),
        scannerManifestSha256: scanner.scannerManifestSha256,
      }),
    ).toThrow(/unknown|unexpected|unrecognized/i);
  });

  it("rejects semantic collisions, malformed raw JSON, forged canonical values, and unbounded entries", () => {
    const input = setInput();
    expect(() =>
      createObservationSetV1({
        ...input,
        facts: [input.facts[0], { ...input.facts[0], multiplicity: 3 }],
      }),
    ).toThrow(/duplicate|collision/i);
    expect(() =>
      createObservationSetV1({
        ...input,
        coverage: [input.coverage[0], { ...input.coverage[0], coverageSha256: sha256("other") }],
      }),
    ).toThrow(/duplicate|collision/i);
    expect(() =>
      createObservationSetV1({ ...input, facts: [{ ...input.facts[0], multiplicity: 0 }] }),
    ).toThrow(/multiplicity|positive|integer/i);
    expect(() =>
      createObservationSetV1({
        ...input,
        facts: [{ ...input.facts[0], rawOccurrenceFingerprint: "raw-occurrence-v1:bad" }],
      }),
    ).toThrow(/raw|fingerprint/i);
    expect(() =>
      parseObservationKeyV1Json('{"protocol":"ObservationKeyV1","protocol":"ObservationKeyV1"}'),
    ).toThrow(/duplicate/i);
    expect(() => parseObservationSetV1Json('{"protocol":"ObservationSetV1","extra":true}')).toThrow(
      /unknown|unexpected|unrecognized/i,
    );
    const set = createObservationSetV1(input);
    expect(() =>
      canonicalObservationKeyBytesV1(structuredClone(set.observationKey) as never),
    ).toThrow(/validated|branded|forged/i);
    expect(() => canonicalObservationSetBytesV1(structuredClone(set) as never)).toThrow(
      /validated|branded|forged/i,
    );
  });
});

describe("EvidenceAnnexV1", () => {
  it("keeps bounded content-addressed descriptors separate from the key and set identities", () => {
    const set = createObservationSetV1(setInput());
    const first = createEvidenceAnnexV1(annexInput());
    const second = createEvidenceAnnexV1({
      ...annexInput(),
      descriptors: [...annexInput().descriptors].reverse(),
    });
    const descriptor = first.descriptors[0];
    if (descriptor === undefined) throw new Error("expected annex descriptor");
    expectExactKeys(first, ["protocol", "descriptors", "evidenceAnnexSha256"]);
    expectExactKeys(descriptor, ["descriptorId", "mediaType", "sha256", "byteLength", "uri"]);
    expect(first.evidenceAnnexSha256).toBe(second.evidenceAnnexSha256);
    expect(canonicalEvidenceAnnexBytesV1(first).toString("utf8")).toContain(
      '"protocol":"EvidenceAnnexV1"',
    );
    expect(createObservationSetV1(setInput()).observationSetSha256).toBe(set.observationSetSha256);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.descriptors)).toBe(true);
    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  it("rejects inline, unbounded, absolute, hostile, or duplicate annex material", () => {
    const input = annexInput();
    for (const descriptor of [
      { ...input.descriptors[0], content: "inline evidence" },
      { ...input.descriptors[0], byteLength: Number.MAX_SAFE_INTEGER + 1 },
      { ...input.descriptors[0], uri: "/absolute.json" },
      { ...input.descriptors[0], uri: "annex/../escape.json" },
      { ...input.descriptors[0], uri: "https://host.invalid/evidence.json" },
      { ...input.descriptors[0], sha256: "A".repeat(64) },
    ]) {
      expect(() =>
        createEvidenceAnnexV1({ ...input, descriptors: [descriptor, input.descriptors[1]] }),
      ).toThrow(/inline|bounded|path|uri|digest|unknown|unexpected/i);
    }
    expect(() =>
      createEvidenceAnnexV1({
        ...input,
        descriptors: [input.descriptors[0], input.descriptors[0]],
      }),
    ).toThrow(/duplicate|ambiguous/i);
    expect(() => parseEvidenceAnnexV1Json('{"protocol":"EvidenceAnnexV1","x":"e\\u0300"}')).toThrow(
      /NFC|Unicode/i,
    );
  });
});

describe("dormant observation evidence boundary", () => {
  it("has no static runtime consumer or public export", () => {
    const owner = "src/observation/observation-evidence-v1.ts";
    for (const file of sourceFiles().filter((candidate) => candidate !== owner)) {
      expect(
        moduleSpecifiers(file).filter((specifier) => specifier.includes("observation-evidence-v1")),
      ).toEqual([]);
    }
    expect(
      moduleSpecifiers("src/index.ts").filter((specifier) =>
        specifier.includes("observation-evidence-v1"),
      ),
    ).toEqual([]);
    const packageJson = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")) as {
      exports?: unknown;
    };
    expect(JSON.stringify(packageJson.exports)).not.toContain(
      "observation/observation-evidence-v1",
    );
  });
});
