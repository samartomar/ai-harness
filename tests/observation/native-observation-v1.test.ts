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

    expect(left).toMatchObject({
      protocol: "NativeObservationV1",
      sourceSeal,
      reuseScope: "local-optimization-only",
      observationKeySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      resultSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(left.observationKeySha256).toBe(right.observationKeySha256);
    expect(left.resultSha256).toBe(right.resultSha256);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.facts)).toBe(true);
    expect(() => canonicalNativeObservationBytesV1(structuredClone(left) as never)).toThrow(
      /validated|branded|forged/i,
    );
  });

  it("invalidates the key for every execution-relevant key field", () => {
    const sourceSeal = seal();
    const base = observation(sourceSeal);
    write("unselected/README.md", "# other full tree\n");
    const changedTree = observation(seal());
    write("selected/SKILL.md", "# other selected closure\n");
    const changedClosure = observation(seal());
    const changedAnalyzer = createNativeObservationV1({
      ...nativeInput(sourceSeal),
      nativeAnalyzerIdentity: "native.fedcba987654",
    });
    const changedConfiguration = createNativeObservationV1({
      ...nativeInput(sourceSeal),
      observationConfigurationSha256: sha256("other configuration"),
    });
    const changedPlatform = createNativeObservationV1({
      ...nativeInput(sourceSeal),
      platform: {
        os: "linux",
        architecture: "arm64",
        relevantFactsSha256: sha256("other platform facts"),
      },
    });

    for (const changed of [
      changedTree,
      changedClosure,
      changedAnalyzer,
      changedConfiguration,
      changedPlatform,
    ]) {
      expect(changed.observationKeySha256).not.toBe(base.observationKeySha256);
    }
  });

  it("binds sorted fact multiplicity and coverage in the result digest", () => {
    const sourceSeal = seal();
    const input = nativeInput(sourceSeal);
    const base = createNativeObservationV1(input);
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

    expect(changedMultiplicity.resultSha256).not.toBe(base.resultSha256);
    expect(changedCoverage.resultSha256).not.toBe(base.resultSha256);
    expect(() =>
      createNativeObservationV1({ ...input, facts: [input.facts[0], input.facts[0]] }),
    ).toThrow(/duplicate/i);
    expect(() =>
      createNativeObservationV1({ ...input, coverage: [input.coverage[0], input.coverage[0]] }),
    ).toThrow(/duplicate/i);
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
    expect(() => parseNativeObservationV1Json('{"protocol":"NativeObservationV1","x":1}')).toThrow(
      /unknown|unexpected|unrecognized/i,
    );
  });

  it("uses a closed required/reusable-local reuse result and always rehashes source bytes", () => {
    const current = observation();
    expect(reuse(current)).toEqual({ kind: "reusable-local" });

    write("unselected/README.md", "# tree changed\n");
    expect(reuse(current)).toEqual({
      kind: "required",
      code: "NATIVE_OBSERVATION_REQUIRED",
      reason: "source-tree-mismatch",
    });

    const closureCurrent = observation();
    write("selected/SKILL.md", "# closure changed\n");
    expect(reuse(closureCurrent)).toEqual({
      kind: "required",
      code: "NATIVE_OBSERVATION_REQUIRED",
      reason: "selected-closure-mismatch",
    });

    expect(reuse(closureCurrent, join(root, "missing"))).toEqual({
      kind: "required",
      code: "NATIVE_OBSERVATION_REQUIRED",
      reason: "source-bytes-unavailable",
    });
    expect(reuse(structuredClone(closureCurrent))).toEqual({
      kind: "required",
      code: "NATIVE_OBSERVATION_REQUIRED",
      reason: "invalid-observation",
    });
  });

  it("has no current runtime or evidence cutover import", () => {
    for (const rel of [
      "src/trust/scan.ts",
      "src/trust/evidence.ts",
      "src/baseline-evidence/vet.ts",
    ]) {
      expect(sourceText(rel)).not.toMatch(/observation\/native-observation-v1/);
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
