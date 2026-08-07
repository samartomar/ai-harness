import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { InstalledComponentRegistration } from "./registration.js";

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

/** The first path segment AIH keeps for its own state; a component never owns anything under it. */
const RESERVED_ROOT_SEGMENT = ".aih";

const MAX_PATH_LENGTH = 1_024;
const MAX_COMPONENTS = 4_096;
const MAX_FILES_PER_COMPONENT = 2_048;
const MAX_OWNED_KEYS = 64;
const MAX_MATERIALIZATION_RECEIPT_BYTES = 16 * 1024 * 1024;

const COMPONENT_ID = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/;
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type EccMaterializationOperation = "copy-file" | "merge-json";

/** A whole file AIH wrote and therefore owns end to end. */
export interface EccOwnedCopyFile {
  path: string;
  operation: "copy-file";
  /** SHA-256 of the exact bytes written. */
  contentSha256: string;
}

/**
 * Named top-level keys AIH merged into a JSON document it does not own whole.
 * `createdByAih` is recorded at write time because removing the file on
 * uninstall is allowed ONLY when AIH created it and the owned keys are still
 * its sole content — the H6 partition, unchanged.
 */
export interface EccOwnedMergeJson {
  path: string;
  operation: "merge-json";
  /** SHA-256 of the canonical bytes of the owned fragment — the keys AIH wrote, not the whole file. */
  contentSha256: string;
  ownedKeys: string[];
  createdByAih: boolean;
}

export type EccOwnedFile = EccOwnedCopyFile | EccOwnedMergeJson;

export interface EccComponentProvenance {
  repository: string;
  commit: string;
  componentPath: string;
}

export interface EccMaterializedComponent {
  id: string;
  /** The evidence authorization tuple exactly as the machine ledger pins it. */
  authorization: InstalledComponentRegistration["authorization"];
  provenance: EccComponentProvenance;
  files: EccOwnedFile[];
}

export interface EccMaterializationReceipt {
  format: typeof ECC_MATERIALIZATION_RECEIPT_FORMAT;
  schemaVersion: 1;
  components: EccMaterializedComponent[];
}

export type EccMaterializationReceiptRead =
  | { state: "absent" }
  | { state: "valid"; receipt: EccMaterializationReceipt; raw: string }
  | { state: "malformed"; detail: string };

function assertPortableRelativePath(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.replace(/\\/g, "/") : "";
  if (
    normalized.length === 0 ||
    normalized.length > MAX_PATH_LENGTH ||
    normalized.includes("\u0000") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe ${label}: ${value}`);
  }
  return normalized;
}

/**
 * Normalize and validate a destination-relative path a component may own.
 * Traversal, absolute inputs, and AIH's own state area are refused rather than
 * repaired — the receipt itself lives under that area, and a component that
 * could name it could rewrite its own ownership.
 */
export function assertOwnedRelativePath(value: string): string {
  const path = assertPortableRelativePath(value, "ECC materialization destination");
  if (path.split("/")[0] === RESERVED_ROOT_SEGMENT) {
    throw new Error(`ECC materialization destination claims AIH's own state area: ${value}`);
  }
  return path;
}

/** Validate a source-side component path (provenance), which never touches the destination. */
export function assertComponentSourcePath(value: string): string {
  return assertPortableRelativePath(value, "ECC component source path");
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

/**
 * The evidence authorization tuple, pinned exactly as `registration.ts` pins it
 * for the machine ledger. The ledger's copy is module-private, so the parity is
 * proved by test against the ledger's own exported merge rather than asserted
 * here.
 */
const AuthorizationSchema = z
  .object({
    componentId: ComponentIdSchema,
    source: z.string().min(1).max(240),
    pinnedSha: z.string().regex(SHA40),
    treeSha256: z.string().regex(SHA256),
    tier: z.enum(["vendor", "org"]),
    issuer: z.string().min(1).max(240),
    evidenceSha256: z.string().regex(SHA256),
    effective: z.enum(["pass", "accepted-with-conditions"]).optional(),
    acceptance: z
      .object({
        decisionId: z.string().min(1).max(240),
        recordSha256: z.string().regex(SHA256),
        acceptedFindingCodes: z.array(z.string().min(1).max(120)).max(64),
      })
      .strict()
      .optional(),
  })
  .strict();

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
    (value) => !value.includes("\u0000") && value !== "__proto__",
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
      ownedKeys: z.array(OwnedKeySchema).min(1).max(MAX_OWNED_KEYS),
      createdByAih: z.boolean(),
    })
    .strict(),
]);

const ComponentSchema = z
  .object({
    id: ComponentIdSchema,
    authorization: AuthorizationSchema,
    provenance: ProvenanceSchema,
    files: z.array(OwnedFileSchema).min(1).max(MAX_FILES_PER_COMPONENT),
  })
  .strict()
  .superRefine((component, context) => {
    duplicateIssues(
      component.files.map((file) => file.path),
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
    components: z.array(ComponentSchema).min(1).max(MAX_COMPONENTS),
  })
  .strict()
  .superRefine((receipt, context) => {
    duplicateIssues(
      receipt.components.map((component) => component.id),
      "component",
      context,
    );
  });

function duplicateIssues(
  values: readonly string[],
  label: string,
  context: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value))
      context.addIssue({ code: "custom", message: `duplicate ${label}: ${value}` });
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
    return normalizeReceipt(ReceiptSchema.parse(JSON.parse(text)) as EccMaterializationReceipt);
  } catch (error) {
    throw new Error(`invalid ECC materialization receipt: ${(error as Error).message}`);
  }
}

export function serializeEccMaterializationReceipt(receipt: EccMaterializationReceipt): string {
  const validated = ReceiptSchema.parse(receipt) as EccMaterializationReceipt;
  return `${JSON.stringify(normalizeReceipt(validated), null, 2)}\n`;
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

/** Deterministic JSON text — key-sorted at every depth. Used for digests only. */
function canonicalJsonText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonText).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => byText(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJsonText(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
