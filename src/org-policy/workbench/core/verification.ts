import { createHash } from "node:crypto";

import {
  type WorkbenchAuthoringSourceV1,
  WorkbenchAuthoringSourceV1Schema,
  type WorkbenchDraftV1,
  WorkbenchDraftV1Schema,
} from "../contracts.js";

/**
 * Node/Core-only custody check for draft declaration bytes. Browser reducers may
 * preserve drafts but cannot claim that their digest was verified.
 */
export function verifyWorkbenchDraftBytesV1(value: unknown): WorkbenchDraftV1 {
  const draft = WorkbenchDraftV1Schema.parse(value);
  const bytes = Buffer.from(draft.declaration.bytesBase64, "base64");
  if (bytes.toString("base64") !== draft.declaration.bytesBase64) {
    throw new Error("Draft declaration bytes must use canonical base64.");
  }
  if (bytes.length !== draft.declaration.byteLength) {
    throw new Error("Draft byte length does not match its serialized declaration.");
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== draft.declaration.digest) {
    throw new Error("Draft declaration digest does not match its serialized bytes.");
  }
  return draft;
}

/** Core rechecks transported declaration bytes; evidence and authority are never carried here. */
export function verifyWorkbenchAuthoringSourceBytesV1(value: unknown): {
  source: WorkbenchAuthoringSourceV1;
  text: string;
} {
  const source = WorkbenchAuthoringSourceV1Schema.parse(value);
  try {
    verifyWorkbenchDraftBytesV1({
      id: source.sourceId,
      declaration: {
        kind: "organization-manifest",
        digest: source.digest,
        byteLength: source.byteLength,
        bytesBase64: source.bytesBase64,
      },
    });
    return {
      source,
      text: new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(source.bytesBase64, "base64"),
      ),
    };
  } catch (error) {
    throw new TypeError(
      "Invalid authoring source bytes for " +
        source.sourceId +
        ": " +
        (error instanceof Error ? error.message : "verification failed"),
    );
  }
}
