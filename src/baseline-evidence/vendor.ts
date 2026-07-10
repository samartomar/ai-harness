import { createHash } from "node:crypto";
import { type BaselineEvidenceLock, parseBaselineEvidenceLock } from "./schema.js";
import vendorLockJson from "./vendor-lock.json";

let parsed: BaselineEvidenceLock | undefined;

export function readVendorBaselineLock(): BaselineEvidenceLock {
  parsed ??= parseBaselineEvidenceLock(vendorLockJson);
  return structuredClone(parsed);
}

export function vendorBaselineLockSha256(): string {
  const canonical = `${JSON.stringify(readVendorBaselineLock(), null, 2)}\n`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
