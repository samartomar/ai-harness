import { createHash } from "node:crypto";
import { inspectContainedRelativePath } from "../../internals/contained-path.js";
import { readRegularFileWithStats } from "../../internals/fsxn.js";
import { type CapabilityPackageManifest, CapabilityPackageManifestSchema } from "./schema.js";

export const CAPABILITY_PACKAGE_INTENT_PATH = "aih-capability-packages.json";
export const MAX_CAPABILITY_PACKAGE_INTENT_BYTES = 8 * 1024 * 1024;

export interface ParsedCapabilityPackageIntent {
  manifest: CapabilityPackageManifest;
  sourceBytes: Buffer;
  sourceSha256: string;
}

export type CapabilityPackageIntentRead =
  | { state: "absent" }
  | ({ state: "valid" } & ParsedCapabilityPackageIntent)
  | { state: "malformed"; detail: string };

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseCapabilityPackageIntentBytes(input: Buffer): ParsedCapabilityPackageIntent {
  const sourceBytes = Buffer.from(input);
  try {
    if (sourceBytes.byteLength > MAX_CAPABILITY_PACKAGE_INTENT_BYTES) {
      throw new Error("oversized capability package intent");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
    const manifest = CapabilityPackageManifestSchema.parse(JSON.parse(text));
    return { manifest, sourceBytes, sourceSha256: sha256(sourceBytes) };
  } catch {
    throw new Error("invalid capability package intent");
  }
}

export function readCapabilityPackageIntent(root: string): CapabilityPackageIntentRead {
  const inspected = inspectContainedRelativePath(root, CAPABILITY_PACKAGE_INTENT_PATH);
  if (inspected.state === "absent") return { state: "absent" };
  if (inspected.state !== "present" || inspected.kind !== "file") {
    return { state: "malformed", detail: "invalid capability package intent file" };
  }
  const opened = readRegularFileWithStats(inspected.realPath, {
    maxBytes: MAX_CAPABILITY_PACKAGE_INTENT_BYTES,
  });
  if (opened === undefined || opened.stats.nlink > 1) {
    return { state: "malformed", detail: "invalid capability package intent file" };
  }
  try {
    return { state: "valid", ...parseCapabilityPackageIntentBytes(opened.contents) };
  } catch {
    return { state: "malformed", detail: "invalid capability package intent" };
  }
}
