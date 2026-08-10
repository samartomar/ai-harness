import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { z } from "zod";
import { inspectContainedRelativePath } from "../../internals/contained-path.js";
import { readRegularFileWithStats } from "../../internals/fsxn.js";
import { codeUnitCompare } from "../package-graph/canonical.js";
import {
  PackageGraphSourceDigestSchema,
  PackageIdSchema,
  SurfaceIdSchema,
} from "../package-graph/schema.js";
import { CAPABILITY_PACKAGE_MANIFEST_LIMITS } from "./schema.js";

export const CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH =
  ".aih/capability-packages/ownership-v1.json";
export const CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_FORMAT =
  "aih-capability-package-ownership-receipt";
export const MAX_CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_BYTES = 8 * 1024 * 1024;
export const MAX_CAPABILITY_PACKAGE_MEMBER_AUTHORITY_REFS = 256;

const SHA256 = /^[0-9a-f]{64}$/;
const MEMBER_SEGMENT = "[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?";
const SUPPORTED_MEMBER = new RegExp(
  `^(?:skill|agent|rule|mcp):${MEMBER_SEGMENT}(?:/${MEMBER_SEGMENT})*$`,
);
const AUTHORITY_ID = new RegExp(
  `^(?:catalog|lock|receipt):${MEMBER_SEGMENT}(?:/${MEMBER_SEGMENT})*$`,
);
const MAX_RECEIPT_JSON_DEPTH = 32;
const MAX_RECEIPT_JSON_NODES = 250_000;

const DigestSchema = z
  .string({ error: "capability package ownership digest is malformed" })
  .regex(SHA256, { error: "capability package ownership digest is malformed" });

const MemberIdSchema = z
  .string({ error: "capability package ownership member id is malformed" })
  .min(3, { error: "capability package ownership member id is malformed" })
  .max(160, { error: "capability package ownership member id is malformed" })
  .regex(SUPPORTED_MEMBER, {
    error: "capability package ownership member id is malformed",
  })
  .pipe(SurfaceIdSchema);

const AuthorityIdSchema = z
  .string({ error: "capability package ownership authority id is malformed" })
  .min(3, { error: "capability package ownership authority id is malformed" })
  .max(160, { error: "capability package ownership authority id is malformed" })
  .regex(AUTHORITY_ID, {
    error: "capability package ownership authority id is malformed",
  })
  .pipe(SurfaceIdSchema);

export const CapabilityPackageOwnershipAuthorityRefSchema = z.strictObject(
  {
    authorityId: AuthorityIdSchema,
    claimDigest: DigestSchema,
    sourceDigest: PackageGraphSourceDigestSchema,
  },
  { error: "unknown capability package ownership authority reference fields are not supported" },
);

const CapabilityPackageOwnershipMemberSchema = z
  .strictObject(
    {
      id: MemberIdSchema,
      claimDigest: DigestSchema,
      sourceDigest: PackageGraphSourceDigestSchema,
      authorityRefs: z
        .array(CapabilityPackageOwnershipAuthorityRefSchema)
        .min(1)
        .max(MAX_CAPABILITY_PACKAGE_MEMBER_AUTHORITY_REFS),
    },
    { error: "unknown capability package ownership member fields are not supported" },
  )
  .superRefine((member, context) => {
    addDuplicateIssues(
      member.authorityRefs.map((reference) => reference.authorityId),
      ["authorityRefs"],
      context,
    );
  });

const CapabilityPackageOwnershipPackageSchema = z
  .strictObject(
    {
      id: PackageIdSchema,
      authorityId: AuthorityIdSchema,
      claimDigest: DigestSchema,
      sourceDigest: PackageGraphSourceDigestSchema,
      dependencies: z.array(PackageIdSchema).max(CAPABILITY_PACKAGE_MANIFEST_LIMITS.dependencies),
      members: z
        .array(CapabilityPackageOwnershipMemberSchema)
        .min(1)
        .max(CAPABILITY_PACKAGE_MANIFEST_LIMITS.members),
    },
    { error: "unknown capability package ownership package fields are not supported" },
  )
  .superRefine((pkg, context) => {
    addDuplicateIssues(pkg.dependencies, ["dependencies"], context);
    addDuplicateIssues(
      pkg.members.map((member) => member.id),
      ["members"],
      context,
    );
  });

