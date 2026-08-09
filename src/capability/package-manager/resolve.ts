import { z } from "zod";
import {
  type DeepReadonly,
  type PackageGraphIndex,
  type PackageGraphIndexAuthority,
  PackageGraphIndexSchema,
  type PackageGraphSurfaceClaim,
} from "../package-graph/build.js";
import { codeUnitCompare } from "../package-graph/canonical.js";
import type {
  PackageGraphSource,
  PackageGraphSourceDigest,
  PackageId,
} from "../package-graph/schema.js";
import {
  type CapabilityPackageManifest,
  CapabilityPackageManifestSchema,
  type CapabilityPackageNode,
} from "./schema.js";

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

export type CapabilityPackageResolutionErrorCode =
  | "invalid-input"
  | "invalid-index"
  | "input-limit"
  | "missing-authority"
  | "authority-source-mismatch"
  | "authority-projection-mismatch"
  | "missing-package"
  | "missing-root"
  | "missing-dependency"
  | "claim-pin-mismatch"
  | "source-pin-mismatch"
  | "member-pin-mismatch"
  | "relevant-package-conflict"
  | "relevant-member-conflict"
  | "orphan-package"
  | "orphan-authority"
  | "dependency-cycle";

const ERROR_MESSAGES: Record<CapabilityPackageResolutionErrorCode, string> = {
  "invalid-input": "capability package resolution input is not strict plain JSON",
  "invalid-index": "capability package graph index is invalid",
  "input-limit": "capability package resolution input exceeds its bounded JSON limit",
  "missing-authority": "capability package authority is missing",
  "authority-source-mismatch": "capability package authority source digest does not match",
  "authority-projection-mismatch": "capability package authority projection digest does not match",
  "missing-package": "capability package claim is missing",
  "missing-root": "capability package root is missing",
  "missing-dependency": "capability package dependency is missing",
  "claim-pin-mismatch": "capability package claim digest does not match",
  "source-pin-mismatch": "capability package source digest does not match",
  "member-pin-mismatch": "capability package direct member set does not match",
  "relevant-package-conflict": "capability package has divergent authority claims",
  "relevant-member-conflict": "capability package member has divergent authority claims",
  "orphan-package": "capability package manifest contains an unreachable package",
  "orphan-authority": "capability package manifest contains an unused authority",
  "dependency-cycle": "capability package dependencies contain a cycle",
};

export class CapabilityPackageResolutionError extends Error {
  readonly code: CapabilityPackageResolutionErrorCode;

  constructor(code: CapabilityPackageResolutionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CapabilityPackageResolutionError";
    this.code = code;
  }
}

export interface ResolvedCapabilityPackage {
  kind: "package";
  id: PackageId;
  authorityId: string;
  claimDigest: string;
  source: PackageGraphSource;
  sourceDigest: PackageGraphSourceDigest;
  dependencies: PackageId[];
  directMembers: PackageGraphSurfaceClaim[];
}

export interface CapabilityPackageResolution {
  schemaVersion: 1;
  roots: PackageId[];
  authorities: PackageGraphIndexAuthority[];
  packages: ResolvedCapabilityPackage[];
  installOrder: PackageId[];
}

interface GuardState {
  nodes: number;
  active: Set<object>;
}

class JsonGuardError extends Error {
  readonly limit: boolean;

  constructor(limit = false) {
    super("bounded JSON guard refused input");
    this.limit = limit;
  }
}

function countNode(state: GuardState, depth: number): void {
  state.nodes += 1;
  if (depth > MAX_JSON_DEPTH || state.nodes > MAX_JSON_NODES) throw new JsonGuardError(true);
}

