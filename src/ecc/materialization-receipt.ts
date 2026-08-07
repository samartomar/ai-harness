import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import { AuthorizationSchema } from "./registration.js";

/**
 * The per-component materialization receipt (F5).
 *
 * This is the byte-ownership record for components AIH materialized directly
 * into a destination root, and it is deliberately NOT the machine registration
 * ledger: the ledger (`registration-ledger.json`) stays the machine index —
 * which components, which targets, which authorization — and never becomes the
 * byte-ownership home. Ownership evidence belongs next to the owned bytes, so
 * this document is destination-root-scoped: it disappears with a deleted root
 * instead of dangling in machine state.
 *
 * It follows the two shipped receipt precedents (the profile ownership record
 * and the hook registrar receipt): a `format` discriminator, a strict Zod
 * schema, and fail-closed reads. A malformed or unrecognized receipt refuses
 * every ownership claim and degrades removal to an advisory — never a guess,
 * and never a delete.
 */

/** Where the receipt lives, relative to the destination root that holds the owned bytes. */
export const ECC_MATERIALIZATION_RECEIPT_PATH = ".aih/ecc/materialization-v1.json";
export const ECC_MATERIALIZATION_RECEIPT_FORMAT = "aih-ecc-materialization-receipt";

/**
 * AIH's own namespace at the root of a destination. Matched case-insensitively
 * on the FIRST segment and by prefix, so `.AIH/…` on a case-insensitive volume
 * and the root-level `.aih-config.json` governance marker are both refused: a
 * component that could write either could rewrite its own ownership or forge a
 * marker other AIH subsystems trust.
 */
const RESERVED_SEGMENT_PREFIX = ".aih";
/** Git executes what it finds here regardless of the mode bit. Never a destination. */
const RESERVED_SEGMENTS = new Set([".git"]);

const MAX_PATH_LENGTH = 1_024;
/**
 * The one byte bound. The ownership record is read back through the same
 * bounded reader as any other destination, so a record larger than a readable
 * file would be valid and unreadable at once — an install nothing could revoke.
 * Deriving the second name from the first makes the two impossible to disagree.
 */
export const MAX_MATERIALIZED_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_MATERIALIZED_COMPONENTS = 4_096;
export const MAX_MATERIALIZED_FILES_PER_COMPONENT = 2_048;
export const MAX_MATERIALIZED_OWNED_KEYS = 64;
export const MAX_MATERIALIZATION_RECEIPT_BYTES = MAX_MATERIALIZED_FILE_BYTES;
/** Deep enough for any real configuration, shallow enough that hashing cannot blow the stack. */
const MAX_JSON_DEPTH = 100;

const COMPONENT_ID = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/;
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * The ledger's own authorization schema, referenced rather than restated. A
 * restatement cannot notice a field ADDED upstream, which is the likeliest
 * direction of drift; sharing the object makes the two contracts the same
 * contract.
 */
export { AuthorizationSchema as eccMaterializationAuthorizationSchema };

function assertPortableRelativePath(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.replace(/\\/g, "/") : "";
  if (
    normalized.length === 0 ||
    normalized.length > MAX_PATH_LENGTH ||
    CONTROL_CHARACTERS.test(normalized) ||
    normalized.startsWith("/") ||
    normalized.split("/").some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        // A colon is a Windows drive or stream separator: `C:/x` is absolute
        // and `D:foo` is drive-relative, where `join` and `resolve` disagree
        // about where it points.
        segment.includes(":"),
    )
  ) {
    throw new Error(`unsafe ${label}: ${displaySafe(value)}`);
  }
  return normalized;
}

/**
 * Whether one path segment names a directory no component may write into or
 * through. Reserved-ness is a property of ANY segment, not just the first: a
 * nested repository's `.git/hooks` executes exactly like the outer one's, and
 * `sub/.aih/` is AIH state wherever it sits.
 */
