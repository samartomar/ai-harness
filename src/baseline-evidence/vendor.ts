import { createHash } from "node:crypto";
import { loadFrameworkDescriptorSectionV1 } from "../catalog-package/framework-descriptors.js";
import { type BaselineEvidenceLock, parseBaselineEvidenceLock } from "./schema.js";

interface VendorLockDocumentV1 {
  readonly bytesBase64: string;
  readonly sha256: string;
}

export const ACCEPTED_CATALOG_VENDOR_LOCK_SHA256_V1 =
  "35d3ccf597053016c5409ca467cb2b458636b824823a8cb7e00c61adb89a2d5f";

export function admitCatalogVendorLockDocumentV1(carried: VendorLockDocumentV1): Buffer {
  if (
    typeof carried.bytesBase64 !== "string" ||
    typeof carried.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(carried.sha256)
  ) {
    throw new TypeError("Catalog ECC vendor-lock document is malformed");
  }
  const decoded = Buffer.from(carried.bytesBase64, "base64");
  const observed = createHash("sha256").update(decoded).digest("hex");
  if (observed !== carried.sha256) {
    throw new TypeError("Catalog ECC vendor-lock document digest mismatch");
  }
  if (observed !== ACCEPTED_CATALOG_VENDOR_LOCK_SHA256_V1) {
    throw new TypeError(`Catalog ECC vendor-lock authority sha256 ${observed} is not accepted`);
  }
  return decoded;
}

let authoritativeBytes: Buffer | undefined;
let parsed: BaselineEvidenceLock | undefined;

function bytes(): Buffer {
  if (authoritativeBytes !== undefined) return authoritativeBytes;
  const carried = loadFrameworkDescriptorSectionV1<VendorLockDocumentV1>(
    "ecc",
    "vendorLockDocument",
  );
  const decoded = admitCatalogVendorLockDocumentV1(carried);
  authoritativeBytes = decoded;
  return decoded;
}

/** A defensive copy of the exact shipped vendor-lock authority bytes. */
export function vendorBaselineLockBytes(): Buffer {
  return Buffer.from(bytes());
}

export function readVendorBaselineLock(): BaselineEvidenceLock {
  parsed ??= parseBaselineEvidenceLock(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes())),
  );
  return structuredClone(parsed);
}

export function vendorBaselineLockSha256(): string {
  return createHash("sha256").update(bytes()).digest("hex");
}
