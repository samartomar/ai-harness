import { z } from "zod";
import {
  canonicalizeObjectKeys,
  canonicalJson,
  canonicalSha256,
  codeUnitCompare,
} from "./canonical.js";
import {
  type PackageGraph,
  type PackageGraphObservedRisk,
  type PackageGraphPackage,
  PackageGraphPackageSchema,
  type PackageGraphRiskFinding,
  PackageGraphSchema,
  type PackageGraphSurface,
  PackageGraphSurfaceSchema,
  PackageIdSchema,
  SurfaceIdSchema,
} from "./schema.js";

const LOWER_SHA256 = /^[0-9a-f]{64}$/;
export const PACKAGE_GRAPH_PROJECTION_DOMAIN = "aih.package-graph.authority-projection.v1";

export const PackageGraphAuthorityKindSchema = z.enum(["catalog", "lock", "receipt"]);

const AuthoritySourceDigestSchema = z
  .object({
    algorithm: z.literal("sha256"),
    value: z.string().regex(LOWER_SHA256),
  })
  .strict();

function authorityNamespaceIssue(
  authority: { id: string; kind: z.infer<typeof PackageGraphAuthorityKindSchema> },
  context: z.core.$RefinementCtx,
): void {
  if (authority.id.startsWith(`${authority.kind}:`)) return;
  context.addIssue({
    code: "custom",
    path: ["id"],
    message: "authority id namespace must match authority kind",
  });
}

export const PackageGraphAuthoritySchema = z
  .object({
    id: SurfaceIdSchema,
    kind: PackageGraphAuthorityKindSchema,
    sourceDigest: AuthoritySourceDigestSchema,
  })
  .strict()
  .superRefine(authorityNamespaceIssue);

export const PackageGraphAuthorityDocumentSchema = z
  .object({
    authority: PackageGraphAuthoritySchema,
    graph: PackageGraphSchema,
  })
  .strict();

export const PackageGraphAuthorityDocumentsSchema = z
  .array(PackageGraphAuthorityDocumentSchema)
  .superRefine((documents, context) => {
    const seen = new Set<string>();
    for (const [index, document] of documents.entries()) {
      if (seen.has(document.authority.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "authority", "id"],
          message: "duplicate authority id",
        });
      }
      seen.add(document.authority.id);
    }
  });

export const PackageGraphIndexAuthoritySchema = z
  .object({
    id: SurfaceIdSchema,
    kind: PackageGraphAuthorityKindSchema,
    sourceDigest: AuthoritySourceDigestSchema,
    projectionDigest: z.string().regex(LOWER_SHA256),
  })
  .strict()
  .superRefine(authorityNamespaceIssue);

const PackageGraphSurfaceClaimSchema = z
  .object({
    entityKind: z.literal("surface"),
    id: SurfaceIdSchema,
    authorityId: SurfaceIdSchema,
    claimDigest: z.string().regex(LOWER_SHA256),
    entity: PackageGraphSurfaceSchema,
  })
  .strict();

const PackageGraphPackageClaimSchema = z
  .object({
    entityKind: z.literal("package"),
    id: PackageIdSchema,
    authorityId: SurfaceIdSchema,
    claimDigest: z.string().regex(LOWER_SHA256),
    entity: PackageGraphPackageSchema,
  })
  .strict();

export const PackageGraphClaimSchema = z.discriminatedUnion("entityKind", [
  PackageGraphSurfaceClaimSchema,
  PackageGraphPackageClaimSchema,
]);

export const PackageGraphConflictClaimDigestSchema = z
  .object({
    authorityId: SurfaceIdSchema,
    digest: z.string().regex(LOWER_SHA256),
  })
  .strict();

const PackageGraphSurfaceConflictSchema = z
  .object({
    entityKind: z.literal("surface"),
    id: SurfaceIdSchema,
    claimDigests: z.array(PackageGraphConflictClaimDigestSchema),
  })
  .strict();

