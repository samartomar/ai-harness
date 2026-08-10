import { isProxy } from "node:util/types";
import {
  type DeepReadonly,
  type PackageGraphIndex,
  PackageGraphIndexSchema,
} from "../../package-graph/build.js";
import { codeUnitCompare } from "../../package-graph/canonical.js";
import type { CapabilityPackageResolution } from "../resolve.js";
import type { SkillPackAuthorityBinding } from "./skill-pack.js";

export type CapabilityPackageEccDomainErrorCode =
  | "invalid-input"
  | "invalid-index"
  | "invalid-resolution"
  | "unsupported-package-family"
  | "missing-lock-claim"
  | "missing-receipt-claim";

export class CapabilityPackageEccDomainError extends Error {
  readonly code: CapabilityPackageEccDomainErrorCode;

  constructor(code: CapabilityPackageEccDomainErrorCode) {
    super(`ECC capability package authority binding refused: ${code}`);
    this.name = "CapabilityPackageEccDomainError";
    this.code = code;
  }
}

function fail(code: CapabilityPackageEccDomainErrorCode): never {
  throw new CapabilityPackageEccDomainError(code);
}

interface GuardState {
  active: Set<object>;
  nodes: number;
}

function cloneJson(value: unknown, state: GuardState, depth = 0): unknown {
  state.nodes += 1;
  if (depth > 64 || state.nodes > 100_000) fail("invalid-input");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail("invalid-input");
    return value;
  }
  if (typeof value !== "object" || isProxy(value) || state.active.has(value)) {
    fail("invalid-input");
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.getOwnPropertyNames(value).length !== value.length + 1
      ) {
        fail("invalid-input");
      }
      return value.map((_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          fail("invalid-input");
        }
        return cloneJson(descriptor.value, state, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      fail("invalid-input");
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(value).sort(codeUnitCompare)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        fail("invalid-input");
      }
      output[name] = cloneJson(descriptor.value, state, depth + 1);
    }
    return output;
  } finally {
    state.active.delete(value);
  }
}

function sameSource(
  left: { provider: string; repository: string },
  right: { provider: string; repository: string },
): boolean {
  return (
    left.provider === right.provider &&
    left.repository.toLowerCase() === right.repository.toLowerCase()
  );
}

function sameDigest(
  left: { algorithm: string; value: string },
  right: { algorithm: string; value: string },
): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function validResolution(value: unknown): value is CapabilityPackageResolution {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
    Array.isArray((value as { packages?: unknown }).packages)
  );
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Bind ECC package lock claims to exact existing domain-receipt claims. */
export function resolveEccDomainAuthorityBindings(
  input: unknown,
): DeepReadonly<SkillPackAuthorityBinding[]> {
  const cloned = cloneJson(input, { active: new Set(), nodes: 0 });
  if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned)) fail("invalid-input");
  const record = cloned as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !("resolution" in record) || !("index" in record)) {
    fail("invalid-input");
  }
  const parsedIndex = PackageGraphIndexSchema.safeParse(record.index);
  if (!parsedIndex.success) fail("invalid-index");
  if (!validResolution(record.resolution)) fail("invalid-resolution");
  const index: PackageGraphIndex = parsedIndex.data;
  const resolution = record.resolution;

  const bindings = resolution.packages.map((pkg): SkillPackAuthorityBinding => {
    if (!/^package:ecc-(?:agent|rule|mcp)\//.test(pkg.id)) {
      fail("unsupported-package-family");
    }
    if (pkg.directMembers.length !== 1) fail("invalid-resolution");
    const member = pkg.directMembers[0];
    if (member === undefined || member.authorityId !== pkg.authorityId) fail("missing-lock-claim");
    const authority = index.authorities.find(({ id }) => id === member.authorityId);
    const expectedKind = pkg.id.startsWith("package:ecc-mcp/") ? "catalog" : "lock";
    if (authority?.kind !== expectedKind) fail("missing-lock-claim");

    const receipts = index.claims.filter(
      (claim) =>
        claim.entityKind === "surface" &&
        claim.id === member.id &&
        index.authorities.some(({ id, kind }) => id === claim.authorityId && kind === "receipt") &&
        claim.claimDigest === member.claimDigest &&
        sameSource(claim.entity.source, member.entity.source) &&
        sameDigest(claim.entity.sourceDigest, member.entity.sourceDigest),
    );
    if (receipts.length !== 1) fail("missing-receipt-claim");
    return {
      id: pkg.id,
      authorityId: pkg.authorityId,
      claimDigest: pkg.claimDigest,
      source: structuredClone(pkg.source),
      sourceDigest: structuredClone(pkg.sourceDigest),
      dependencies: [...pkg.dependencies],
      members: [
        {
          id: member.id,
          catalogClaimDigest: member.claimDigest,
          source: structuredClone(member.entity.source),
          sourceDigest: structuredClone(member.entity.sourceDigest),
          authorityRefs: receipts.map((claim) => ({
            authorityId: claim.authorityId,
            claimDigest: claim.claimDigest,
            sourceDigest: structuredClone(claim.entity.sourceDigest),
          })),
        },
      ],
    };
  });
  return deepFreeze(bindings);
}