function guardedJsonClone(value: unknown, state: GuardState, depth = 0): unknown {
  countNode(state, depth);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new JsonGuardError();
    return value;
  }
  if (typeof value !== "object") throw new JsonGuardError();
  if (state.active.has(value)) throw new JsonGuardError();
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new JsonGuardError();
      if (Object.getOwnPropertySymbols(value).length > 0) throw new JsonGuardError();
      const names = Object.getOwnPropertyNames(value);
      if (
        names.length !== value.length + 1 ||
        names.some((name) => {
          if (name === "length") return false;
          const index = Number(name);
          return (
            !Number.isInteger(index) || index < 0 || index >= value.length || `${index}` !== name
          );
        })
      ) {
        throw new JsonGuardError();
      }
      const clone: unknown[] = [];
      Object.defineProperty(clone, "toJSON", {
        configurable: false,
        enumerable: false,
        value: undefined,
        writable: false,
      });
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw new JsonGuardError();
        }
        clone.push(guardedJsonClone(descriptor.value, state, depth + 1));
      }
      return clone;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new JsonGuardError();
    if (Object.getOwnPropertySymbols(value).length > 0) throw new JsonGuardError();
    const clone: Record<string, unknown> = Object.create(null);
    for (const key of Object.getOwnPropertyNames(value).sort(codeUnitCompare)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new JsonGuardError();
      }
      clone[key] = guardedJsonClone(descriptor.value, state, depth + 1);
    }
    return clone;
  } finally {
    state.active.delete(value);
  }
}

const CapabilityPackageResolverInputSchema = z.strictObject({
  manifest: CapabilityPackageManifestSchema,
  index: PackageGraphIndexSchema,
});

function parseInput(input: unknown): {
  manifest: CapabilityPackageManifest;
  index: PackageGraphIndex;
} {
  let clone: unknown;
  try {
    clone = guardedJsonClone(input, { nodes: 0, active: new Set() });
  } catch (error) {
    if (error instanceof JsonGuardError) {
      throw new CapabilityPackageResolutionError(error.limit ? "input-limit" : "invalid-input");
    }
    throw new CapabilityPackageResolutionError("invalid-input");
  }
  const parsed = CapabilityPackageResolverInputSchema.safeParse(clone);
  if (!parsed.success) {
    const indexIssue = parsed.error.issues.some((issue) => issue.path[0] === "index");
    throw new CapabilityPackageResolutionError(indexIssue ? "invalid-index" : "invalid-input");
  }
  return parsed.data;
}

function fail(code: CapabilityPackageResolutionErrorCode): never {
  throw new CapabilityPackageResolutionError(code);
}

function sameDigest(
  left: { algorithm: string; value: string },
  right: { algorithm: string; value: string },
): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort(codeUnitCompare);
  const b = [...right].sort(codeUnitCompare);
  return a.length === b.length && a.every((value, index) => value === b[index]);
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

function dependencyOrder(manifest: CapabilityPackageManifest): {
  order: PackageId[];
  reachable: Set<string>;
} {
  const nodes = new Map(manifest.packages.map((node) => [node.id, node]));
  for (const root of manifest.roots) if (!nodes.has(root)) fail("missing-root");
  for (const node of manifest.packages) {
    for (const dependency of node.dependencies) {
      if (!nodes.has(dependency)) fail("missing-dependency");
    }
  }

  const reachable = new Set<string>();
  const pending = [...manifest.roots];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    const node = nodes.get(id);
    if (node === undefined) fail("missing-dependency");
    pending.push(...node.dependencies);
  }
  if (reachable.size !== manifest.packages.length) fail("orphan-package");

  const remainingDependencies = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of manifest.packages) {
    remainingDependencies.set(node.id, node.dependencies.length);
    for (const dependency of node.dependencies) {
      const existing = dependents.get(dependency);
      if (existing === undefined) dependents.set(dependency, [node.id]);
      else existing.push(node.id);
    }
  }
  const ready = manifest.packages
    .filter((node) => node.dependencies.length === 0)
    .map((node) => node.id)
    .sort(codeUnitCompare);
  const order: PackageId[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    order.push(id);
    for (const dependent of [...(dependents.get(id) ?? [])].sort(codeUnitCompare)) {
      const remaining = (remainingDependencies.get(dependent) ?? 0) - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(codeUnitCompare);
      }
    }
  }
  if (order.length !== manifest.packages.length) fail("dependency-cycle");
  return { order, reachable };
}

