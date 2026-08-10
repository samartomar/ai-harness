import { isProxy } from "node:util/types";
import { z } from "zod";
import type { SkillPackageGraphDiagnostic } from "../../package-graph/adapters/skills.js";
import {
  type DeepReadonly,
  type PackageGraphIndex,
  PackageGraphIndexSchema,
  type PackageGraphSurfaceClaim,
} from "../../package-graph/build.js";
import { codeUnitCompare } from "../../package-graph/canonical.js";
import type {
  PackageGraphSource,
  PackageGraphSourceDigest,
  PackageId,
  SurfaceId,
} from "../../package-graph/schema.js";
import type { CapabilityPackageResolution } from "../resolve.js";

export type CapabilityPackageSkillPackErrorCode =
  | "invalid-index"
  | "invalid-resolution"
  | "invalid-diagnostics"
  | "unsupported-package-family"
  | "package-authority-not-catalog"
  | "missing-catalog-claim"
  | "catalog-claim-mismatch"
  | "unsupported-member-family"
  | "missing-lock-claim"
  | "relevant-package-conflict"
  | "relevant-member-conflict"
  | "unsupported-required-checks"
  | "unsupported-source";

const ERROR_MESSAGES: Record<CapabilityPackageSkillPackErrorCode, string> = {
  "invalid-index": "capability package graph index is invalid",
  "invalid-resolution": "capability package resolution is invalid",
  "invalid-diagnostics": "skill pack diagnostics are invalid",
  "unsupported-package-family": "capability package family is not supported",
  "package-authority-not-catalog": "skill pack authority is not a catalog",
  "missing-catalog-claim": "skill pack catalog claim is missing",
  "catalog-claim-mismatch": "skill pack catalog claim does not match resolution",
  "unsupported-member-family": "skill pack member family is not supported",
  "missing-lock-claim": "skill pack member lacks exact lock authority",
  "relevant-package-conflict": "skill pack has divergent package claims",
  "relevant-member-conflict": "skill pack member has divergent claims",
  "unsupported-required-checks": "skill pack required checks are not supported",
  "unsupported-source": "skill pack source provider is not supported",
};

export class CapabilityPackageSkillPackError extends Error {
  readonly code: CapabilityPackageSkillPackErrorCode;

  constructor(code: CapabilityPackageSkillPackErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CapabilityPackageSkillPackError";
    this.code = code;
  }
}

export interface SkillPackAuthorityRef {
  authorityId: string;
  claimDigest: string;
  sourceDigest: PackageGraphSourceDigest;
}

export interface SkillPackAuthorityMemberBinding {
  id: SurfaceId;
  catalogClaimDigest: string;
  source: PackageGraphSource;
  sourceDigest: PackageGraphSourceDigest;
  authorityRefs: SkillPackAuthorityRef[];
}

export interface SkillPackAuthorityBinding {
  id: PackageId;
  authorityId: string;
  claimDigest: string;
  source: PackageGraphSource;
  sourceDigest: PackageGraphSourceDigest;
  dependencies: PackageId[];
  members: SkillPackAuthorityMemberBinding[];
}

export interface SkillPackAuthorityBridgeInput {
  resolution: DeepReadonly<CapabilityPackageResolution>;
  index: PackageGraphIndex;
  diagnostics: readonly SkillPackageGraphDiagnostic[];
}

const DiagnosticSchema = z.strictObject({
  authorityKind: z.enum(["lock", "catalog"]),
  code: z.enum([
    "package-graph.invalid-utf8",
    "package-graph.invalid-json",
    "package-graph.invalid-schema",
    "package-graph.duplicate-lock-name",
    "package-graph.duplicate-pack-name",
    "package-graph.duplicate-pack-member",
    "package-graph.cross-pack-member",
    "package-graph.unsupported-source",
    "package-graph.source-commit-mismatch",
    "package-graph.invalid-surface-id",
    "package-graph.invalid-package-id",
    "package-graph.invalid-host-source",
    "package-graph.invalid-authority-id",
    "package-graph.catalog-only-ref",
    "package-graph.catalog-lock-mismatch",
    "package-graph.required-checks-unsupported",
  ]),
  message: z.string().max(160),
  entityId: z.string().max(160).optional(),
});

const DiagnosticsSchema = z.array(DiagnosticSchema).max(4_096);

interface GuardState {
  active: Set<object>;
  nodes: number;
}

