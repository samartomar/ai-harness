import { createHash } from "node:crypto";
import { canonicalStrictJsonBytesV1 } from "../../../contract/strict-json-v1.js";
import type {
  EccRuntimeDescriptorV1,
  PreparedEccRuntimeDescriptorV1,
} from "../../../ecc/runtime-descriptor.js";

const facts = new WeakMap<PreparedEccRuntimeDescriptorV1, EccRuntimeDescriptorV1>();

/** Only successful Scanner consumption can mint this opaque witness. */
export function mintPreparedEccRuntimeDescriptorV1(
  descriptor: EccRuntimeDescriptorV1,
): PreparedEccRuntimeDescriptorV1 {
  const prepared: PreparedEccRuntimeDescriptorV1 = Object.freeze({});
  facts.set(prepared, descriptor);
  return prepared;
}

/** Callers can serialize a descriptor only while carrying its live Scanner witness. */
export function sealPreparedEccRuntimeDescriptorV1(prepared: PreparedEccRuntimeDescriptorV1) {
  const descriptor = facts.get(prepared);
  if (descriptor === undefined)
    throw new TypeError(
      "Workbench source data: independent Scanner proof or source binding rejected",
    );
  const bytes = canonicalStrictJsonBytesV1(descriptor);
  return Object.freeze({
    bytesBase64: bytes.toString("base64"),
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
}
