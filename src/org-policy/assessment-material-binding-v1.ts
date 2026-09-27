/**
 * Binding a published assessment identity to the material a scan actually covered.
 *
 * A first-party qualification profile names the files an item is made of. A scan
 * seals the files it read. Neither document can speak for the other, so Core
 * proves the relationship during consumption: the assessment artifact's BYTES
 * are hashed against the identity the saved subject carries, the declared file
 * list is read out of exactly those verified bytes, every seal digest is
 * recomputed from the seal's own records and required to equal the freshly
 * verified attestation facts, and declared paths are matched exactly under one
 * unambiguous root — never by basename.
 *
 * Nothing here is authority, qualification, admission, or a measured detector
 * result, and binding the scanned material is never a claim that the whole item
 * was scanned: `scannedMaterial` and `itemCoverage` stay separate verdicts.
 *
 * This module is self-contained on purpose — `governance-input-v1.ts` imports it
 * to choose a binding route, so it may not import back.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

/** The declared format of a first-party qualification profile. */
export const ASSESSMENT_MATERIAL_FORMAT_V1 = "aih-first-party-qualification-profile";
/** Bound the published artifact before decoding hostile input. */
export const MAX_ASSESSMENT_BYTES_V1 = 256 * 1024;

const MAX_DECLARED_RECORDS_V1 = 4_096;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BARE_SHA256 = /^[0-9a-f]{64}$/;

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Code-unit canonical JSON; the same algorithm the seal digests use. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => ordinalCompare(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256BytesHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// --------------------------------------------------------------------------
// Refusals and results
// --------------------------------------------------------------------------

/** Closed, public-safe refusal category; never carries a filesystem path or verifier output. */
export type AssessmentMaterialBindingRefusalV1 =
  | "invalid-input"
  | "assessment-bytes-do-not-match-identity"
  | "assessment-declaration-unreadable"
  | "declared-material-root-not-unique"
  | "sealed-path-not-declared"
  | "declared-digest-mismatch"
  | "seal-selection-inconsistent"
  | "seal-digest-recomputation-mismatch";

export interface AssessmentMaterialBindingBoundV1 {
  readonly status: "bound";
  readonly assessment: {
    /** Restated from the verified bytes, never from the caller's string. */
    readonly identityDigest: string;
    readonly format: typeof ASSESSMENT_MATERIAL_FORMAT_V1;
    readonly materialKind: "source-files";
    /** The profile's own declared claim, never this capture's seal. */
    readonly declaredTreeDigest: string;
  };
  /** The unique declared root that contains every sealed path. */
  readonly materialRoot: string;
  readonly scannedMaterial: {
    readonly sourceTreeSha256: string;
    readonly selectedClosureSha256: string;
    readonly files: readonly {
      readonly path: string;
      readonly declaredPath: string;
      readonly sha256: string;
      readonly byteLength: number;
    }[];
  };
  /** Binding the scanned material is never a claim that the whole item was scanned. */
  readonly itemCoverage: {
    readonly complete: boolean;
    readonly declaredFiles: readonly string[];
    readonly coveredDeclaredPaths: readonly string[];
    readonly uncoveredPaths: readonly string[];
  };
}

export type AssessmentMaterialBindingV1 =
  | AssessmentMaterialBindingBoundV1
  | {
      readonly status: "unbound" | "mismatched";
      readonly reason: AssessmentMaterialBindingRefusalV1;
    };

export interface VerifyAssessmentMaterialBindingV1Input {
  readonly assessment: { readonly bytes: unknown; readonly identityDigest: unknown };
  readonly seal: unknown;
  readonly expected: { readonly sourceTreeSha256: string; readonly selectedClosureSha256: string };
}

// --------------------------------------------------------------------------
// Declaration and seal contracts
// --------------------------------------------------------------------------

const digestSchema = z.string().regex(SHA256, "must be a sha256 digest");
const bareDigestSchema = z.string().regex(BARE_SHA256, "must be a bare sha256 digest");
const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      value === value.trim() &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "must be a bounded root-relative path",
  );

