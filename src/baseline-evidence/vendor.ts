import { createHash } from "node:crypto";
import { loadFrameworkDescriptorSectionV1 } from "../catalog-package/framework-descriptors.js";
import { candidateCatalogActiveV1 } from "../catalog-package/load-catalog-package.js";
import { type BaselineEvidenceLock, parseBaselineEvidenceLock } from "./schema.js";

interface VendorLockDocumentV1 {
  readonly bytesBase64: string;
  readonly sha256: string;
}

export const ACCEPTED_CATALOG_VENDOR_LOCK_SHA256_V1 =
  "1ac23531115992deea9e1f78e7e42ef130d6f33ed6f9ec1d46765c6aac47f79e";

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
  // An activated candidate's named digest stands in for Core's (internal preparation only).
  if (!candidateCatalogActiveV1() && observed !== ACCEPTED_CATALOG_VENDOR_LOCK_SHA256_V1) {
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