const PackageGraphPackageConflictSchema = z
  .object({
    entityKind: z.literal("package"),
    id: PackageIdSchema,
    claimDigests: z.array(PackageGraphConflictClaimDigestSchema),
  })
  .strict();

export const PackageGraphConflictSchema = z.discriminatedUnion("entityKind", [
  PackageGraphSurfaceConflictSchema,
  PackageGraphPackageConflictSchema,
]);

const PackageGraphIndexStructureSchema = z
  .object({
    schemaVersion: z.literal(1),
    authorities: z.array(PackageGraphIndexAuthoritySchema),
    claims: z.array(PackageGraphClaimSchema),
    conflicts: z.array(PackageGraphConflictSchema),
  })
  .strict();

type MutablePackageGraphAuthority = z.infer<typeof PackageGraphAuthoritySchema>;
type MutablePackageGraphAuthorityDocument = z.infer<typeof PackageGraphAuthorityDocumentSchema>;
type MutablePackageGraphIndexAuthority = z.infer<typeof PackageGraphIndexAuthoritySchema>;
type MutablePackageGraphSurfaceClaim = z.infer<typeof PackageGraphSurfaceClaimSchema>;
type MutablePackageGraphPackageClaim = z.infer<typeof PackageGraphPackageClaimSchema>;
type MutablePackageGraphClaim = z.infer<typeof PackageGraphClaimSchema>;
type MutablePackageGraphConflictClaimDigest = z.infer<typeof PackageGraphConflictClaimDigestSchema>;
type MutablePackageGraphConflict = z.infer<typeof PackageGraphConflictSchema>;
type MutablePackageGraphIndex = z.infer<typeof PackageGraphIndexStructureSchema>;

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type PackageGraphAuthorityKind = z.infer<typeof PackageGraphAuthorityKindSchema>;
export type PackageGraphAuthority = DeepReadonly<MutablePackageGraphAuthority>;
export type PackageGraphAuthorityDocument = DeepReadonly<MutablePackageGraphAuthorityDocument>;
export type PackageGraphIndexAuthority = DeepReadonly<MutablePackageGraphIndexAuthority>;
export type PackageGraphSurfaceClaim = DeepReadonly<MutablePackageGraphSurfaceClaim>;
export type PackageGraphPackageClaim = DeepReadonly<MutablePackageGraphPackageClaim>;
export type PackageGraphClaim = DeepReadonly<MutablePackageGraphClaim>;
export type PackageGraphConflictClaimDigest = DeepReadonly<MutablePackageGraphConflictClaimDigest>;
export type PackageGraphConflict = DeepReadonly<MutablePackageGraphConflict>;
export type PackageGraphIndex = DeepReadonly<MutablePackageGraphIndex>;

function compareCanonical(left: unknown, right: unknown): number {
  return codeUnitCompare(canonicalJson(left), canonicalJson(right));
}

function normalizeFindings(findings: PackageGraphRiskFinding[]): PackageGraphRiskFinding[] {
  return findings
    .map((finding) => ({ ...finding }))
    .sort((left, right) => compareCanonical(left, right));
}

function normalizeObservedRisk(risks: PackageGraphObservedRisk[]): PackageGraphObservedRisk[] {
  return risks
    .map((risk) => ({
      ...risk,
      detector: { ...risk.detector },
      evidence: {
        ...risk.evidence,
        subjectDigest: { ...risk.evidence.subjectDigest },
      },
      findings: normalizeFindings(risk.findings),
    }))
    .sort((left, right) => compareCanonical(left, right));
}

function normalizeSurface(surface: PackageGraphSurface): PackageGraphSurface {
  return {
    ...surface,
    source: { ...surface.source },
    sourceDigest: { ...surface.sourceDigest },
    declaredRisk: surface.declaredRisk
      .map((risk) => ({ ...risk }))
      .sort((left, right) => compareCanonical(left, right)),
    observedRisk: normalizeObservedRisk(surface.observedRisk),
  };
}