export const CapabilityPackageOwnershipReceiptSchema = z
  .strictObject(
    {
      format: z.literal(CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_FORMAT),
      schemaVersion: z.literal(1),
      manifest: z.strictObject(
        { sha256: DigestSchema },
        { error: "unknown capability package ownership manifest fields are not supported" },
      ),
      roots: z.array(PackageIdSchema).max(CAPABILITY_PACKAGE_MANIFEST_LIMITS.roots),
      packages: z
        .array(CapabilityPackageOwnershipPackageSchema)
        .min(1)
        .max(CAPABILITY_PACKAGE_MANIFEST_LIMITS.packages),
    },
    { error: "unknown capability package ownership receipt fields are not supported" },
  )
  .superRefine((receipt, context) => {
    addDuplicateIssues(receipt.roots, ["roots"], context);
    addDuplicateIssues(
      receipt.packages.map((pkg) => pkg.id),
      ["packages"],
      context,
    );
    const packageIds = new Set(receipt.packages.map((pkg) => pkg.id));
    for (const [index, root] of receipt.roots.entries()) {
      if (!packageIds.has(root)) {
        context.addIssue({
          code: "custom",
          path: ["roots", index],
          message: "unknown root package",
        });
      }
    }
    let references = 0;
    for (const [packageIndex, pkg] of receipt.packages.entries()) {
      references += pkg.dependencies.length + pkg.members.length;
      for (const [dependencyIndex, dependency] of pkg.dependencies.entries()) {
        if (!packageIds.has(dependency)) {
          context.addIssue({
            code: "custom",
            path: ["packages", packageIndex, "dependencies", dependencyIndex],
            message: "unknown dependency package",
          });
        }
      }
    }
    if (references > CAPABILITY_PACKAGE_MANIFEST_LIMITS.totalReferences) {
      context.addIssue({
        code: "custom",
        path: ["packages"],
        message: "capability package ownership reference limit exceeded",
      });
    }
  });

export type CapabilityPackageOwnershipMember = z.infer<
  typeof CapabilityPackageOwnershipMemberSchema
>;
export type CapabilityPackageOwnershipAuthorityRef = z.infer<
  typeof CapabilityPackageOwnershipAuthorityRefSchema
>;
export type CapabilityPackageOwnershipPackage = z.infer<
  typeof CapabilityPackageOwnershipPackageSchema
>;
export type CapabilityPackageOwnershipReceipt = z.infer<
  typeof CapabilityPackageOwnershipReceiptSchema
>;

export type CapabilityPackageOwnershipReceiptRead =
  | { state: "absent" }
  | {
      state: "valid";
      receipt: CapabilityPackageOwnershipReceipt;
      sourceBytes: Buffer;
      sourceSha256: string;
    }
  | { state: "malformed"; detail: string };

function addDuplicateIssues(
  values: readonly string[],
  path: PropertyKey[],
  context: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({ code: "custom", path: [...path, index], message: "duplicate identity" });
    }
    seen.add(value);
  }
}

function normalize(receipt: CapabilityPackageOwnershipReceipt): CapabilityPackageOwnershipReceipt {
  return {
    format: CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_FORMAT,
    schemaVersion: 1,
    manifest: { ...receipt.manifest },
    roots: [...receipt.roots].sort(codeUnitCompare),
    packages: [...receipt.packages]
      .map((pkg) => ({
        ...pkg,
        sourceDigest: { ...pkg.sourceDigest },
        dependencies: [...pkg.dependencies].sort(codeUnitCompare),
        members: [...pkg.members]
          .map((member) => ({
            ...member,
            sourceDigest: { ...member.sourceDigest },
            authorityRefs: [...member.authorityRefs]
              .map((reference) => ({
                ...reference,
                sourceDigest: { ...reference.sourceDigest },
              }))
              .sort(compareAuthorityRefs),
          }))
          .sort((left, right) => codeUnitCompare(left.id, right.id)),
      }))
      .sort((left, right) => codeUnitCompare(left.id, right.id)),
  };
}

