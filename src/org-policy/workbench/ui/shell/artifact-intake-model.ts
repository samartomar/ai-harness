/**
 * Headless artifact-intake validators extracted from `artifact-intake-runtime.js`
 * (S0). Verbatim ports: the runtime binds its local names to these exports, so
 * every error message and acceptance rule here is the runtime's behaviour.
 *
 * The DOM-free half now lives in
 * `../../engine/features/artifact-intake-validation.ts`, so the engine can use
 * it too (Policy Workbench UI delivery, acceptance rule section 7 row 22).
 * It is re-exported below unchanged; this file keeps the half that needs the
 * browser's base64 and Web Crypto globals, which the engine may not use.
 */
import {
  DIGEST,
  exact,
  fail,
  MAX_DRAFT_BASE64,
  MAX_DRAFT_BYTES,
} from "../../engine/features/artifact-intake-validation.js";

export {
  COMMIT,
  DIGEST,
  directorySource,
  EMAIL,
  exact,
  fail,
  https,
  ID,
  MAX_DRAFT_BASE64,
  MAX_DRAFT_BYTES,
  MAX_DRAFT_COUNT,
  npmRegistry,
  PACKAGE,
  SEMVER,
  safePath,
  source,
  sri,
  strictJson,
  unicode,
  utf8Bytes,
  validateIntake,
} from "../../engine/features/artifact-intake-validation.js";

/**
 * Intake JSON is walked as the runtime walked it: untyped, after an own-object
 * check. Narrowing would change which malformed inputs fail and how.
 */
// biome-ignore lint/suspicious/noExplicitAny: verbatim port of untyped intake JSON walking
type Loose = any;

export function base64ForBytes(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    const slice = bytes.subarray(offset, Math.min(offset + 32768, bytes.length));
    chunks.push(String.fromCharCode.apply(null, slice as unknown as number[]));
  }
  return btoa(chunks.join(""));
}

export function bytesForBase64(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    fail("evidence draft bytes must use canonical base64");
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  if (base64ForBytes(bytes) !== value) fail("evidence draft bytes must use canonical base64");
  return bytes;
}

export async function digestBytes(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return `sha256:${Array.from(new Uint8Array(result))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export interface OpaqueEvidenceDraft {
  readonly id: string;
  readonly declaration: {
    readonly kind: "imported-evidence";
    readonly bytesBase64: string;
    readonly byteLength: number;
    readonly digest: string;
  };
}

export async function opaqueEvidenceDraft(bytes: Loose): Promise<OpaqueEvidenceDraft> {
  if (
    !ArrayBuffer.isView(bytes) ||
    (bytes as Loose).BYTES_PER_ELEMENT !== 1 ||
    (bytes as Loose).length < 1 ||
    (bytes as Loose).length > MAX_DRAFT_BYTES
  )
    fail(`artifact evidence must contain 1 to ${String(MAX_DRAFT_BYTES)} exact bytes`);
  const digest = await digestBytes(bytes as Uint8Array);
  return {
    id: `draft:evidence-${digest.slice(7)}`,
    declaration: {
      kind: "imported-evidence",
      bytesBase64: base64ForBytes(bytes as Uint8Array),
      byteLength: (bytes as Uint8Array).length,
      digest,
    },
  };
}

export async function validateOpaqueEvidenceDraft(value: Loose): Promise<OpaqueEvidenceDraft> {
  exact(value, ["id", "declaration"], ["id", "declaration"], "evidence draft");
  if (typeof value.id !== "string" || !/^draft:evidence-[a-f0-9]{64}$/.test(value.id))
    fail("evidence draft identifier is invalid");
  const declaration = value.declaration;
  exact(
    declaration,
    ["kind", "bytesBase64", "byteLength", "digest"],
    ["kind", "bytesBase64", "byteLength", "digest"],
    "evidence draft declaration",
  );
  if (
    declaration.kind !== "imported-evidence" ||
    !Number.isInteger(declaration.byteLength) ||
    declaration.byteLength < 1 ||
    declaration.byteLength > MAX_DRAFT_BYTES ||
    declaration.bytesBase64.length > MAX_DRAFT_BASE64 ||
    !DIGEST.test(declaration.digest)
  )
    fail("evidence draft declaration is invalid");
  const bytes = bytesForBase64(declaration.bytesBase64);
  if (
    bytes.length !== declaration.byteLength ||
    (await digestBytes(bytes)) !== declaration.digest ||
    value.id !== `draft:evidence-${declaration.digest.slice(7)}`
  )
    fail("evidence draft exact bytes do not match identity");
  return {
    id: value.id,
    declaration: {
      kind: "imported-evidence",
      bytesBase64: declaration.bytesBase64,
      byteLength: declaration.byteLength,
      digest: declaration.digest,
    },
  };
}