export function reservedSegmentKind(segment: string): "aih" | "git" | undefined {
  const folded = segment.normalize("NFC").toLowerCase();
  if (folded.startsWith(RESERVED_SEGMENT_PREFIX)) return "aih";
  return RESERVED_SEGMENTS.has(folded) ? "git" : undefined;
}

/**
 * Refuse a reserved segment anywhere in a path. Callers pass BOTH the requested
 * spelling (catching names that do not exist yet) and, once the filesystem has
 * resolved them, the real segments — because a requested string is not what the
 * OS opens. On NTFS with 8.3 generation, `GIT~1` opens `.git`; the string is
 * innocent and the resolved path is not.
 */
export function assertUnreservedSegments(segments: readonly string[], requested: string): void {
  for (const segment of segments) {
    const kind = reservedSegmentKind(segment);
    if (kind === "aih") {
      throw new Error(
        `ECC materialization destination claims AIH's own state area: ${displaySafe(requested)}`,
      );
    }
    if (kind === "git") {
      throw new Error(
        `ECC materialization destination claims the git directory: ${displaySafe(requested)}`,
      );
    }
  }
}

/**
 * Normalize and validate a destination-relative path a component may own.
 * Traversal, absolute inputs, AIH's own state area, and Git's directory are
 * refused rather than repaired. This is the STRING gate; the filesystem
 * boundary repeats the reserved check on what each segment actually resolves to.
 */
export function assertOwnedRelativePath(value: string): string {
  const path = assertPortableRelativePath(value, "ECC materialization destination");
  assertUnreservedSegments(path.split("/"), value);
  return path;
}

/**
 * Neutralise and bound a value before it reaches an operator-facing message. A
 * component id or JSON key is third-party text: unbounded it produces a
 * 200,000-character error, and with terminal controls it can forge output
 * inside AIH's own refusal.
 */
export function displaySafe(value: string, max = 120): string {
  const rendered = String(value)
    .replace(/[\r\n]+/g, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return rendered.length > max ? `${rendered.slice(0, max)}…` : rendered;
}

/** Validate a component id at the boundary, so no unbounded id reaches a message. */
export function assertMaterializedComponentId(value: string): string {
  const result = ComponentIdSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`unusable ECC materialization component id: ${displaySafe(value)}`);
  }
  return result.data;
}

/** Validate an owned JSON key at the boundary, for the same reason. */
export function assertOwnedJsonKey(value: string): string {
  const result = OwnedKeySchema.safeParse(value);
  if (!result.success) {
    throw new Error(`unusable ECC materialization JSON key: ${displaySafe(value)}`);
  }
  return result.data;
}

/**
 * Whether a value nests deeper than this engine renders. Iterative on purpose:
 * `JSON.parse` accepts documents far deeper than `JSON.stringify` survives, so
 * the check that guards the renderer must not itself recurse.
 */
export function exceedsJsonDepth(value: unknown, max = MAX_JSON_DEPTH): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    if (entry.depth > max) return true;
    const current = entry.value;
    if (Array.isArray(current)) {
      for (const child of current) stack.push({ value: child, depth: entry.depth + 1 });
      continue;
    }
    if (current !== null && typeof current === "object") {
      for (const child of Object.values(current as Record<string, unknown>)) {
        stack.push({ value: child, depth: entry.depth + 1 });
      }
    }
  }
  return false;
}

/** Validate a source-side component path (provenance), which never touches the destination. */
export function assertComponentSourcePath(value: string): string {
  return assertPortableRelativePath(value, "ECC component source path");
}

/**
 * The identity two destinations collide on. Case folding and Unicode
 * normalization both resolve to one file on the platforms AIH targets, so
 * comparing raw strings would let two components claim the same bytes.
 */
