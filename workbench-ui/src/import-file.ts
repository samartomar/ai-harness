import { MAX_IMPORT_BYTES } from "../../src/org-policy/workbench/engine/index.js";

/**
 * Read a chosen file once, refusing anything over the engine's limit BEFORE
 * the bytes are read (acceptance failure case 2). The original bytes are
 * returned so a host can digest exactly what it was given; re-serialized JSON
 * is never hashed.
 */
export const OVERSIZE_MESSAGE = "Import rejected: file exceeds the 1 MiB limit.";

export type ImportedBytes =
  | { readonly ok: true; readonly bytes: ArrayBuffer; readonly text: string }
  | { readonly ok: false; readonly message: string };

export async function readImportedFile(file: File): Promise<ImportedBytes> {
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, message: OVERSIZE_MESSAGE };
  try {
    const bytes = await file.arrayBuffer();
    return { ok: true, bytes, text: new TextDecoder().decode(bytes) };
  } catch {
    return { ok: false, message: "Import rejected: unable to read file." };
  }
}