const sealFileSchema = z
  .object({
    kind: z.literal("file"),
    path: relativePathSchema,
    sha256: bareDigestSchema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict();
const sealDirectorySchema = z
  .object({ kind: z.literal("directory"), path: relativePathSchema })
  .strict();
const sealSchema = z
  .object({
    protocol: z.literal("SourceSealV2"),
    algorithm: z.literal("code-unit-canonical-json-v1"),
    entries: z
      .array(z.union([sealFileSchema, sealDirectorySchema]))
      .min(1)
      .max(MAX_DECLARED_RECORDS_V1),
    selectedClosurePaths: z.array(relativePathSchema).min(1).max(MAX_DECLARED_RECORDS_V1),
    selectedFiles: z.array(sealFileSchema).min(1).max(MAX_DECLARED_RECORDS_V1),
    sourceTreeSha256: bareDigestSchema,
    selectedClosureSha256: bareDigestSchema,
    sealedSnapshotSha256: bareDigestSchema,
  })
  .strict();

/**
 * Only the members the binding reads. A published profile also carries asset,
 * compiler, observation, scope and subject members; those are ignored rather
 * than refused, and no caller-supplied member reaches this schema at all.
 */
const declarationSchema = z.object({
  format: z.literal(ASSESSMENT_MATERIAL_FORMAT_V1),
  material: z.object({
    files: z
      .array(z.object({ digest: digestSchema, path: relativePathSchema }))
      .min(1)
      .max(MAX_DECLARED_RECORDS_V1)
      .refine(
        (files) => new Set(files.map((file) => file.path)).size === files.length,
        "declared paths must be unique",
      ),
    kind: z.literal("source-files"),
    treeDigest: digestSchema,
  }),
  scanner: z.object({
    component: z.object({
      paths: z.array(relativePathSchema).min(1).max(MAX_DECLARED_RECORDS_V1),
    }),
  }),
  version: z.literal(1),
});

interface AssessmentDeclarationV1 {
  readonly declaredTreeDigest: string;
  readonly files: readonly { readonly path: string; readonly digest: string }[];
  readonly roots: readonly string[];
}

/** Reads the declaration out of the verified bytes only. Nothing here is caller-supplied. */
function readDeclaration(bytes: Uint8Array): AssessmentDeclarationV1 | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const parsed = declarationSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    declaredTreeDigest: parsed.data.material.treeDigest,
    files: parsed.data.material.files,
    roots: parsed.data.scanner.component.paths,
  };
}

// --------------------------------------------------------------------------
// The proof
// --------------------------------------------------------------------------

/**
 * Binds the material a scan covered to the identity of a published assessment.
 *
 * `assessment.bytes` are the published artifact and `assessment.identityDigest`
 * is the identity the SAVED subject carries; `seal` and `expected` must come
 * from freshly verified attestation facts, never from a caller's saved document.
 * Every input is hostile until proven otherwise: this function refuses rather
 * than throws, for any value of any member.
 */
