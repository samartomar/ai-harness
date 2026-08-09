import { z } from "zod";
import { type PackageGraphIndex, PackageGraphIndexSchema } from "../build.js";
import { codeUnitCompare } from "../canonical.js";
import {
  type PackageGraphSource,
  type PackageGraphSourceDigest,
  PackageGraphSourceDigestSchema,
  PackageGraphSourceSchema,
  SurfaceIdSchema,
} from "../schema.js";

const DiscoveredSurfaceFactSchema = z
  .object({
    id: SurfaceIdSchema,
    kind: z.enum(["skill", "mcp"]),
    rootKind: z.enum(["promoted", "repo", "machine", "quarantine"]),
    source: PackageGraphSourceSchema.optional(),
    sourceDigest: PackageGraphSourceDigestSchema.optional(),
  })
  .strict()
  .superRefine((fact, context) => {
    if (fact.id.startsWith(`${fact.kind}:`)) return;
    context.addIssue({
      code: "custom",
      path: ["kind"],
      message: "discovered surface kind must match its id namespace",
    });
  });

const DiscoveredSurfaceFactsSchema = z
  .array(DiscoveredSurfaceFactSchema)
  .superRefine((facts, context) => {
    const seen = new Set<string>();
    for (const [index, fact] of facts.entries()) {
      if (seen.has(fact.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "duplicate discovered surface id",
        });
      }
      seen.add(fact.id);
    }
  });

export type DiscoveredSurfaceFact = z.infer<typeof DiscoveredSurfaceFactSchema>;

export interface ClassifiedImmutableSurface {
  id: string;
  kind: DiscoveredSurfaceFact["kind"];
  rootKind: DiscoveredSurfaceFact["rootKind"];
  source: PackageGraphSource;
  sourceDigest: PackageGraphSourceDigest;
  authorityIds: string[];
}

export interface UndeclaredImmutableSurface {
  id: string;
  kind: DiscoveredSurfaceFact["kind"];
  rootKind: DiscoveredSurfaceFact["rootKind"];
  source: PackageGraphSource;
  sourceDigest: PackageGraphSourceDigest;
}

export type UnsupportedSurfaceReason =
  | "missing-source"
  | "missing-source-digest"
  | "missing-source-and-digest";

export interface UnsupportedDiscoveredSurface {
  id: string;
  kind: DiscoveredSurfaceFact["kind"];
  rootKind: DiscoveredSurfaceFact["rootKind"];
  reason: UnsupportedSurfaceReason;
}

export interface PackageGraphResidueClassification {
  registered: ClassifiedImmutableSurface[];
  catalogOnly: ClassifiedImmutableSurface[];
  undeclared: UndeclaredImmutableSurface[];
  divergent: ClassifiedImmutableSurface[];
  unsupported: UnsupportedDiscoveredSurface[];
}

type SurfaceClaim = Extract<PackageGraphIndex["claims"][number], { entityKind: "surface" }>;
type CompleteDiscoveredSurface = DiscoveredSurfaceFact & {
  source: PackageGraphSource;
  sourceDigest: PackageGraphSourceDigest;
};

function unsupportedReason(fact: DiscoveredSurfaceFact): UnsupportedSurfaceReason | undefined {
  if (fact.source === undefined && fact.sourceDigest === undefined) {
    return "missing-source-and-digest";
  }
  if (fact.source === undefined) return "missing-source";
  if (fact.sourceDigest === undefined) return "missing-source-digest";
  return undefined;
}

function sameImmutableIdentity(fact: CompleteDiscoveredSurface, claim: SurfaceClaim): boolean {
  return (
    fact.source.provider === claim.entity.source.provider &&
    fact.source.repository === claim.entity.source.repository &&
    fact.sourceDigest.algorithm === claim.entity.sourceDigest.algorithm &&
    fact.sourceDigest.value === claim.entity.sourceDigest.value
  );
}

function authorityIds(claims: readonly SurfaceClaim[]): string[] {
  return claims.map(({ authorityId }) => authorityId).sort(codeUnitCompare);
}

function immutableSurface(
  fact: CompleteDiscoveredSurface,
  claims: readonly SurfaceClaim[],
): ClassifiedImmutableSurface {
  return {
    id: fact.id,
    kind: fact.kind,
    rootKind: fact.rootKind,
    source: { ...fact.source },
    sourceDigest: { ...fact.sourceDigest },
    authorityIds: authorityIds(claims),
  };
}

function undeclaredSurface(fact: CompleteDiscoveredSurface): UndeclaredImmutableSurface {
  return {
    id: fact.id,
    kind: fact.kind,
    rootKind: fact.rootKind,
    source: { ...fact.source },
    sourceDigest: { ...fact.sourceDigest },
  };
}

/**
 * Classify physical observations against graph membership without creating claims.
 * Only an immutable match from a lock or receipt authority counts as registered.
 */
export function classifyPackageGraphResidue(
  indexInput: unknown,
  discoveredInput: unknown,
): PackageGraphResidueClassification {
  const index = PackageGraphIndexSchema.parse(indexInput);
  const discovered = DiscoveredSurfaceFactsSchema.parse(discoveredInput).sort((left, right) =>
    codeUnitCompare(left.id, right.id),
  );
  const authorityKind = new Map(index.authorities.map(({ id, kind }) => [id, kind]));
  const claimsById = new Map<string, SurfaceClaim[]>();
  for (const claim of index.claims) {
    if (claim.entityKind !== "surface") continue;
    const claims = claimsById.get(claim.id) ?? [];
    claims.push(claim);
    claimsById.set(claim.id, claims);
  }

  const result: PackageGraphResidueClassification = {
    registered: [],
    catalogOnly: [],
    undeclared: [],
    divergent: [],
    unsupported: [],
  };

  for (const fact of discovered) {
    const reason = unsupportedReason(fact);
    if (reason !== undefined) {
      result.unsupported.push({
        id: fact.id,
        kind: fact.kind,
        rootKind: fact.rootKind,
        reason,
      });
      continue;
    }
    const complete = fact as CompleteDiscoveredSurface;
    const claims = claimsById.get(fact.id) ?? [];
    if (claims.some((claim) => !sameImmutableIdentity(complete, claim))) {
      result.divergent.push(immutableSurface(complete, claims));
      continue;
    }
    const governed = claims.filter((claim) => {
      const kind = authorityKind.get(claim.authorityId);
      return kind === "lock" || kind === "receipt";
    });
    const exactGoverned = governed.filter((claim) => sameImmutableIdentity(complete, claim));
    if (exactGoverned.length > 0) {
      result.registered.push(immutableSurface(complete, exactGoverned));
      continue;
    }
    const exactCatalog = claims.filter(
      (claim) =>
        authorityKind.get(claim.authorityId) === "catalog" &&
        sameImmutableIdentity(complete, claim),
    );
    if (exactCatalog.length > 0) {
      result.catalogOnly.push(immutableSurface(complete, exactCatalog));
      continue;
    }
    result.undeclared.push(undeclaredSurface(complete));
  }

  return result;
}