function compareAuthorityRefs(
  left: CapabilityPackageOwnershipAuthorityRef,
  right: CapabilityPackageOwnershipAuthorityRef,
): number {
  return (
    codeUnitCompare(left.authorityId, right.authorityId) ||
    codeUnitCompare(left.claimDigest, right.claimDigest) ||
    codeUnitCompare(left.sourceDigest.algorithm, right.sourceDigest.algorithm) ||
    codeUnitCompare(left.sourceDigest.value, right.sourceDigest.value)
  );
}

interface JsonGuardState {
  active: Set<object>;
  nodes: number;
}

function guardedJsonClone(value: unknown, state: JsonGuardState, depth = 0): unknown {
  state.nodes += 1;
  if (depth > MAX_RECEIPT_JSON_DEPTH || state.nodes > MAX_RECEIPT_JSON_NODES) {
    throw new Error("capability package ownership receipt is too complex");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error("capability package ownership receipt contains an invalid number");
    }
    return value;
  }
  if (typeof value !== "object" || isProxy(value)) {
    throw new Error("capability package ownership receipt contains an invalid value");
  }
  if (state.active.has(value)) {
    throw new Error("capability package ownership receipt contains a cycle");
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error("capability package ownership receipt contains a custom array");
      }
      if (Object.getOwnPropertySymbols(value).length !== 0) {
        throw new Error("capability package ownership receipt contains symbol properties");
      }
      const names = Object.getOwnPropertyNames(value);
      if (
        names.length !== value.length + 1 ||
        !names.includes("length") ||
        names.some((name) => name !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(name))
      ) {
        throw new Error("capability package ownership receipt contains an invalid array");
      }
      const clone: unknown[] = [];
      Object.defineProperty(clone, "toJSON", { value: undefined });
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("capability package ownership receipt contains an invalid array entry");
        }
        clone.push(guardedJsonClone(descriptor.value, state, depth + 1));
      }
      return clone;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("capability package ownership receipt contains a custom object");
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new Error("capability package ownership receipt contains symbol properties");
    }
    const clone = Object.create(null) as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(value).sort(codeUnitCompare)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("capability package ownership receipt contains an invalid property");
      }
      clone[name] = guardedJsonClone(descriptor.value, state, depth + 1);
    }
    return clone;
  } finally {
    state.active.delete(value);
  }
}

export function parseCapabilityPackageOwnershipReceipt(
  text: string,
): CapabilityPackageOwnershipReceipt {
  try {
    if (Buffer.byteLength(text, "utf8") > MAX_CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_BYTES) {
      throw new Error("oversized capability package ownership receipt");
    }
    return normalize(CapabilityPackageOwnershipReceiptSchema.parse(JSON.parse(text)));
  } catch {
    throw new Error("invalid capability package ownership receipt");
  }
}

export function serializeCapabilityPackageOwnershipReceipt(
  input: CapabilityPackageOwnershipReceipt,
): string {
  let text: string;
  try {
    const guarded = guardedJsonClone(input, { active: new Set(), nodes: 0 });
    const receipt = normalize(CapabilityPackageOwnershipReceiptSchema.parse(guarded));
    const jsonSafe = guardedJsonClone(receipt, { active: new Set(), nodes: 0 });
    text = `${JSON.stringify(jsonSafe, null, 2)}\n`;
  } catch {
    throw new Error("invalid capability package ownership receipt");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_BYTES) {
    throw new Error("invalid capability package ownership receipt");
  }
  return text;
}

export function readCapabilityPackageOwnershipReceipt(
  root: string,
): CapabilityPackageOwnershipReceiptRead {
  const inspected = inspectContainedRelativePath(root, CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_PATH);
  if (inspected.state === "absent") return { state: "absent" };
  if (inspected.state !== "present" || inspected.kind !== "file") {
    return { state: "malformed", detail: "invalid capability package ownership receipt file" };
  }
  const opened = readRegularFileWithStats(inspected.realPath, {
    maxBytes: MAX_CAPABILITY_PACKAGE_OWNERSHIP_RECEIPT_BYTES,
  });
  if (opened === undefined || opened.stats.nlink > 1) {
    return { state: "malformed", detail: "invalid capability package ownership receipt file" };
  }
  const sourceBytes = Buffer.from(opened.contents);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
    return {
      state: "valid",
      receipt: parseCapabilityPackageOwnershipReceipt(text),
      sourceBytes,
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    };
  } catch {
    return { state: "malformed", detail: "invalid capability package ownership receipt" };
  }
}