export function destinationIdentity(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

const normalizedDestinationPath = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine((value) => {
    try {
      return assertOwnedRelativePath(value) === value;
    } catch {
      return false;
    }
  }, "owned destination path is unsafe or not normalized");

const ComponentIdSchema = z.string().min(3).max(160).regex(COMPONENT_ID);

const ProvenanceSchema = z
  .object({
    repository: z.string().min(1).max(240).regex(REPOSITORY),
    commit: z.string().regex(SHA40),
    componentPath: z
      .string()
      .min(1)
      .max(MAX_PATH_LENGTH)
      .refine((value) => {
        try {
          return assertComponentSourcePath(value) === value;
        } catch {
          return false;
        }
      }, "component source path is unsafe or not normalized"),
  })
  .strict();

const OwnedKeySchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) => !CONTROL_CHARACTERS.test(value) && value !== "__proto__",
    "owned JSON key is unusable",
  );

const OwnedFileSchema = z.discriminatedUnion("operation", [
  z
    .object({
      path: normalizedDestinationPath,
      operation: z.literal("copy-file"),
      contentSha256: z.string().regex(SHA256),
    })
    .strict(),
  z
    .object({
      path: normalizedDestinationPath,
      operation: z.literal("merge-json"),
      contentSha256: z.string().regex(SHA256),
      ownedKeys: z.array(OwnedKeySchema).min(1).max(MAX_MATERIALIZED_OWNED_KEYS),
      createdByAih: z.boolean(),
    })
    .strict(),
]);

const ComponentSchema = z
  .object({
    id: ComponentIdSchema,
    authorization: AuthorizationSchema,
    provenance: ProvenanceSchema,
    files: z.array(OwnedFileSchema).min(1).max(MAX_MATERIALIZED_FILES_PER_COMPONENT),
  })
  .strict()
  .superRefine((component, context) => {
    duplicateIssues(
      component.files.map((file) => destinationIdentity(file.path)),
      "owned file",
      context,
    );
    for (const file of component.files) {
      if (file.operation !== "merge-json") continue;
      duplicateIssues(file.ownedKeys, "owned JSON key", context);
    }
  });

const ReceiptSchema = z
  .object({
    format: z.literal(ECC_MATERIALIZATION_RECEIPT_FORMAT),
    schemaVersion: z.literal(1),
    components: z.array(ComponentSchema).min(1).max(MAX_MATERIALIZED_COMPONENTS),
  })
  .strict()
  .superRefine((receipt, context) => {
    duplicateIssues(
      receipt.components.map((component) => component.id),
      "component",
      context,
    );
  });

export type EccMaterializationOperation = "copy-file" | "merge-json";
export type EccOwnedFile = z.infer<typeof OwnedFileSchema>;
export type EccComponentProvenance = z.infer<typeof ProvenanceSchema>;
export type EccMaterializedComponent = z.infer<typeof ComponentSchema>;
export type EccMaterializationReceipt = z.infer<typeof ReceiptSchema>;

export type EccMaterializationReceiptRead =
  | { state: "absent" }
  | { state: "valid"; receipt: EccMaterializationReceipt; raw: string }
  | { state: "malformed"; detail: string };

function duplicateIssues(
  values: readonly string[],
  label: string,
  context: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      context.addIssue({ code: "custom", message: `duplicate ${label}: ${value}` });
    }
    seen.add(value);
  }
}

function byText(left: string, right: string): number {
  return left.localeCompare(right);
}

function normalizeReceipt(receipt: EccMaterializationReceipt): EccMaterializationReceipt {
  return {
    format: ECC_MATERIALIZATION_RECEIPT_FORMAT,
    schemaVersion: 1,
    components: [...receipt.components]
      .map((component) => ({
        ...component,
        files: [...component.files]
          .map((file) =>
            file.operation === "merge-json"
              ? { ...file, ownedKeys: [...file.ownedKeys].sort(byText) }
              : { ...file },
          )
          .sort((left, right) => byText(left.path, right.path)),
      }))
      .sort((left, right) => byText(left.id, right.id)),
  };
}

