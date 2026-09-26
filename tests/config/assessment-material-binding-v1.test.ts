import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_ASSESSMENT_BYTES_V1, verifyAssessmentMaterialBindingV1 } from "../../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures.
//
// `assessment-profile.json` is a byte-exact copy of the published first-party
// qualification profile for agent.aih.governance-quality, and
// `capture-facts.json` is a recorded reading of one preserved scan capture. The
// recorded reading is a diagnostic record, never evidence: nothing here is
// verified, approved, or a measured detector result, and no detector runs.
//
// The proof under test recomputes every digest it relies on, so the fixtures
// are inputs to that recomputation rather than assertions to be trusted.
// ---------------------------------------------------------------------------

const fixtures = new URL(
  "../fixtures/governance-input/genuine-capture-20260921160506/",
  import.meta.url,
);
const assessmentBytes = readFileSync(new URL("assessment-profile.json", fixtures));

type FileRecord = { kind: "file"; path: string; sha256: string; byteLength: number };
interface SealRecords {
  protocol: "SourceSealV2";
  algorithm: "code-unit-canonical-json-v1";
  entries: FileRecord[];
  selectedClosurePaths: string[];
  selectedFiles: FileRecord[];
  sourceTreeSha256: string;
  selectedClosureSha256: string;
  sealedSnapshotSha256: string;
}
interface CaptureRecord {
  catalog: { subject: { source: { revision: string } } };
  facts: {
    subject: { digest: { sha256: string } };
    coverage: { sha256: string };
    sourceSeals: { before: SealRecords; after: SealRecords };
  };
}

const capture = JSON.parse(
  readFileSync(new URL("capture-facts.json", fixtures), "utf8"),
) as CaptureRecord;

