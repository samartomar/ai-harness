import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assessNativeObservationReuseV1,
  canonicalNativeObservationBytesV1,
  canonicalNativeObservationSha256V1,
  createNativeObservationV1,
  parseNativeObservationV1Json,
  type SourceSealV1,
  sealNativeObservationSourceV1,
} from "../../src/observation/native-observation-v1.js";

let root: string;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function write(rel: string, contents: string): void {
  const target = join(root, ...rel.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function seal(): SourceSealV1 {
  return sealNativeObservationSourceV1({ sourceRoot: root, selectedClosurePaths: ["selected"] });
}

function nativeInput(sourceSeal: SourceSealV1) {
  return {
    protocol: "NativeObservationV1" as const,
    sourceSeal,
    nativeAnalyzerIdentity: "native.0123456789ab",
    observationConfigurationSha256: sha256("observation configuration"),
    platform: {
      os: "linux",
      architecture: "amd64",
      relevantFactsSha256: sha256("kernel=6.12;filesystem=ext4"),
    },
    facts: [
      {
        rawOccurrenceFingerprint: `raw-occurrence-v1:${sha256("first occurrence")}`,
        multiplicity: 2,
      },
      {
        rawOccurrenceFingerprint: `raw-occurrence-v1:${sha256("second occurrence")}`,
        multiplicity: 1,
      },
    ] as const,
    coverage: [
      { coverageKind: "selected-closure", coverageSha256: sha256("selected coverage") },
      { coverageKind: "source-tree", coverageSha256: sha256("source coverage") },
    ] as const,
  };
}

function observation(sourceSeal: SourceSealV1 = seal()) {
  return createNativeObservationV1(nativeInput(sourceSeal));
}

function reuse(input: unknown, sourceRoot = root, selectedClosurePaths = ["selected"]) {
  return assessNativeObservationReuseV1({
    observation: input,
    sourceRoot,
    selectedClosurePaths,
  });
}

function sourceText(rel: string): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return readFileSync(join(repoRoot, ...rel.split("/")), "utf8");
}

function expectExactKeys(value: object, keys: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-native-observation-v1-"));
  write("selected/SKILL.md", "# selected\n");
  write("unselected/README.md", "# unselected\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("SourceSealV1", () => {
  it("binds the full source tree and selected closure without retaining absolute paths", () => {
    const first = seal();
    expect(first).toEqual({
      protocol: "SourceSealV1",
      sourceTreeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      selectedClosureSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expectExactKeys(first, ["protocol", "sourceTreeSha256", "selectedClosureSha256"]);
    expect(JSON.stringify(first)).not.toContain(root);
    expect(Object.isFrozen(first)).toBe(true);

    write("unselected/README.md", "# changed but outside selected closure\n");
    const nonSelectedChange = seal();
    expect(nonSelectedChange.sourceTreeSha256).not.toBe(first.sourceTreeSha256);
    expect(nonSelectedChange.selectedClosureSha256).toBe(first.selectedClosureSha256);

    write("selected/SKILL.md", "# changed selected closure\n");
    const selectedChange = seal();
    expect(selectedChange.sourceTreeSha256).not.toBe(nonSelectedChange.sourceTreeSha256);
    expect(selectedChange.selectedClosureSha256).not.toBe(nonSelectedChange.selectedClosureSha256);
  });

  it("delegates selected closure safety to the existing component-tree boundary", () => {
    expect(() =>
      sealNativeObservationSourceV1({ sourceRoot: root, selectedClosurePaths: ["../escape"] }),
    ).toThrow(/outside|escape|parent/i);
    expect(() =>
      sealNativeObservationSourceV1({
        sourceRoot: root,
        selectedClosurePaths: ["selected", "./selected"],
      }),
    ).toThrow(/duplicate|ambiguous/i);
  });
});

describe("NativeObservationV1", () => {
  it("is posture-neutral, local-optimization-only, immutable, and stable across schema-defined order", () => {
    const sourceSeal = seal();
    const input = nativeInput(sourceSeal);
    const left = createNativeObservationV1(input);
    const right = createNativeObservationV1({
      ...input,
      facts: [...input.facts].reverse(),
      coverage: [...input.coverage].reverse(),
    });
    const firstFact = left.facts[0];
    const firstCoverage = left.coverage[0];
    if (firstFact === undefined || firstCoverage === undefined) {
      throw new Error("expected native observation facts and coverage");
    }

    expectExactKeys(left, [
      "protocol",
      "sourceSeal",
      "nativeAnalyzerIdentity",
      "observationConfigurationSha256",
      "platform",
      "facts",
      "coverage",
      "reuseScope",
      "observationKeySha256",
      "resultSha256",
    ]);
    expectExactKeys(left.sourceSeal, ["protocol", "sourceTreeSha256", "selectedClosureSha256"]);
    expectExactKeys(left.platform, ["os", "architecture", "relevantFactsSha256"]);
    expectExactKeys(firstFact, ["rawOccurrenceFingerprint", "multiplicity"]);
    expectExactKeys(firstCoverage, ["coverageKind", "coverageSha256"]);
    expect(left.protocol).toBe("NativeObservationV1");
    expect(left.sourceSeal).toEqual(sourceSeal);
    expect(left.reuseScope).toBe("local-optimization-only");
    expect(left.observationKeySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(left.resultSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(left.observationKeySha256).toBe(right.observationKeySha256);
    expect(left.resultSha256).toBe(right.resultSha256);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.sourceSeal)).toBe(true);
    expect(Object.isFrozen(left.platform)).toBe(true);
    expect(Object.isFrozen(left.facts)).toBe(true);
    expect(Object.isFrozen(firstFact)).toBe(true);
    expect(Object.isFrozen(left.coverage)).toBe(true);
    expect(Object.isFrozen(firstCoverage)).toBe(true);
    const serialized = JSON.stringify(left).toLowerCase();
    for (const forbidden of [
      "pass",
      "portable",
      "policy",
      "signer",
      "verdict",
      "acceptance",
      "acknowledgement",
      "timestamp",
      "runid",
      "message",
      "absolutepath",
      root.toLowerCase(),
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(() => canonicalNativeObservationBytesV1(structuredClone(left) as never)).toThrow(
      /validated|branded|forged/i,
    );
  });

  it("binds each execution-relevant key field one at a time", () => {
    const sourceSeal = seal();
    const input = nativeInput(sourceSeal);
    const base = createNativeObservationV1(input);
    for (const changed of [
      createNativeObservationV1({
        ...input,
        sourceSeal: { ...sourceSeal, sourceTreeSha256: sha256("other tree") },
      }),
      createNativeObservationV1({
        ...input,
        sourceSeal: { ...sourceSeal, selectedClosureSha256: sha256("other closure") },
      }),
      createNativeObservationV1({ ...input, nativeAnalyzerIdentity: "native.fedcba987654" }),
      createNativeObservationV1({
        ...input,
        observationConfigurationSha256: sha256("other configuration"),
      }),
      createNativeObservationV1({ ...input, platform: { ...input.platform, os: "darwin" } }),
      createNativeObservationV1({
        ...input,
        platform: { ...input.platform, architecture: "arm64" },
      }),
      createNativeObservationV1({
        ...input,
        platform: { ...input.platform, relevantFactsSha256: sha256("other platform facts") },
      }),
    ]) {
      expect(changed.observationKeySha256).not.toBe(base.observationKeySha256);
    }
  });

  it("binds sorted fact multiplicity and coverage in the result digest", () => {
    const sourceSeal = seal();
    const input = nativeInput(sourceSeal);
    const base = createNativeObservationV1(input);
    const changedFingerprint = createNativeObservationV1({
      ...input,
      facts: [
        { ...input.facts[0], rawOccurrenceFingerprint: `raw-occurrence-v1:${sha256("third")}` },
        input.facts[1],
      ],
    });
    const changedMultiplicity = createNativeObservationV1({
      ...input,
      facts: [{ ...input.facts[0], multiplicity: 3 }, input.facts[1]],
    });
    const changedCoverage = createNativeObservationV1({
      ...input,
      coverage: [
        { coverageKind: "selected-closure", coverageSha256: sha256("changed coverage") },
        input.coverage[1],
      ],
    });
    const oneCoverage = { ...input, coverage: [input.coverage[0]] };
    const oneCoverageBase = createNativeObservationV1(oneCoverage);
    const changedCoverageKind = createNativeObservationV1({
      ...oneCoverage,
      coverage: [{ ...input.coverage[0], coverageKind: "source-tree" }],
    });

    expect(changedFingerprint.resultSha256).not.toBe(base.resultSha256);
    expect(changedMultiplicity.resultSha256).not.toBe(base.resultSha256);
    expect(changedCoverage.resultSha256).not.toBe(base.resultSha256);
    expect(changedCoverageKind.resultSha256).not.toBe(oneCoverageBase.resultSha256);
    expect(() =>
      createNativeObservationV1({
        ...input,
        facts: [{ ...input.facts[0] }, { ...input.facts[0] }],
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      createNativeObservationV1({
        ...input,
        coverage: [{ ...input.coverage[0] }, { ...input.coverage[0] }],
      }),
    ).toThrow(/duplicate/i);
    for (const multiplicity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        createNativeObservationV1({
          ...input,
          facts: [{ ...input.facts[0], multiplicity }, input.facts[1]],
        }),
      ).toThrow(/multiplicity|integer|positive|safe/i);
    }
    for (const rawOccurrenceFingerprint of ["raw-occurrence-v1:bad", "legacy:deadbeef"]) {
      expect(() =>
        createNativeObservationV1({
          ...input,
          facts: [{ ...input.facts[0], rawOccurrenceFingerprint }, input.facts[1]],
        }),
      ).toThrow(/fingerprint|raw/i);
    }
    expect(() =>
      createNativeObservationV1({
        ...input,
        coverage: [{ ...input.coverage[0], coverageKind: "" }, input.coverage[1]],
      }),
    ).toThrow(/coverage|kind/i);
  });

  it("defensively copies caller input before deeply freezing the validated observation", () => {
    const input = nativeInput(seal());
    const current = createNativeObservationV1(input);
    const originalResult = current.resultSha256;

    input.platform.os = "darwin";
    (input.facts[0] as { multiplicity: number }).multiplicity = 7;
    (input.coverage[0] as { coverageSha256: string }).coverageSha256 = sha256("mutated coverage");

    expect(current.platform.os).toBe("linux");
    expect(current.facts[0]?.multiplicity).toBe(2);
    expect(current.coverage[0]?.coverageSha256).toBe(sha256("selected coverage"));
    expect(current.resultSha256).toBe(originalResult);
    expect(() => {
      (current.platform as { os: string }).os = "darwin";
    }).toThrow();
    expect(() => {
      (current.facts[0] as { multiplicity: number }).multiplicity = 7;
    }).toThrow();
    expect(() => {
      (current.coverage[0] as { coverageSha256: string }).coverageSha256 = "0".repeat(64);
    }).toThrow();
  });

  it("fails closed on forbidden policy/run-noise fields and malformed identity inputs", () => {
    const input = nativeInput(seal());
    for (const field of [
      "posture",
      "severity",
      "verdict",
      "policy",
      "acceptance",
      "acknowledgement",
      "timestamp",
      "runId",
      "message",
      "absolutePath",
      "unexpected",
    ]) {
      expect(() => createNativeObservationV1({ ...input, [field]: "forbidden" })).toThrow(
        /unrecognized|unknown|unexpected/i,
      );
    }
    expect(() =>
      createNativeObservationV1({
        ...input,
        observationConfigurationSha256: "not-a-digest",
      }),
    ).toThrow(/digest|sha256/i);
    expect(() =>
      createNativeObservationV1({ ...input, nativeAnalyzerIdentity: "native.re\u0300gle" }),
    ).toThrow(/NFC/i);
    for (const nativeAnalyzerIdentity of [
      "native.short",
      "native.0123456789ABC",
      "native.0123456789abc",
    ]) {
      expect(() => createNativeObservationV1({ ...input, nativeAnalyzerIdentity })).toThrow(
        /analyzer|native|identity/i,
      );
    }
    for (const platform of [
      { ...input.platform, os: "linux/amd64" },
      { ...input.platform, architecture: "x86_64" },
      { ...input.platform, unexpected: true },
    ]) {
      expect(() => createNativeObservationV1({ ...input, platform })).toThrow(
        /platform|unknown|unexpected|unrecognized/i,
      );
    }
    expect(() =>
      createNativeObservationV1({
        ...input,
        facts: Array.from({ length: 4_097 }, (_, index) => ({
          rawOccurrenceFingerprint: `raw-occurrence-v1:${sha256(`fact-${String(index)}`)}`,
          multiplicity: 1,
        })),
      }),
    ).toThrow(/facts|bounded|many|length/i);
    expect(() => parseNativeObservationV1Json('{"protocol":"NativeObservationV1","x":1}')).toThrow(
      /unknown|unexpected|unrecognized/i,
    );
  });

  it("uses a closed required/reusable-local reuse result and always rehashes source bytes", () => {
    const current = observation();
    const reusable = reuse(current);
    expect(reusable).toEqual({ kind: "reusable-local" });
    expectExactKeys(reusable, ["kind"]);

    write("unselected/README.md", "# tree changed\n");
    const sourceMismatch = reuse(current);
    expect(sourceMismatch).toEqual({
      kind: "required",
      code: "NATIVE_OBSERVATION_REQUIRED",
      reason: "source-tree-mismatch",
    });
    expectExactKeys(sourceMismatch, ["kind", "code", "reason"]);

    const closureCurrent = observation();
    write("selected/SKILL.md", "# closure changed\n");
    const closureMismatch = reuse(closureCurrent);
    expect(closureMismatch).toEqual({
      kind: "required",
      code: "NATIVE_OBSERVATION_REQUIRED",
      reason: "selected-closure-mismatch",
    });
    expectExactKeys(closureMismatch, ["kind", "code", "reason"]);

    const missingBytes = reuse(closureCurrent, join(root, "missing"));
    expect(missingBytes).toEqual({
      kind: "required",
      code: "NATIVE_OBSERVATION_REQUIRED",
      reason: "source-bytes-unavailable",
    });
    expectExactKeys(missingBytes, ["kind", "code", "reason"]);
    const invalidObservation = reuse(structuredClone(closureCurrent));
    expect(invalidObservation).toEqual({
      kind: "required",
      code: "NATIVE_OBSERVATION_REQUIRED",
      reason: "invalid-observation",
    });
    expectExactKeys(invalidObservation, ["kind", "code", "reason"]);
    expect(
      JSON.stringify([
        reusable,
        sourceMismatch,
        closureMismatch,
        missingBytes,
        invalidObservation,
      ]).toLowerCase(),
    ).not.toContain("pass");
  });

  it("has no current runtime or evidence cutover import or public export", () => {
    for (const rel of [
      "src/trust/scan.ts",
      "src/trust/evidence.ts",
      "src/trust/fingerprint.ts",
      "src/trust/acknowledge.ts",
      "src/trust/detectors.ts",
      "src/trust/grade.ts",
      "src/baseline-evidence/vet.ts",
      "src/baseline-evidence/verify.ts",
      "src/baseline-evidence/reuse.ts",
      "src/baseline-evidence/run.ts",
      "src/baseline-evidence/analyzer-profile.ts",
      "src/bundle/index.ts",
      "src/index.ts",
    ]) {
      expect(sourceText(rel)).not.toMatch(
        /(?:from|export)\s+["'][^"']*observation\/native-observation-v1(?:\.js)?["']/,
      );
    }
  });

  it("uses branded canonical bytes and SHA-256 only for validated observations", () => {
    const current = observation();
    const bytes = canonicalNativeObservationBytesV1(current);
    expect(bytes.toString("utf8")).toContain('"protocol":"NativeObservationV1"');
    expect(canonicalNativeObservationSha256V1(current)).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });
});