export function parseEccMaterializationReceipt(text: string): EccMaterializationReceipt {
  try {
    return normalizeReceipt(ReceiptSchema.parse(JSON.parse(text)));
  } catch (error) {
    throw new Error(`invalid ECC materialization receipt: ${(error as Error).message}`);
  }
}

/**
 * Validate and render the receipt. Every failure is wrapped, so a raw schema
 * error never escapes to an operator, and the size bound the READ enforces is
 * enforced here too — a receipt too large to read back is an install nothing
 * could ever revoke.
 */
export function serializeEccMaterializationReceipt(receipt: EccMaterializationReceipt): string {
  let text: string;
  try {
    text = `${JSON.stringify(normalizeReceipt(ReceiptSchema.parse(receipt)), null, 2)}\n`;
  } catch (error) {
    throw new Error(`invalid ECC materialization receipt: ${(error as Error).message}`);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_MATERIALIZATION_RECEIPT_BYTES) {
    throw new Error(
      "invalid ECC materialization receipt: it would exceed the size this engine can read back",
    );
  }
  return text;
}

export function eccMaterializationReceiptPath(root: string): string {
  if (!isAbsolute(root)) throw new Error("ECC materialization root must be absolute");
  return join(root, ...ECC_MATERIALIZATION_RECEIPT_PATH.split("/"));
}

/**
 * Fail-closed read. Anything that is not a readable, contained, regular file
 * holding a valid receipt reports `malformed` instead of throwing, so callers
 * can refuse ownership claims and degrade removal to an advisory without ever
 * guessing what AIH owns.
 */
export function readEccMaterializationReceipt(root: string): EccMaterializationReceiptRead {
  eccMaterializationReceiptPath(root);
  const inspected = inspectContainedRelativePath(root, ECC_MATERIALIZATION_RECEIPT_PATH);
  if (inspected.state === "absent") return { state: "absent" };
  if (inspected.state === "unsafe" || inspected.kind !== "file") {
    return {
      state: "malformed",
      detail: `invalid ECC materialization receipt: ${ECC_MATERIALIZATION_RECEIPT_PATH} is not a contained regular file`,
    };
  }
  const opened = readRegularFileWithStats(inspected.realPath, {
    maxBytes: MAX_MATERIALIZATION_RECEIPT_BYTES,
  });
  if (opened === undefined) {
    return {
      state: "malformed",
      detail: `invalid ECC materialization receipt: ${ECC_MATERIALIZATION_RECEIPT_PATH} is unreadable or oversized`,
    };
  }
  const raw = opened.contents.toString("utf8");
  try {
    return { state: "valid", receipt: parseEccMaterializationReceipt(raw), raw };
  } catch (error) {
    return { state: "malformed", detail: (error as Error).message };
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .digest("hex");
}

/** The digest a `copy-file` entry pins: the exact bytes written to the destination. */
export function ownedFileSha256(bytes: Buffer | string): string {
  return sha256(bytes);
}

/**
 * The digest a `merge-json` entry pins: the owned fragment in a canonical,
 * key-sorted form. Scoping the digest to the owned keys is what lets an
 * operator edit their own keys in the same document without the edit reading as
 * drift on AIH's.
 */
export function ownedFragmentSha256(fragment: Record<string, unknown>): string {
  return sha256(canonicalJsonText(fragment));
}

/**
 * Deterministic JSON text — key-sorted at every depth, bounded in depth so a
 * hostile or merely silly owned value fails as an error instead of a stack
 * overflow. Digests only.
 */
function canonicalJsonText(value: unknown, depth = 0): string {
  if (depth > MAX_JSON_DEPTH) {
    throw new Error("ECC materialization JSON value is nested beyond the depth this engine hashes");
  }
  if (Array.isArray(value)) {
    return `[${value.map((child) => canonicalJsonText(child, depth + 1)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => byText(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJsonText(child, depth + 1)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
