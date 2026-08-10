import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { platform as hostPlatform } from "node:process";
import { isProxy } from "node:util/types";
import { inspectContainedRelativePath } from "../../../internals/contained-path.js";
import { readRegularFileWithStats } from "../../../internals/fsxn.js";
import { TRUST_LOCK_FILE } from "../../../trust/lock.js";
import type { DeepReadonly } from "../../package-graph/build.js";
import { codeUnitCompare } from "../../package-graph/canonical.js";
import {
  type CapabilityPackageCustodyReceipt,
  capabilityPackageCustodyReceiptPath,
  readCapabilityPackageCustodyReceipt,
} from "../custody-receipt.js";
import { parseCapabilityPackageIntentBytes } from "../intent.js";
import type { CapabilityPackageLifecycleInput } from "../lifecycle.js";
import { planCapabilityPackageOwnedFiles } from "../owned-files.js";
import { readCapabilityPackageOwnershipReceipt } from "../receipt.js";
import { resolveCapabilityPackages } from "../resolve.js";
import {
  INSTALLED_SKILL_PACK_LIMITS,
  resolveInstalledSkillPackSnapshot,
} from "./skill-pack-installed.js";

const MAX_INPUT_DEPTH = 64;
const MAX_INPUT_NODES = 300_000;
const MAX_INPUT_BUFFER_BYTES = 16 * 1024 * 1024;

export type SkillPackCustodyRefusalCode =
  | "invalid-input"
  | "lifecycle-refused"
  | "invalid-trust-lock"
  | "installed-snapshot-refused"
  | "ownership-state-pending"
  | "authority-state-changed"
  | "authority-mismatch"
  | "invalid-custody-receipt"
  | "custody-mismatch";

export interface SkillPackCustodyCandidate {
  readonly path: string;
  readonly ownershipReceiptSha256: string;
  readonly trustLockSha256: string;
  readonly custodyReceiptSha256?: string;
}

export type SkillPackCustodyPlan =
  | {
      readonly schemaVersion: 1;
      readonly status: "unowned";
      readonly code: "missing-custody-receipt" | "ownership-state-pending";
      readonly candidate: Readonly<SkillPackCustodyCandidate>;
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "verified-existing";
      readonly candidate: Readonly<SkillPackCustodyCandidate>;
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "not-applicable";
      readonly code: "no-desired-custody";
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "refused";
      readonly code: SkillPackCustodyRefusalCode;
      readonly candidate?: Readonly<SkillPackCustodyCandidate>;
    };

interface SnapshotInput {
  root: string;
  contextDir: string;
  lifecycleInput: CapabilityPackageLifecycleInput;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function freezeCandidate(
  candidate: SkillPackCustodyCandidate,
): Readonly<SkillPackCustodyCandidate> {
  return Object.freeze({ ...candidate });
}

function refused(
  code: SkillPackCustodyRefusalCode,
  candidate?: SkillPackCustodyCandidate,
): DeepReadonly<SkillPackCustodyPlan> {
  return Object.freeze({
    schemaVersion: 1 as const,
    status: "refused" as const,
    code,
    ...(candidate === undefined ? {} : { candidate: freezeCandidate(candidate) }),
  });
}

function guardedClone(input: unknown): unknown {
  const active = new Set<object>();
  let nodes = 0;
  let bufferBytes = 0;
  const clone = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_INPUT_NODES || depth > MAX_INPUT_DEPTH) throw new Error("invalid input");
    if (
      value === undefined ||
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("invalid input");
      return value;
    }
    if (typeof value !== "object" || isProxy(value) || active.has(value)) {
      throw new Error("invalid input");
    }
    if (Buffer.isBuffer(value)) {
      bufferBytes += value.byteLength;
      if (
        Object.getPrototypeOf(value) !== Buffer.prototype ||
        value.byteLength > MAX_INPUT_BUFFER_BYTES ||
        bufferBytes > MAX_INPUT_BUFFER_BYTES
      ) {
        throw new Error("invalid input");
      }
      return Buffer.from(value);
    }
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (
          Object.getPrototypeOf(value) !== Array.prototype ||
          Object.getOwnPropertySymbols(value).length !== 0 ||
          Object.getOwnPropertyNames(value).length !== value.length + 1
        ) {
          throw new Error("invalid input");
        }
        const output: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            throw new Error("invalid input");
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
        throw new Error("invalid input");
      }
      const output = Object.create(null) as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(value).sort(codeUnitCompare)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("invalid input");
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