function guardedClone(value: unknown, state: GuardState, depth = 0): unknown {
  state.nodes += 1;
  if (depth > 64 || state.nodes > 100_000) throw new Error("bounded bridge input");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("invalid bridge number");
    return value;
  }
  if (typeof value !== "object" || isProxy(value) || state.active.has(value)) {
    throw new Error("invalid bridge value");
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length !== 0
      ) {
        throw new Error("invalid bridge array");
      }
      const names = Object.getOwnPropertyNames(value);
      if (
        names.length !== value.length + 1 ||
        !names.includes("length") ||
        names.some((name) => name !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(name))
      ) {
        throw new Error("invalid bridge array");
      }
      const clone: unknown[] = [];
      Object.defineProperty(clone, "toJSON", { value: undefined });
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("invalid bridge array entry");
        }
        clone.push(guardedClone(descriptor.value, state, depth + 1));
      }
      return clone;
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0
    ) {
      throw new Error("invalid bridge object");
    }
    const clone = Object.create(null) as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(value).sort(codeUnitCompare)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("invalid bridge property");
      }
      clone[name] = guardedClone(descriptor.value, state, depth + 1);
    }
    return clone;
  } finally {
    state.active.delete(value);
  }
}

function safeClone(value: unknown): unknown {
  return guardedClone(value, { active: new Set(), nodes: 0 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validSource(value: unknown): boolean {
  return (
    isRecord(value) && typeof value.provider === "string" && typeof value.repository === "string"
  );
}

function validDigest(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.algorithm === "git-sha1" || value.algorithm === "sha256") &&
    typeof value.value === "string"
  );
}

function validResolvedPackage(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.kind !== "package" ||
    typeof value.id !== "string" ||
    typeof value.authorityId !== "string" ||
    typeof value.claimDigest !== "string" ||
    !validSource(value.source) ||
    !validDigest(value.sourceDigest) ||
    !Array.isArray(value.dependencies) ||
    !value.dependencies.every((id) => typeof id === "string") ||
    !Array.isArray(value.directMembers)
  ) {
    return false;
  }
  return value.directMembers.every(
    (member) =>
      isRecord(member) &&
      member.entityKind === "surface" &&
      typeof member.id === "string" &&
      typeof member.authorityId === "string" &&
      typeof member.claimDigest === "string" &&
      isRecord(member.entity) &&
      member.entity.id === member.id &&
      validSource(member.entity.source) &&
      validDigest(member.entity.sourceDigest),
  );
}

function fail(code: CapabilityPackageSkillPackErrorCode): never {
  throw new CapabilityPackageSkillPackError(code);
}

function sameSource(left: PackageGraphSource, right: PackageGraphSource): boolean {
  return left.provider === right.provider && left.repository === right.repository;
}

function sameDigest(left: PackageGraphSourceDigest, right: PackageGraphSourceDigest): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
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

function exactCatalogMember(
  index: PackageGraphIndex,
  member: DeepReadonly<PackageGraphSurfaceClaim>,
): PackageGraphSurfaceClaim {
  const claim = index.claims.find(
    (candidate) =>
      candidate.entityKind === "surface" &&
      candidate.id === member.id &&
      candidate.authorityId === member.authorityId,
  );
  if (
    claim?.entityKind !== "surface" ||
    claim.claimDigest !== member.claimDigest ||
    !sameSource(claim.entity.source, member.entity.source) ||
    !sameDigest(claim.entity.sourceDigest, member.entity.sourceDigest)
  ) {
    fail("catalog-claim-mismatch");
  }
  return claim;
}

/**
 * Prove that resolved skill-pack catalog claims are corroborated by immutable lock claims.
 * This is authority metadata only; it does not assert installation or configuration.
 */
