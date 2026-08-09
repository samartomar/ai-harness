import { createHash } from "node:crypto";
import { type BaselineEvidenceLock, parseBaselineEvidenceLock } from "./schema.js";
import vendorLockJson from "./vendor-lock.json";

const authoritativeBytes = Buffer.from(`${JSON.stringify(vendorLockJson, null, 2)}\n`, "utf8");
let parsed: BaselineEvidenceLock | undefined;

/** A defensive copy of the exact shipped vendor-lock authority bytes. */
export function vendorBaselineLockBytes(): Buffer {
  return Buffer.from(authoritativeBytes);
}

export function readVendorBaselineLock(): BaselineEvidenceLock {
  parsed ??= parseBaselineEvidenceLock(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(authoritativeBytes)),
  );
  return structuredClone(parsed);
}

export function vendorBaselineLockSha256(): string {
  return createHash("sha256").update(authoritativeBytes).digest("hex");
}