function snapshotInput(input: unknown): SnapshotInput | undefined {
  try {
    const clone = guardedClone(input);
    if (clone === null || typeof clone !== "object" || Array.isArray(clone)) return undefined;
    const names = Object.keys(clone);
    if (
      names.length !== 3 ||
      !names.includes("root") ||
      !names.includes("contextDir") ||
      !names.includes("lifecycleInput")
    ) {
      return undefined;
    }
    const candidate = clone as Record<string, unknown>;
    if (
      typeof candidate.root !== "string" ||
      !isAbsolute(candidate.root) ||
      typeof candidate.contextDir !== "string" ||
      candidate.lifecycleInput === null ||
      typeof candidate.lifecycleInput !== "object" ||
      Array.isArray(candidate.lifecycleInput)
    ) {
      return undefined;
    }
    return candidate as unknown as SnapshotInput;
  } catch {
    return undefined;
  }
}

function readTrustLock(root: string): Buffer | undefined {
  try {
    const inspected = inspectContainedRelativePath(root, TRUST_LOCK_FILE);
    if (inspected.state !== "present" || inspected.kind !== "file") return undefined;
    const opened = readRegularFileWithStats(inspected.realPath, {
      maxBytes: INSTALLED_SKILL_PACK_LIMITS.maxTrustLockBytes,
    });
    if (opened === undefined || opened.stats.nlink > 1) return undefined;
    const bytes = Buffer.from(opened.contents);
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes;
  } catch {
    return undefined;
  }
}