function normalizePackage(pkg: PackageGraphPackage): PackageGraphPackage {
  return {
    ...pkg,
    source: { ...pkg.source },
    sourceDigest: { ...pkg.sourceDigest },
    members: [...pkg.members].sort(codeUnitCompare),
    declaredRisk: pkg.declaredRisk
      .map((risk) => ({ ...risk }))
      .sort((left, right) => compareCanonical(left, right)),
    observedRisk: normalizeObservedRisk(pkg.observedRisk),
  };
}

function normalizeGraph(graph: PackageGraph): PackageGraph {
  return {
    schemaVersion: 1,
    surfaces: graph.surfaces
      .map(normalizeSurface)
      .sort((left, right) => codeUnitCompare(left.id, right.id)),
    packages: graph.packages
      .map(normalizePackage)
      .sort((left, right) => codeUnitCompare(left.id, right.id)),
  };
}

function projectionDigest(graph: PackageGraph): string {
  return canonicalSha256({
    domain: PACKAGE_GRAPH_PROJECTION_DOMAIN,
    graph: normalizeGraph(graph),
  });
}

function authorityCompare(
  left: MutablePackageGraphIndexAuthority,
  right: MutablePackageGraphIndexAuthority,
): number {
  return codeUnitCompare(left.id, right.id);
}

function claimCompare(left: MutablePackageGraphClaim, right: MutablePackageGraphClaim): number {
  return (
    codeUnitCompare(left.entityKind, right.entityKind) ||
    codeUnitCompare(left.id, right.id) ||
    codeUnitCompare(left.authorityId, right.authorityId)
  );
}

function conflictCompare(
  left: MutablePackageGraphConflict,
  right: MutablePackageGraphConflict,
): number {
  return codeUnitCompare(left.entityKind, right.entityKind) || codeUnitCompare(left.id, right.id);
}

function conflictKey(claim: MutablePackageGraphClaim): string {
  return canonicalJson([claim.entityKind, claim.id]);
}

function conflictsFor(claims: MutablePackageGraphClaim[]): MutablePackageGraphConflict[] {
  const groups = new Map<string, MutablePackageGraphClaim[]>();
  for (const claim of claims) {
    const key = conflictKey(claim);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [claim]);
    else existing.push(claim);
  }

  const conflicts: MutablePackageGraphConflict[] = [];
  for (const group of groups.values()) {
    if (new Set(group.map((claim) => claim.claimDigest)).size < 2) continue;
    const first = group[0];
    if (first === undefined) continue;
    conflicts.push({
      entityKind: first.entityKind,
      id: first.id,
      claimDigests: group.map((claim) => ({
        authorityId: claim.authorityId,
        digest: claim.claimDigest,
      })),
    });
  }
  return conflicts.sort(conflictCompare);
}

function graphForAuthority(authorityId: string, claims: MutablePackageGraphClaim[]): PackageGraph {
  const surfaces: PackageGraphSurface[] = [];
  const packages: PackageGraphPackage[] = [];
  for (const claim of claims) {
    if (claim.authorityId !== authorityId) continue;
    if (claim.entityKind === "surface") surfaces.push(normalizeSurface(claim.entity));
    else packages.push(normalizePackage(claim.entity));
  }
  return normalizeGraph({ schemaVersion: 1, surfaces, packages });
}

function addIntegrityIssue(
  context: z.core.$RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", path, message });
}