export function verifyAssessmentMaterialBindingV1(
  input: VerifyAssessmentMaterialBindingV1Input,
): AssessmentMaterialBindingV1 {
  const bytes = input?.assessment?.bytes;
  const identityDigest = input?.assessment?.identityDigest;
  const expected = input?.expected;
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_ASSESSMENT_BYTES_V1 ||
    typeof identityDigest !== "string" ||
    !SHA256.test(identityDigest) ||
    typeof expected?.sourceTreeSha256 !== "string" ||
    !BARE_SHA256.test(expected.sourceTreeSha256) ||
    typeof expected.selectedClosureSha256 !== "string" ||
    !BARE_SHA256.test(expected.selectedClosureSha256)
  )
    return { status: "unbound", reason: "invalid-input" };
  const seal = sealSchema.safeParse(input.seal);
  if (!seal.success) return { status: "unbound", reason: "invalid-input" };

  // The bytes are the proof; a caller's hash string never is. This runs before
  // anything is parsed out of them.
  const assessmentSha256 = sha256BytesHex(bytes);
  if (assessmentSha256 !== identityDigest.slice("sha256:".length))
    return { status: "unbound", reason: "assessment-bytes-do-not-match-identity" };

  const declaration = readDeclaration(bytes);
  if (declaration === undefined)
    return { status: "unbound", reason: "assessment-declaration-unreadable" };

  const records = seal.data;
  const sourceTreeSha256 = sha256Hex(
    stableJson({ protocol: "SourceTreeV2", entries: records.entries }),
  );
  const selectedClosureSha256 = sha256Hex(
    stableJson({ protocol: "SelectedClosureV2", files: records.selectedFiles }),
  );
  const sealedSnapshotSha256 = sha256Hex(
    stableJson({ protocol: "SealedSnapshotV2", sourceTreeSha256, selectedClosureSha256 }),
  );
  if (
    sourceTreeSha256 !== records.sourceTreeSha256 ||
    selectedClosureSha256 !== records.selectedClosureSha256 ||
    sealedSnapshotSha256 !== records.sealedSnapshotSha256 ||
    sourceTreeSha256 !== expected.sourceTreeSha256 ||
    selectedClosureSha256 !== expected.selectedClosureSha256
  )
    return { status: "mismatched", reason: "seal-digest-recomputation-mismatch" };

  const selectedPaths = records.selectedFiles.map((file) => file.path).sort(ordinalCompare);
  const claimedPaths = [...records.selectedClosurePaths].sort(ordinalCompare);
  if (
    claimedPaths.length !== selectedPaths.length ||
    claimedPaths.some((path, index) => path !== selectedPaths[index])
  )
    return { status: "mismatched", reason: "seal-selection-inconsistent" };

  // Exact paths under one declared root, never basenames.
  const declaredByPath = new Map(declaration.files.map((file) => [file.path, file.digest]));
  const [materialRoot, ...ambiguous] = declaration.roots.filter((root) =>
    records.selectedFiles.every((file) => declaredByPath.has(`${root}/${file.path}`)),
  );
  if (materialRoot === undefined) return { status: "unbound", reason: "sealed-path-not-declared" };
  if (ambiguous.length > 0)
    return { status: "unbound", reason: "declared-material-root-not-unique" };

  const files: { path: string; declaredPath: string; sha256: string; byteLength: number }[] = [];
  for (const file of records.selectedFiles) {
    const declaredPath = `${materialRoot}/${file.path}`;
    if (declaredByPath.get(declaredPath) !== `sha256:${file.sha256}`)
      return { status: "mismatched", reason: "declared-digest-mismatch" };
    files.push({
      path: file.path,
      declaredPath,
      sha256: file.sha256,
      byteLength: file.byteLength,
    });
  }

  // Coverage comes from the complete verified declaration, so no input can hide
  // a declared file the capture never read.
  const covered = new Set(files.map((file) => file.declaredPath));
  const declaredFiles = declaration.files.map((file) => file.path).sort(ordinalCompare);
  const uncoveredPaths = declaredFiles.filter((path) => !covered.has(path));

  return {
    status: "bound",
    assessment: {
      identityDigest: `sha256:${assessmentSha256}`,
      format: ASSESSMENT_MATERIAL_FORMAT_V1,
      materialKind: "source-files",
      declaredTreeDigest: declaration.declaredTreeDigest,
    },
    materialRoot,
    scannedMaterial: {
      sourceTreeSha256,
      selectedClosureSha256,
      files: files.sort((left, right) => ordinalCompare(left.path, right.path)),
    },
    itemCoverage: {
      complete: uncoveredPaths.length === 0,
      declaredFiles,
      coveredDeclaredPaths: [...covered].sort(ordinalCompare),
      uncoveredPaths,
    },
  };
}