const identityDigest = capture.catalog.subject.source.revision;
const genuineSeal = capture.facts.sourceSeals.before;
const expected = {
  sourceTreeSha256: capture.facts.subject.digest.sha256,
  selectedClosureSha256: capture.facts.coverage.sha256,
};
const ROOT = "packs/governance-quality/aih-gov-doctor";
const DECLARED_TREE_DIGEST =
  "sha256:a72ef33803283dc2950f50bb238ed915cf86c069964a1971cc3a38510ede4c1c";

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => ordinal(a, b))
      .map(([k, c]) => `${JSON.stringify(k)}:${stableJson(c)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const digest = (bare: string) => `sha256:${bare}`;

function digestOf(name: string): string {
  const record = genuineSeal.selectedFiles.find((file) => file.path === name);
  if (record === undefined) throw new Error(`the recorded capture is missing ${name}`);
  return record.sha256;
}

/** Builds a seal whose three digests are genuinely recomputed from its records. */
function buildSeal(
  files: readonly FileRecord[],
  options: { extraSelectedPaths?: readonly string[]; mutateByteLength?: boolean } = {},
): SealRecords {
  const records = files.map((file) => ({
    kind: "file" as const,
    path: file.path,
    sha256: file.sha256,
    byteLength:
      options.mutateByteLength === true && file.path === "SKILL.md"
        ? file.byteLength + 1
        : file.byteLength,
  }));
  const sourceTreeSha256 = sha(stableJson({ protocol: "SourceTreeV2", entries: records }));
  const selectedClosureSha256 = sha(stableJson({ protocol: "SelectedClosureV2", files: records }));
  return {
    protocol: "SourceSealV2",
    algorithm: "code-unit-canonical-json-v1",
    entries: records,
    selectedClosurePaths: [
      ...records.map((file) => file.path),
      ...(options.extraSelectedPaths ?? []),
    ],
    selectedFiles: records,
    sourceTreeSha256,
    selectedClosureSha256,
    sealedSnapshotSha256: sha(
      stableJson({ protocol: "SealedSnapshotV2", sourceTreeSha256, selectedClosureSha256 }),
    ),
  };
}

/** A synthetic declaration whose identity is the digest of its own bytes. */
function buildAssessment(input: {
  files: readonly { digest: string; path: string }[];
  roots: readonly string[];
  format?: string;
}): { bytes: Buffer; identityDigest: string } {
  const bytes = Buffer.from(
    `${JSON.stringify({
      format: input.format ?? "aih-first-party-qualification-profile",
      material: {
        files: input.files,
        kind: "source-files",
        treeDigest: digest("7".repeat(64)),
      },
      scanner: { component: { paths: input.roots } },
      version: 1,
    })}\n`,
    "utf8",
  );
  return { bytes, identityDigest: digest(sha(bytes)) };
}

function expectedFor(seal: SealRecords) {
  return {
    sourceTreeSha256: seal.sourceTreeSha256,
    selectedClosureSha256: seal.selectedClosureSha256,
  };
}

/** Three declared files under one root, with a basename duplicated across roots. */
function duplicateBasenameDeclaration() {
  const digests = { x: sha("x-skill"), y: sha("y-skill"), note: sha("y-note") };
  return {
    digests,
    declaration: buildAssessment({
      files: [
        { digest: digest(digests.x), path: "x/SKILL.md" },
        { digest: digest(digests.y), path: "y/SKILL.md" },
        { digest: digest(digests.note), path: "y/note.txt" },
      ],
      roots: ["x", "y"],
    }),
  };
}

describe("committed capture fixture", () => {
  it("keeps the recorded identity and seal digests independently reproducible", () => {
    expect(digest(sha(assessmentBytes))).toBe(capture.catalog.subject.source.revision);

    const sourceTreeSha256 = sha(
      stableJson({ protocol: "SourceTreeV2", entries: genuineSeal.entries }),
    );
    const selectedClosureSha256 = sha(
      stableJson({ protocol: "SelectedClosureV2", files: genuineSeal.selectedFiles }),
    );
    const sealedSnapshotSha256 = sha(
      stableJson({ protocol: "SealedSnapshotV2", sourceTreeSha256, selectedClosureSha256 }),
    );
    expect(sourceTreeSha256).toBe(genuineSeal.sourceTreeSha256);
    expect(selectedClosureSha256).toBe(genuineSeal.selectedClosureSha256);
    expect(sealedSnapshotSha256).toBe(genuineSeal.sealedSnapshotSha256);
    expect(sourceTreeSha256).toBe(expected.sourceTreeSha256);
    expect(selectedClosureSha256).toBe(expected.selectedClosureSha256);
    expect(stableJson(capture.facts.sourceSeals.after)).toBe(stableJson(genuineSeal));
  });
});

describe("assessment to material binding", () => {
  it("binds the scanned material to the assessment identity", () => {
    const result = verifyAssessmentMaterialBindingV1({
      assessment: { bytes: assessmentBytes, identityDigest },
      seal: genuineSeal,
      expected,
    });
    if (result.status !== "bound") throw new Error(`expected bound, got ${result.reason}`);

    expect(result.materialRoot).toBe(ROOT);
    expect(result.assessment).toEqual({
      identityDigest,
      format: "aih-first-party-qualification-profile",
      materialKind: "source-files",
      declaredTreeDigest: DECLARED_TREE_DIGEST,
    });
    expect(result.scannedMaterial.sourceTreeSha256).toBe(expected.sourceTreeSha256);
    expect(result.scannedMaterial.selectedClosureSha256).toBe(expected.selectedClosureSha256);
    expect(result.scannedMaterial.files).toEqual([
      {
        path: "LICENSE",
        declaredPath: `${ROOT}/LICENSE`,
        sha256: digestOf("LICENSE"),
        byteLength: 598,
      },
      {
        path: "SKILL.md",
        declaredPath: `${ROOT}/SKILL.md`,
        sha256: digestOf("SKILL.md"),
        byteLength: 787,
      },
      {
        path: "profile.json",
        declaredPath: `${ROOT}/profile.json`,
        sha256: digestOf("profile.json"),
        byteLength: 1126,
      },
    ]);
    // Binding the scanned material is never a claim that the whole item was
    // scanned: the declaration carries a file the capture never covered.
    expect(result.itemCoverage.uncoveredPaths).toEqual(["aih-packs.json"]);
    expect(result.itemCoverage.complete).toBe(false);
    expect(result.itemCoverage.declaredFiles).toHaveLength(4);
    expect(result.itemCoverage.coveredDeclaredPaths).toEqual([
      `${ROOT}/LICENSE`,
      `${ROOT}/SKILL.md`,
      `${ROOT}/profile.json`,
    ]);
  });

  it("refuses an identity the assessment bytes do not hash to", () => {
    expect(
      verifyAssessmentMaterialBindingV1({
        assessment: { bytes: assessmentBytes, identityDigest: digest("0".repeat(64)) },
        seal: genuineSeal,
        expected,
      }),
    ).toEqual({ status: "unbound", reason: "assessment-bytes-do-not-match-identity" });
  });

  it("refuses assessment bytes that changed under a matching identity string", () => {
    const mutated = Buffer.from(assessmentBytes);
    const index = Math.floor(mutated.length / 2);
    mutated[index] = (mutated[index] ?? 0) ^ 0x20;
    expect(
      verifyAssessmentMaterialBindingV1({
        assessment: { bytes: mutated, identityDigest },
        seal: genuineSeal,
        expected,
      }),
    ).toEqual({ status: "unbound", reason: "assessment-bytes-do-not-match-identity" });
  });

  it("ignores caller-supplied claims about the declared files, root and coverage", () => {
    const genuine = verifyAssessmentMaterialBindingV1({
      assessment: { bytes: assessmentBytes, identityDigest },
      seal: genuineSeal,
      expected,
    });
    const withCallerClaims = {
      assessment: { bytes: assessmentBytes, identityDigest },
      declaredFiles: ["LICENSE"],
      materialRoot: ".",
      seal: genuineSeal,
      uncoveredPaths: [],
      expected,
    };
    expect(verifyAssessmentMaterialBindingV1(withCallerClaims)).toEqual(genuine);
  });

  it("refuses a sealed path that only matches by basename", () => {
    const assessment = buildAssessment({
      files: ["LICENSE", "SKILL.md", "profile.json"].map((name) => ({
        digest: digest(digestOf(name)),
        path: `${ROOT}/nested/${name}`,
      })),
      roots: [ROOT],
    });
    expect(verifyAssessmentMaterialBindingV1({ assessment, seal: genuineSeal, expected })).toEqual({
      status: "unbound",
      reason: "sealed-path-not-declared",
    });
  });

  it("binds nested relative paths at depth", () => {
    const root = "a/b/c/d";
    const files: FileRecord[] = [
      { kind: "file", path: "x/y.txt", sha256: sha("one"), byteLength: 3 },
      { kind: "file", path: "LICENSE", sha256: sha("two!"), byteLength: 4 },
    ];
    const seal = buildSeal(files);
    const assessment = buildAssessment({
      files: files.map((file) => ({ digest: digest(file.sha256), path: `${root}/${file.path}` })),
      roots: [root],
    });
    const result = verifyAssessmentMaterialBindingV1({
      assessment,
      seal,
      expected: expectedFor(seal),
    });
    if (result.status !== "bound") throw new Error(`expected bound, got ${result.reason}`);
    expect(result.materialRoot).toBe(root);
    expect(result.scannedMaterial.files.map((file) => file.declaredPath)).toEqual([
      `${root}/LICENSE`,
      `${root}/x/y.txt`,
    ]);
  });

  it("picks the root whose exact relative paths match when basenames are duplicated", () => {
    const { declaration, digests } = duplicateBasenameDeclaration();
    const seal = buildSeal([
      { kind: "file", path: "SKILL.md", sha256: digests.y, byteLength: 6 },
      { kind: "file", path: "note.txt", sha256: digests.note, byteLength: 6 },
    ]);
    const result = verifyAssessmentMaterialBindingV1({
      assessment: declaration,
      seal,
      expected: expectedFor(seal),
    });
    if (result.status !== "bound") throw new Error(`expected bound, got ${result.reason}`);
    expect(result.materialRoot).toBe("y");
    expect(result.itemCoverage.coveredDeclaredPaths).toEqual(["y/SKILL.md", "y/note.txt"]);
    expect(result.itemCoverage.uncoveredPaths).toEqual(["x/SKILL.md"]);
  });

  it("refuses a duplicate basename carrying the other file's digest", () => {
    const { declaration, digests } = duplicateBasenameDeclaration();
    const seal = buildSeal([
      { kind: "file", path: "SKILL.md", sha256: digests.x, byteLength: 6 },
      { kind: "file", path: "note.txt", sha256: digests.note, byteLength: 6 },
    ]);
    expect(
      verifyAssessmentMaterialBindingV1({
        assessment: declaration,
        seal,
        expected: expectedFor(seal),
      }),
    ).toEqual({ status: "mismatched", reason: "declared-digest-mismatch" });
  });

  it("fails closed when two declared roots both contain every sealed path", () => {
    const { declaration, digests } = duplicateBasenameDeclaration();
    const seal = buildSeal([{ kind: "file", path: "SKILL.md", sha256: digests.y, byteLength: 6 }]);
    expect(
      verifyAssessmentMaterialBindingV1({
        assessment: declaration,
        seal,
        expected: expectedFor(seal),
      }),
    ).toEqual({ status: "unbound", reason: "declared-material-root-not-unique" });
  });

  it("refuses a declared digest that is another declared file's digest", () => {
    const assessment = buildAssessment({
      files: [
        { digest: digest(digestOf("SKILL.md")), path: `${ROOT}/LICENSE` },
        { digest: digest(digestOf("LICENSE")), path: `${ROOT}/SKILL.md` },
        { digest: digest(digestOf("profile.json")), path: `${ROOT}/profile.json` },
      ],
      roots: [ROOT],
    });
    expect(verifyAssessmentMaterialBindingV1({ assessment, seal: genuineSeal, expected })).toEqual({
      status: "mismatched",
      reason: "declared-digest-mismatch",
    });
  });

  it("refuses a declared path that tries to escape its root", () => {
    const assessment = buildAssessment({
      files: [
        { digest: digest(digestOf("LICENSE")), path: `${ROOT}/../LICENSE` },
        { digest: digest(digestOf("SKILL.md")), path: `${ROOT}/SKILL.md` },
        { digest: digest(digestOf("profile.json")), path: `${ROOT}/profile.json` },
      ],
      roots: [ROOT],
    });
    expect(verifyAssessmentMaterialBindingV1({ assessment, seal: genuineSeal, expected })).toEqual({
      status: "unbound",
      reason: "assessment-declaration-unreadable",
    });
  });

  it("refuses a seal whose stored file length changed after verification", () => {
    expect(
      verifyAssessmentMaterialBindingV1({
        assessment: { bytes: assessmentBytes, identityDigest },
        seal: buildSeal(genuineSeal.selectedFiles, { mutateByteLength: true }),
        expected,
      }),
    ).toEqual({ status: "mismatched", reason: "seal-digest-recomputation-mismatch" });
  });

  it("refuses a fabricated seal that is internally consistent", () => {
    const kept = genuineSeal.selectedFiles.filter((file) => file.path !== "SKILL.md");
    expect(
      verifyAssessmentMaterialBindingV1({
        assessment: { bytes: assessmentBytes, identityDigest },
        seal: buildSeal(kept),
        expected,
      }),
    ).toEqual({ status: "mismatched", reason: "seal-digest-recomputation-mismatch" });
  });

  it("refuses a seal whose stored closure digest was tampered with", () => {
    expect(
      verifyAssessmentMaterialBindingV1({
        assessment: { bytes: assessmentBytes, identityDigest },
        seal: { ...genuineSeal, selectedClosureSha256: "0".repeat(64) },
        expected,
      }),
    ).toEqual({ status: "mismatched", reason: "seal-digest-recomputation-mismatch" });
  });

  it("refuses a selection that claims a path the seal has no file record for", () => {
    expect(
      verifyAssessmentMaterialBindingV1({
        assessment: { bytes: assessmentBytes, identityDigest },
        seal: buildSeal(genuineSeal.selectedFiles, { extraSelectedPaths: ["aih-packs.json"] }),
        expected,
      }),
    ).toEqual({ status: "mismatched", reason: "seal-selection-inconsistent" });
  });

  it("refuses a declaration that declares no files", () => {
    expect(
      verifyAssessmentMaterialBindingV1({
        assessment: buildAssessment({ files: [], roots: [ROOT] }),
        seal: genuineSeal,
        expected,
      }),
    ).toEqual({ status: "unbound", reason: "assessment-declaration-unreadable" });
  });

  it("refuses identity-matching bytes that are not the declared assessment format", () => {
    const bytes = Buffer.from(
      `${JSON.stringify({
        files: [],
        format: "aih-supported-catalog-member-closure",
        version: 1,
      })}\n`,
      "utf8",
    );
    expect(
      verifyAssessmentMaterialBindingV1({
        assessment: { bytes, identityDigest: digest(sha(bytes)) },
        seal: genuineSeal,
        expected,
      }),
    ).toEqual({ status: "unbound", reason: "assessment-declaration-unreadable" });
  });

  it("reports complete item coverage when the declaration holds only scanned files", () => {
    const root = "only";
    const files: FileRecord[] = [
      { kind: "file", path: "LICENSE", sha256: sha("l"), byteLength: 1 },
      { kind: "file", path: "SKILL.md", sha256: sha("s"), byteLength: 1 },
    ];
    const seal = buildSeal(files);
    const assessment = buildAssessment({
      files: files.map((file) => ({ digest: digest(file.sha256), path: `${root}/${file.path}` })),
      roots: [root],
    });
    const result = verifyAssessmentMaterialBindingV1({
      assessment,
      seal,
      expected: expectedFor(seal),
    });
    if (result.status !== "bound") throw new Error(`expected bound, got ${result.reason}`);
    expect(result.itemCoverage.complete).toBe(true);
    expect(result.itemCoverage.uncoveredPaths).toEqual([]);
  });
});

describe("assessment binding input validation", () => {
  const invalid = { status: "unbound", reason: "invalid-input" };

  it("refuses every assessment byte value that is not bounded content", () => {
    const oversize = new Uint8Array(MAX_ASSESSMENT_BYTES_V1 + 1);
    for (const bytes of [null, {}, 42, "string", [], new Uint8Array(0), oversize, undefined]) {
      expect(
        verifyAssessmentMaterialBindingV1({
          assessment: { bytes, identityDigest },
          seal: genuineSeal,
          expected,
        }),
      ).toEqual(invalid);
    }
  });

  it("refuses every identity that is not a prefixed lower-case sha256 digest", () => {
    for (const value of [
      42,
      null,
      undefined,
      {},
      identityDigest.slice("sha256:".length),
      digest(sha(assessmentBytes).toUpperCase()),
      `SHA256:${sha(assessmentBytes)}`,
    ]) {
      expect(
        verifyAssessmentMaterialBindingV1({
          assessment: { bytes: assessmentBytes, identityDigest: value },
          seal: genuineSeal,
          expected,
        }),
      ).toEqual(invalid);
    }
  });

  it("refuses every seal that is not an exact bounded SourceSealV2", () => {
    const entry: FileRecord = {
      kind: "file",
      path: "LICENSE",
      sha256: "0".repeat(64),
      byteLength: 1,
    };
    const base = buildSeal([entry]);
    for (const seal of [
      null,
      undefined,
      42,
      "SourceSealV2",
      {},
      { ...base, entries: [{ ...entry, path: "../LICENSE" }] },
      { ...base, selectedClosurePaths: ["../LICENSE"] },
      {
        ...base,
        entries: Array.from({ length: 4097 }, (_unused, index) => ({
          ...entry,
          path: `file-${index}.txt`,
        })),
      },
      { ...base, unknownMember: true },
    ]) {
      expect(
        verifyAssessmentMaterialBindingV1({
          assessment: { bytes: assessmentBytes, identityDigest },
          seal,
          expected,
        }),
      ).toEqual(invalid);
    }
  });

  it("refuses expected digests that are absent or not bare hex", () => {
    for (const value of [
      undefined,
      null,
      {},
      { sourceTreeSha256: expected.sourceTreeSha256 },
      { ...expected, selectedClosureSha256: digest(expected.selectedClosureSha256) },
      { ...expected, sourceTreeSha256: expected.sourceTreeSha256.toUpperCase() },
    ]) {
      expect(
        verifyAssessmentMaterialBindingV1({
          assessment: { bytes: assessmentBytes, identityDigest },
          seal: genuineSeal,
          expected: value as never,
        }),
      ).toEqual(invalid);
    }
  });

  it("refuses an absent input without throwing", () => {
    for (const value of [undefined, null, 42, "input", []]) {
      expect(verifyAssessmentMaterialBindingV1(value as never)).toEqual(invalid);
    }
  });
});
