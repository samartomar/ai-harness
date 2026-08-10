import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { z } from "zod";
import { inspectContainedRelativePath } from "../../internals/contained-path.js";
import { readRegularFileWithStats } from "../../internals/fsxn.js";
import { codeUnitCompare } from "../package-graph/canonical.js";
import { PackageIdSchema, SurfaceIdSchema } from "../package-graph/schema.js";

export const CAPABILITY_PACKAGE_CUSTODY_RECEIPT_FORMAT = "aih-capability-package-custody-receipt";
export const CAPABILITY_PACKAGE_CUSTODY_RECEIPT_DIRECTORY = ".aih/capability-packages/custody-v1";
export const MAX_CAPABILITY_PACKAGE_CUSTODY_RECEIPT_BYTES = 8 * 1024 * 1024;
export const MAX_CAPABILITY_PACKAGE_CUSTODY_MEMBERS = 4_096;
export const MAX_CAPABILITY_PACKAGE_CUSTODY_FILES = 4_096;

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_RELATIVE = /^(?!\/)(?!.*\\)(?!.*:)(?!.*[\p{Cc}\p{Cf}\u2028\u2029])/u;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 250_000;

const DigestSchema = z.string().regex(SHA256);
const SupportedMemberIdSchema = SurfaceIdSchema.refine((id) =>
  /^(?:skill|agent|rule|mcp):/.test(id),
);
const SupportedPackageIdSchema = PackageIdSchema.refine((id) =>
  /^package:(?:skill-pack|ecc-agent|ecc-rule|ecc-mcp)\//.test(id),
);
const RelativePathSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      SAFE_RELATIVE.test(value) &&
      value
        .split("/")
        .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
  );

const CustodyMemberSchema = z.strictObject({
  id: SupportedMemberIdSchema,
  packageIds: z.array(SupportedPackageIdSchema).min(1).max(MAX_CAPABILITY_PACKAGE_CUSTODY_MEMBERS),
});

const CustodyFileSchema = z.strictObject({
  memberId: SupportedMemberIdSchema,
  path: RelativePathSchema,
  sha256: DigestSchema,
  mode: z.number().int().min(0).max(0o777).optional(),
});

export const CapabilityPackageCustodyReceiptSchema = z
  .strictObject({
    format: z.literal(CAPABILITY_PACKAGE_CUSTODY_RECEIPT_FORMAT),
    schemaVersion: z.literal(1),
    ownershipReceipt: z.strictObject({ sha256: DigestSchema }),
    domainReceipt: z.strictObject({
      kind: z.enum(["skill-promotion-trust-lock", "ecc-materialization", "ecc-mcp-explicit-add"]),
      sha256: DigestSchema,
    }),
    members: z.array(CustodyMemberSchema).min(1).max(MAX_CAPABILITY_PACKAGE_CUSTODY_MEMBERS),
    files: z.array(CustodyFileSchema).min(1).max(MAX_CAPABILITY_PACKAGE_CUSTODY_FILES),
  })
  .superRefine((receipt, context) => {
    const memberIds = new Set<string>();
    for (const [memberIndex, member] of receipt.members.entries()) {
      if (memberIds.has(member.id)) {
        context.addIssue({
          code: "custom",
          message: "duplicate capability package custody member",
          path: ["members", memberIndex, "id"],
        });
      }
      memberIds.add(member.id);
      if (new Set(member.packageIds).size !== member.packageIds.length) {
        context.addIssue({
          code: "custom",
          message: "duplicate capability package custody package",
          path: ["members", memberIndex, "packageIds"],
        });
      }
      const packagePrefix = member.id.startsWith("skill:")
        ? "package:skill-pack/"
        : member.id.startsWith("agent:")
          ? "package:ecc-agent/"
          : member.id.startsWith("rule:")
            ? "package:ecc-rule/"
            : "package:ecc-mcp/";
      if (member.packageIds.some((id) => !id.startsWith(packagePrefix))) {
        context.addIssue({
          code: "custom",
          message: "capability package custody member family does not match package family",
          path: ["members", memberIndex, "packageIds"],
        });
      }
    }
    const foldedPaths = new Map<string, (typeof receipt.files)[number]>();
    const membersWithFiles = new Set<string>();
    for (const [fileIndex, file] of receipt.files.entries()) {
      if (!memberIds.has(file.memberId)) {
        context.addIssue({
          code: "custom",
          message: "capability package custody file member is missing",
          path: ["files", fileIndex, "memberId"],
        });
      }
      membersWithFiles.add(file.memberId);
      const folded = file.path.toLowerCase();
      const prior = foldedPaths.get(folded);
      if (
        prior !== undefined &&
        (prior.path !== file.path ||
          prior.sha256 !== file.sha256 ||
          prior.mode !== file.mode ||
          prior.memberId === file.memberId)
      ) {
        context.addIssue({
          code: "custom",
          message: "ambiguous capability package custody file path",
          path: ["files", fileIndex, "path"],
        });
      }
      foldedPaths.set(folded, file);
    }
    for (const [memberIndex, member] of receipt.members.entries()) {
      if (!membersWithFiles.has(member.id)) {
        context.addIssue({
          code: "custom",
          message: "capability package custody member has no files",
          path: ["members", memberIndex],
        });
      }
    }
  });

export type CapabilityPackageCustodyReceipt = z.infer<typeof CapabilityPackageCustodyReceiptSchema>;