function packageClaim(index: PackageGraphIndex, node: CapabilityPackageNode) {
  const claim = index.claims.find(
    (candidate) =>
      candidate.entityKind === "package" &&
      candidate.id === node.id &&
      candidate.authorityId === node.authorityId,
  );
  if (claim?.entityKind !== "package") return fail("missing-package");
  return claim;
}

/** Resolve an exact committed package manifest against an integrity-checked additive index. */
export function resolveCapabilityPackages(
  input: unknown,
): DeepReadonly<CapabilityPackageResolution> {
  const { manifest, index } = parseInput(input);
  const indexAuthorities = new Map(index.authorities.map((authority) => [authority.id, authority]));
  for (const authority of manifest.authorities) {
    const indexed = indexAuthorities.get(authority.id);
    if (indexed === undefined || indexed.kind !== authority.kind) fail("missing-authority");
    if (!sameDigest(indexed.sourceDigest, authority.sourceDigest)) {
      fail("authority-source-mismatch");
    }
    if (indexed.projectionDigest !== authority.projectionDigest) {
      fail("authority-projection-mismatch");
    }
  }

  const listedAuthorities = new Map(
    manifest.authorities.map((authority) => [authority.id, authority]),
  );
  const { order, reachable } = dependencyOrder(manifest);
  if (reachable.size !== manifest.packages.length) fail("orphan-package");
  const packageConflicts = new Set(
    index.conflicts
      .filter((conflict) => conflict.entityKind === "package")
      .map((conflict) => conflict.id),
  );
  const surfaceConflicts = new Set(
    index.conflicts
      .filter((conflict) => conflict.entityKind === "surface")
      .map((conflict) => conflict.id),
  );
  const usedAuthorities = new Set<string>();
  const packages: ResolvedCapabilityPackage[] = [];

  for (const node of manifest.packages) {
    if (!listedAuthorities.has(node.authorityId)) fail("missing-authority");
    usedAuthorities.add(node.authorityId);
    if (packageConflicts.has(node.id)) fail("relevant-package-conflict");
    const claim = packageClaim(index, node);
    if (claim.claimDigest !== node.claimDigest) fail("claim-pin-mismatch");
    if (!sameDigest(claim.entity.sourceDigest, node.sourceDigest)) fail("source-pin-mismatch");
    if (!sameStringSet(claim.entity.members, node.members)) fail("member-pin-mismatch");
    const directMembers = [...node.members].sort(codeUnitCompare).map((memberId) => {
      if (surfaceConflicts.has(memberId)) fail("relevant-member-conflict");
      const member = index.claims.find(
        (candidate) =>
          candidate.entityKind === "surface" &&
          candidate.id === memberId &&
          candidate.authorityId === node.authorityId,
      );
      if (member?.entityKind !== "surface") fail("member-pin-mismatch");
      return structuredClone(member);
    });
    packages.push({
      kind: "package",
      id: node.id,
      authorityId: node.authorityId,
      claimDigest: node.claimDigest,
      source: structuredClone(claim.entity.source),
      sourceDigest: structuredClone(claim.entity.sourceDigest),
      dependencies: [...node.dependencies].sort(codeUnitCompare),
      directMembers,
    });
  }
  if (usedAuthorities.size !== manifest.authorities.length) fail("orphan-authority");

  const resolution: CapabilityPackageResolution = {
    schemaVersion: 1,
    roots: [...manifest.roots].sort(codeUnitCompare),
    authorities: manifest.authorities
      .filter((authority) => usedAuthorities.has(authority.id))
      .map((authority) => structuredClone(authority))
      .sort((left, right) => codeUnitCompare(left.id, right.id)),
    packages: packages.sort((left, right) => codeUnitCompare(left.id, right.id)),
    installOrder: order,
  };
  return deepFreeze(resolution);
}