export function resolveSkillPackAuthorityBindings(
  input: SkillPackAuthorityBridgeInput,
): DeepReadonly<SkillPackAuthorityBinding[]> {
  let clonedIndex: unknown;
  let clonedResolution: unknown;
  let clonedDiagnostics: unknown;
  try {
    clonedIndex = safeClone(input.index);
  } catch {
    fail("invalid-index");
  }
  try {
    clonedResolution = safeClone(input.resolution);
  } catch {
    fail("invalid-resolution");
  }
  try {
    clonedDiagnostics = safeClone(input.diagnostics);
  } catch {
    fail("invalid-diagnostics");
  }
  const parsedIndex = PackageGraphIndexSchema.safeParse(clonedIndex);
  if (!parsedIndex.success) fail("invalid-index");
  if (
    clonedResolution === null ||
    typeof clonedResolution !== "object" ||
    !("schemaVersion" in clonedResolution) ||
    clonedResolution.schemaVersion !== 1 ||
    !("packages" in clonedResolution) ||
    !Array.isArray(clonedResolution.packages) ||
    clonedResolution.packages.length === 0 ||
    !clonedResolution.packages.every(validResolvedPackage)
  ) {
    fail("invalid-resolution");
  }
  const parsedDiagnostics = DiagnosticsSchema.safeParse(clonedDiagnostics);
  if (!parsedDiagnostics.success) fail("invalid-diagnostics");
  const index = parsedIndex.data;
  const resolution = clonedResolution as unknown as CapabilityPackageResolution;
  const diagnostics = parsedDiagnostics.data;
  const packageConflicts = new Set(
    index.conflicts.filter(({ entityKind }) => entityKind === "package").map(({ id }) => id),
  );
  const surfaceConflicts = new Set(
    index.conflicts.filter(({ entityKind }) => entityKind === "surface").map(({ id }) => id),
  );

  const bindings = resolution.packages.map((pkg): SkillPackAuthorityBinding => {
    if (!pkg.id.startsWith("package:skill-pack/")) fail("unsupported-package-family");
    if (packageConflicts.has(pkg.id)) fail("relevant-package-conflict");
    const authority = index.authorities.find(({ id }) => id === pkg.authorityId);
    if (authority?.kind !== "catalog") fail("package-authority-not-catalog");
    if (
      diagnostics.some(
        ({ code, entityId }) =>
          code === "package-graph.required-checks-unsupported" && entityId === pkg.id,
      )
    ) {
      fail("unsupported-required-checks");
    }
    if (pkg.source.provider !== "github") fail("unsupported-source");

    for (const member of pkg.directMembers) {
      if (!member.id.startsWith("skill:")) fail("unsupported-member-family");
      if (surfaceConflicts.has(member.id)) fail("relevant-member-conflict");
    }
    const packageClaim = index.claims.find(
      (candidate) =>
        candidate.entityKind === "package" &&
        candidate.id === pkg.id &&
        candidate.authorityId === pkg.authorityId,
    );
    if (packageClaim?.entityKind !== "package") fail("missing-catalog-claim");
    if (
      packageClaim.claimDigest !== pkg.claimDigest ||
      !sameSource(packageClaim.entity.source, pkg.source) ||
      !sameDigest(packageClaim.entity.sourceDigest, pkg.sourceDigest) ||
      !sameMembers(
        packageClaim.entity.members,
        pkg.directMembers.map(({ id }) => id),
      )
    ) {
      fail("catalog-claim-mismatch");
    }

    const members = pkg.directMembers
      .map((resolvedMember): SkillPackAuthorityMemberBinding => {
        const catalogMember = exactCatalogMember(index, resolvedMember);
        if (catalogMember.entity.source.provider !== "github") fail("unsupported-source");
        const authorityRefs = index.claims
          .flatMap((candidate): SkillPackAuthorityRef[] =>
            candidate.entityKind === "surface" &&
            candidate.id === catalogMember.id &&
            index.authorities.some(
              ({ id, kind }) => id === candidate.authorityId && kind === "lock",
            ) &&
            candidate.claimDigest === catalogMember.claimDigest &&
            sameSource(candidate.entity.source, catalogMember.entity.source) &&
            sameDigest(candidate.entity.sourceDigest, catalogMember.entity.sourceDigest)
              ? [
                  {
                    authorityId: candidate.authorityId,
                    claimDigest: candidate.claimDigest,
                    sourceDigest: structuredClone(candidate.entity.sourceDigest),
                  },
                ]
              : [],
          )
          .sort(
            (left, right) =>
              codeUnitCompare(left.authorityId, right.authorityId) ||
              codeUnitCompare(left.claimDigest, right.claimDigest) ||
              codeUnitCompare(left.sourceDigest.algorithm, right.sourceDigest.algorithm) ||
              codeUnitCompare(left.sourceDigest.value, right.sourceDigest.value),
          );
        if (authorityRefs.length === 0) fail("missing-lock-claim");
        return {
          id: catalogMember.id,
          catalogClaimDigest: catalogMember.claimDigest,
          source: structuredClone(catalogMember.entity.source),
          sourceDigest: structuredClone(catalogMember.entity.sourceDigest),
          authorityRefs,
        };
      })
      .sort((left, right) => codeUnitCompare(left.id, right.id));

    return {
      id: pkg.id,
      authorityId: pkg.authorityId,
      claimDigest: pkg.claimDigest,
      source: structuredClone(pkg.source),
      sourceDigest: structuredClone(pkg.sourceDigest),
      dependencies: [...pkg.dependencies].sort(codeUnitCompare),
      members,
    };
  });
  bindings.sort((left, right) => codeUnitCompare(left.id, right.id));
  return deepFreeze(bindings);
}