export type CapabilityPackageCustodyReceiptRead =
  | { state: "absent" }
  | {
      state: "valid";
      receipt: CapabilityPackageCustodyReceipt;
      sourceBytes: Buffer;
      sourceSha256: string;
    }
  | { state: "malformed"; detail: string };

function invalidIdentity(): never {
  throw new Error("invalid capability package custody receipt identity");
}

export function capabilityPackageCustodyReceiptPath(
  ownershipReceiptSha256: string,
  trustLockSha256: string,
): string {
  if (!SHA256.test(ownershipReceiptSha256) || !SHA256.test(trustLockSha256)) invalidIdentity();
  return `${CAPABILITY_PACKAGE_CUSTODY_RECEIPT_DIRECTORY}/${ownershipReceiptSha256}-${trustLockSha256}.json`;
}

function guardedClone(input: unknown): unknown {
  const active = new Set<object>();
  let nodes = 0;
  const clone = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new Error("invalid custody receipt value");
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      value === undefined
    ) {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new Error("invalid custody receipt number");
      }
      return value;
    }
    if (typeof value !== "object" || isProxy(value) || active.has(value)) {
      throw new Error("invalid custody receipt value");
    }
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (
          Object.getPrototypeOf(value) !== Array.prototype ||
          Object.getOwnPropertySymbols(value).length !== 0 ||
          Object.getOwnPropertyNames(value).length !== value.length + 1
        ) {
          throw new Error("invalid custody receipt array");
        }
        const output: unknown[] = [];
        Object.defineProperty(output, "toJSON", { value: undefined });
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            throw new Error("invalid custody receipt array entry");
          }
          output.push(clone(descriptor.value, depth + 1));
        }
        return output;
      }
      const prototype = Object.getPrototypeOf(value);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        Object.getOwnPropertySymbols(value).length !== 0
      ) {
        throw new Error("invalid custody receipt object");
      }
      const output = Object.create(null) as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(value).sort(codeUnitCompare)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("invalid custody receipt property");
        }
        output[name] = clone(descriptor.value, depth + 1);
      }
      return output;
    } finally {
      active.delete(value);
    }
  };
  return clone(input, 0);
}

function normalize(receipt: CapabilityPackageCustodyReceipt): CapabilityPackageCustodyReceipt {
  return {
    format: receipt.format,
    schemaVersion: 1,
    ownershipReceipt: { ...receipt.ownershipReceipt },
    domainReceipt: { ...receipt.domainReceipt },
    members: [...receipt.members]
      .map((member) => ({
        id: member.id,
        packageIds: [...member.packageIds].sort(codeUnitCompare),
      }))
      .sort((left, right) => codeUnitCompare(left.id, right.id)),
    files: [...receipt.files]
      .map((file) => ({ ...file }))
      .sort(
        (left, right) =>
          codeUnitCompare(left.path, right.path) || codeUnitCompare(left.memberId, right.memberId),
      ),
  };
}

export function parseCapabilityPackageCustodyReceipt(
  text: string,
): CapabilityPackageCustodyReceipt {
  try {
    if (Buffer.byteLength(text, "utf8") > MAX_CAPABILITY_PACKAGE_CUSTODY_RECEIPT_BYTES) {
      throw new Error("oversized custody receipt");
    }
    return normalize(CapabilityPackageCustodyReceiptSchema.parse(JSON.parse(text)));
  } catch {
    throw new Error("invalid capability package custody receipt");
  }
}

export function serializeCapabilityPackageCustodyReceipt(input: unknown): string {
  try {
    const receipt = normalize(CapabilityPackageCustodyReceiptSchema.parse(guardedClone(input)));
    const text = `${JSON.stringify(guardedClone(receipt), null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_CAPABILITY_PACKAGE_CUSTODY_RECEIPT_BYTES) {
      throw new Error("oversized custody receipt");
    }
    return text;
  } catch {
    throw new Error("invalid capability package custody receipt");
  }
}

export function readCapabilityPackageCustodyReceipt(
  root: string,
  ownershipReceiptSha256: string,
  trustLockSha256: string,
): CapabilityPackageCustodyReceiptRead {
  let path: string;
  try {
    path = capabilityPackageCustodyReceiptPath(ownershipReceiptSha256, trustLockSha256);
  } catch {
    return { state: "malformed", detail: "invalid capability package custody receipt file" };
  }
  const inspected = inspectContainedRelativePath(root, path);
  if (inspected.state === "absent") return { state: "absent" };
  if (inspected.state !== "present" || inspected.kind !== "file") {
    return { state: "malformed", detail: "invalid capability package custody receipt file" };
  }
  const opened = readRegularFileWithStats(inspected.realPath, {
    maxBytes: MAX_CAPABILITY_PACKAGE_CUSTODY_RECEIPT_BYTES,
  });
  if (opened === undefined || opened.stats.nlink > 1) {
    return { state: "malformed", detail: "invalid capability package custody receipt file" };
  }
  const sourceBytes = Buffer.from(opened.contents);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
    const receipt = parseCapabilityPackageCustodyReceipt(text);
    if (
      receipt.ownershipReceipt.sha256 !== ownershipReceiptSha256 ||
      receipt.domainReceipt.sha256 !== trustLockSha256
    ) {
      throw new Error("custody receipt identity mismatch");
    }
    return {
      state: "valid",
      receipt,
      sourceBytes,
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    };
  } catch {
    return { state: "malformed", detail: "invalid capability package custody receipt" };
  }
}