function indexIntegrityIssues(
  index: MutablePackageGraphIndex,
  context: z.core.$RefinementCtx,
): void {
  const authorityIds = new Set<string>();
  for (const [authorityIndex, authority] of index.authorities.entries()) {
    if (authorityIds.has(authority.id)) {
      addIntegrityIssue(context, ["authorities", authorityIndex, "id"], "duplicate authority id");
    }
    authorityIds.add(authority.id);
  }
  const sortedAuthorities = [...index.authorities].sort(authorityCompare);
  if (canonicalJson(index.authorities) !== canonicalJson(sortedAuthorities)) {
    addIntegrityIssue(context, ["authorities"], "authorities must be in canonical order");
  }

  const claimTuples = new Set<string>();
  for (const [claimIndex, claim] of index.claims.entries()) {
    const tuple = canonicalJson([claim.entityKind, claim.id, claim.authorityId]);
    if (claimTuples.has(tuple)) {
      addIntegrityIssue(context, ["claims", claimIndex], "duplicate authority entity claim tuple");
    }
    claimTuples.add(tuple);
    if (!authorityIds.has(claim.authorityId)) {
      addIntegrityIssue(
        context,
        ["claims", claimIndex, "authorityId"],
        "unknown authority reference",
      );
    }
    if (claim.id !== claim.entity.id) {
      addIntegrityIssue(context, ["claims", claimIndex, "id"], "claim id must match entity id");
    }
    const normalized =
      claim.entityKind === "surface"
        ? normalizeSurface(claim.entity)
        : normalizePackage(claim.entity);
    if (canonicalJson(claim.entity) !== canonicalJson(normalized)) {
      addIntegrityIssue(
        context,
        ["claims", claimIndex, "entity"],
        "claim entity is not normalized",
      );
    }
    if (claim.claimDigest !== canonicalSha256(normalized)) {
      addIntegrityIssue(context, ["claims", claimIndex, "claimDigest"], "stale claim digest");
    }
  }
  const sortedClaims = [...index.claims].sort(claimCompare);
  if (canonicalJson(index.claims) !== canonicalJson(sortedClaims)) {
    addIntegrityIssue(context, ["claims"], "claims must be in canonical order");
  }

  for (const [authorityIndex, authority] of index.authorities.entries()) {
    const graph = graphForAuthority(authority.id, index.claims);
    if (!PackageGraphSchema.safeParse(graph).success) {
      addIntegrityIssue(
        context,
        ["authorities", authorityIndex, "projectionDigest"],
        "authority claims do not form a valid package graph",
      );
      continue;
    }
    if (authority.projectionDigest !== projectionDigest(graph)) {
      addIntegrityIssue(
        context,
        ["authorities", authorityIndex, "projectionDigest"],
        "stale authority projection digest",
      );
    }
  }

  const expectedConflicts = conflictsFor(index.claims);
  if (canonicalJson(index.conflicts) !== canonicalJson(expectedConflicts)) {
    addIntegrityIssue(context, ["conflicts"], "conflicts do not match canonical claim conflicts");
  }
}

export const PackageGraphIndexSchema =
  PackageGraphIndexStructureSchema.superRefine(indexIntegrityIssues);

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

export function buildPackageGraphIndex(input: unknown): PackageGraphIndex {
  const documents = PackageGraphAuthorityDocumentsSchema.parse(input);
  const authorities: MutablePackageGraphIndexAuthority[] = [];
  const claims: MutablePackageGraphClaim[] = [];

  for (const document of documents) {
    const graph = normalizeGraph(document.graph);
    authorities.push({
      id: document.authority.id,
      kind: document.authority.kind,
      sourceDigest: { ...document.authority.sourceDigest },
      projectionDigest: projectionDigest(graph),
    });
    for (const entity of graph.surfaces) {
      claims.push({
        entityKind: "surface",
        id: entity.id,
        authorityId: document.authority.id,
        claimDigest: canonicalSha256(entity),
        entity,
      });
    }
    for (const entity of graph.packages) {
      claims.push({
        entityKind: "package",
        id: entity.id,
        authorityId: document.authority.id,
        claimDigest: canonicalSha256(entity),
        entity,
      });
    }
  }

  authorities.sort(authorityCompare);
  claims.sort(claimCompare);
  const index: MutablePackageGraphIndex = {
    schemaVersion: 1,
    authorities,
    claims,
    conflicts: conflictsFor(claims),
  };
  PackageGraphIndexSchema.parse(index);
  return deepFreeze(index);
}

export function serializePackageGraphIndex(input: unknown): string {
  const index = PackageGraphIndexSchema.parse(input);
  return `${JSON.stringify(canonicalizeObjectKeys(index), null, 2)}\n`;
}