function sameDigest(
  left: { algorithm: string; value: string },
  right: { algorithm: string; value: string },
): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function exactAuthorityJoin(
  receipt: NonNullable<
    Extract<
      ReturnType<typeof planCapabilityPackageOwnedFiles>["lifecycle"],
      { status: "ready" }
    >["desiredReceipt"]
  >["receipt"],
  bindings: ReturnType<typeof resolveInstalledSkillPackSnapshot>["bindings"],
): boolean {
  const packages = [...receipt.packages].sort((a, b) => codeUnitCompare(a.id, b.id));
  const expected = [...bindings].sort((a, b) => codeUnitCompare(a.id, b.id));
  if (packages.length !== expected.length) return false;
  return packages.every((pkg, index) => {
    const binding = expected[index];
    if (
      binding === undefined ||
      pkg.id !== binding.id ||
      pkg.authorityId !== binding.authorityId ||
      pkg.claimDigest !== binding.claimDigest ||
      !sameDigest(pkg.sourceDigest, binding.sourceDigest) ||
      pkg.dependencies.length !== binding.dependencies.length ||
      ![...pkg.dependencies]
        .sort(codeUnitCompare)
        .every(
          (dependency, dependencyIndex) =>
            dependency === [...binding.dependencies].sort(codeUnitCompare)[dependencyIndex],
        )
    ) {
      return false;
    }
    const members = [...pkg.members].sort((a, b) => codeUnitCompare(a.id, b.id));
    const boundMembers = [...binding.members].sort((a, b) => codeUnitCompare(a.id, b.id));
    if (members.length !== boundMembers.length) return false;
    return members.every((member, memberIndex) => {
      const bound = boundMembers[memberIndex];
      if (
        bound === undefined ||
        member.id !== bound.id ||
        member.claimDigest !== bound.catalogClaimDigest ||
        !sameDigest(member.sourceDigest, bound.sourceDigest)
      ) {
        return false;
      }
      const refs = [...member.authorityRefs].sort((a, b) =>
        codeUnitCompare(a.authorityId, b.authorityId),
      );
      const boundRefs = [...bound.authorityRefs].sort((a, b) =>
        codeUnitCompare(a.authorityId, b.authorityId),
      );
      return (
        refs.length === boundRefs.length &&
        refs.every((reference, referenceIndex) => {
          const boundReference = boundRefs[referenceIndex];
          return (
            boundReference !== undefined &&
            reference.authorityId === boundReference.authorityId &&
            reference.claimDigest === boundReference.claimDigest &&
            sameDigest(reference.sourceDigest, boundReference.sourceDigest)
          );
        })
      );
    });
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function custodyMatches(
  custody: CapabilityPackageCustodyReceipt,
  ownershipReceiptSha256: string,
  trustLockSha256: string,
  receipt: NonNullable<
    Extract<
      ReturnType<typeof planCapabilityPackageOwnedFiles>["lifecycle"],
      { status: "ready" }
    >["desiredReceipt"]
  >["receipt"],
  snapshot: ReturnType<typeof resolveInstalledSkillPackSnapshot>,
): boolean {
  if (
    custody.ownershipReceipt.sha256 !== ownershipReceiptSha256 ||
    custody.domainReceipt.sha256 !== trustLockSha256
  ) {
    return false;
  }
  const packagesByMember = new Map<string, string[]>();
  for (const pkg of receipt.packages) {
    for (const member of pkg.members) {
      const packageIds = packagesByMember.get(member.id) ?? [];
      packageIds.push(pkg.id);
      packagesByMember.set(member.id, packageIds);
    }
  }
  if (custody.members.length !== packagesByMember.size) return false;
  for (const member of custody.members) {
    const packageIds = packagesByMember.get(member.id);
    if (
      packageIds === undefined ||
      !sameStrings(member.packageIds, packageIds.sort(codeUnitCompare))
    ) {
      return false;
    }
  }
  if (custody.files.length !== snapshot.files.length) return false;
  return custody.files.every((file) => {
    const installed = snapshot.files.find(
      (candidate) => candidate.memberId === file.memberId && candidate.path === file.path,
    );
    return (
      installed !== undefined &&
      file.sha256 === installed.sha256 &&
      (hostPlatform === "win32" ? file.mode === undefined : file.mode === installed.mode)
    );
  });
}

/**
 * Verify an already-existing skill-pack custody receipt against live package state and bytes.
 * Absence stays explicitly unowned; this function never creates or writes custody evidence.
 */
export function planSkillPackCustody(input: unknown): DeepReadonly<SkillPackCustodyPlan> {
  const snapshot = snapshotInput(input);
  if (snapshot === undefined) return refused("invalid-input");

  let ownedPlan: ReturnType<typeof planCapabilityPackageOwnedFiles>;
  try {
    ownedPlan = planCapabilityPackageOwnedFiles({
      root: snapshot.root,
      lifecycleInput: snapshot.lifecycleInput,
    });
  } catch {
    return refused("invalid-input");
  }
  if (ownedPlan.lifecycle.status !== "ready") return refused("lifecycle-refused");
  if (ownedPlan.lifecycle.desiredReceipt === undefined) {
    return Object.freeze({
      schemaVersion: 1 as const,
      status: "not-applicable" as const,
      code: "no-desired-custody" as const,
    });
  }
  const trustLockBytes = readTrustLock(snapshot.root);
  if (trustLockBytes === undefined) return refused("invalid-trust-lock");
  const ownershipReceiptBytes = Buffer.from(ownedPlan.lifecycle.desiredReceipt.serialized, "utf8");
  const ownershipReceiptSha256 = sha256(ownershipReceiptBytes);
  const trustLockSha256 = sha256(trustLockBytes);
  const candidate: SkillPackCustodyCandidate = {
    path: capabilityPackageCustodyReceiptPath(ownershipReceiptSha256, trustLockSha256),
    ownershipReceiptSha256,
    trustLockSha256,
  };
  if (ownedPlan.steps.length !== 0) {
    return Object.freeze({
      schemaVersion: 1 as const,
      status: "unowned" as const,
      code: "ownership-state-pending" as const,
      candidate: freezeCandidate(candidate),
    });
  }

  const read = readCapabilityPackageCustodyReceipt(
    snapshot.root,
    ownershipReceiptSha256,
    trustLockSha256,
  );
  if (read.state === "absent") {
    return Object.freeze({
      schemaVersion: 1 as const,
      status: "unowned" as const,
      code: "missing-custody-receipt" as const,
      candidate: freezeCandidate(candidate),
    });
  }
  if (read.state === "malformed") return refused("invalid-custody-receipt", candidate);

  let intentBytes: Buffer;
  if (snapshot.lifecycleInput.operation === "remove") {
    if (ownedPlan.lifecycle.desiredIntent === undefined) return refused("lifecycle-refused");
    intentBytes = Buffer.from(ownedPlan.lifecycle.desiredIntent.bytes);
  } else {
    intentBytes = Buffer.from(snapshot.lifecycleInput.intentBytes);
  }

  let installed: ReturnType<typeof resolveInstalledSkillPackSnapshot>;
  try {
    const intent = parseCapabilityPackageIntentBytes(intentBytes);
    const resolution = resolveCapabilityPackages({
      manifest: intent.manifest,
      index: snapshot.lifecycleInput.index,
    });
    installed = resolveInstalledSkillPackSnapshot({
      root: snapshot.root,
      contextDir: snapshot.contextDir,
      resolution,
      index: snapshot.lifecycleInput.index,
      diagnostics: snapshot.lifecycleInput.diagnostics,
      trustLockBytes,
    });
  } catch {
    return refused("installed-snapshot-refused", candidate);
  }
  if (!exactAuthorityJoin(ownedPlan.lifecycle.desiredReceipt.receipt, installed.bindings)) {
    return refused("authority-mismatch", candidate);
  }

  if (
    !custodyMatches(
      read.receipt,
      ownershipReceiptSha256,
      trustLockSha256,
      ownedPlan.lifecycle.desiredReceipt.receipt,
      installed,
    )
  ) {
    return refused("custody-mismatch", candidate);
  }

  const finalOwnership = readCapabilityPackageOwnershipReceipt(snapshot.root);
  const finalTrustLockBytes = readTrustLock(snapshot.root);
  if (
    finalOwnership.state !== "valid" ||
    finalOwnership.sourceSha256 !== ownershipReceiptSha256 ||
    !finalOwnership.sourceBytes.equals(ownershipReceiptBytes) ||
    finalTrustLockBytes === undefined ||
    !finalTrustLockBytes.equals(trustLockBytes)
  ) {
    return refused("authority-state-changed", candidate);
  }

  let finalInstalled: ReturnType<typeof resolveInstalledSkillPackSnapshot>;
  try {
    const intent = parseCapabilityPackageIntentBytes(intentBytes);
    const resolution = resolveCapabilityPackages({
      manifest: intent.manifest,
      index: snapshot.lifecycleInput.index,
    });
    finalInstalled = resolveInstalledSkillPackSnapshot({
      root: snapshot.root,
      contextDir: snapshot.contextDir,
      resolution,
      index: snapshot.lifecycleInput.index,
      diagnostics: snapshot.lifecycleInput.diagnostics,
      trustLockBytes: finalTrustLockBytes,
    });
  } catch {
    return refused("authority-state-changed", candidate);
  }
  if (
    !exactAuthorityJoin(ownedPlan.lifecycle.desiredReceipt.receipt, finalInstalled.bindings) ||
    !custodyMatches(
      read.receipt,
      ownershipReceiptSha256,
      trustLockSha256,
      ownedPlan.lifecycle.desiredReceipt.receipt,
      finalInstalled,
    )
  ) {
    return refused("authority-state-changed", candidate);
  }

  let finalOwnedPlan: ReturnType<typeof planCapabilityPackageOwnedFiles>;
  try {
    finalOwnedPlan = planCapabilityPackageOwnedFiles({
      root: snapshot.root,
      lifecycleInput: snapshot.lifecycleInput,
    });
  } catch {
    return refused("authority-state-changed", candidate);
  }
  const finalTrust = readTrustLock(snapshot.root);
  const finalCustody = readCapabilityPackageCustodyReceipt(
    snapshot.root,
    ownershipReceiptSha256,
    trustLockSha256,
  );
  if (
    finalOwnedPlan.lifecycle.status !== "ready" ||
    finalOwnedPlan.lifecycle.desiredReceipt === undefined ||
    finalOwnedPlan.lifecycle.desiredReceipt.serialized !==
      ownedPlan.lifecycle.desiredReceipt.serialized ||
    finalOwnedPlan.steps.length !== 0 ||
    finalTrust === undefined ||
    !finalTrust.equals(trustLockBytes) ||
    finalCustody.state !== "valid" ||
    finalCustody.sourceSha256 !== read.sourceSha256 ||
    !finalCustody.sourceBytes.equals(read.sourceBytes)
  ) {
    return refused("authority-state-changed", candidate);
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    status: "verified-existing" as const,
    candidate: freezeCandidate({ ...candidate, custodyReceiptSha256: read.sourceSha256 }),
  });
}
