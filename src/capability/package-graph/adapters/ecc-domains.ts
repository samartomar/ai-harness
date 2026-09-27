import {
  ECC_MCP_CATALOG_PROVENANCE,
  eccExternalMcpCatalogV1,
} from "../../../org-policy/ecc-mcp-catalog.js";
import {
  type PackageGraphAuthorityDocument,
  PackageGraphAuthorityDocumentSchema,
} from "../build.js";
import { codeUnitCompare } from "../canonical.js";
import type { PackageGraphPackage, PackageGraphSurface } from "../schema.js";

export interface EccCapabilityPackageAuthorityInput {
  authorityId: string;
  baseline: PackageGraphAuthorityDocument;
}

function packageIdFor(surfaceId: string): string | undefined {
  if (surfaceId.startsWith("agent:")) {
    return `package:ecc-agent/${surfaceId.slice("agent:".length)}`;
  }
  return undefined;
}

function packageFor(
  surface: PackageGraphSurface,
  id: string,
  sourcePackage?: PackageGraphPackage,
): PackageGraphPackage {
  return {
    id,
    source: { ...(sourcePackage?.source ?? surface.source) },
    sourceDigest: { ...(sourcePackage?.sourceDigest ?? surface.sourceDigest) },
    members: [surface.id],
    declaredRisk: [],
    observedRisk: [],
  };
}

export interface EccMcpCapabilityPackageAuthorityInput {
  authorityId: string;
}

/** Project the existing pinned HTTPS-configurable ECC MCP catalog into packages. */
export function projectEccMcpCapabilityPackageAuthority(
  input: EccMcpCapabilityPackageAuthorityInput,
): PackageGraphAuthorityDocument {
  const source = {
    provider: "github",
    repository: ECC_MCP_CATALOG_PROVENANCE.repository,
  } as const;
  const sourceDigest = {
    algorithm: "sha256" as const,
    value: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
  };
  const surfaces = eccExternalMcpCatalogV1()
    .filter(({ addability }) => addability === "https-configurable")
    .map(
      ({ id }): PackageGraphSurface => ({
        id: `mcp:${id}`,
        source: { ...source },
        sourceDigest: { ...sourceDigest },
        declaredRisk: [],
        observedRisk: [],
      }),
    )
    .sort((left, right) => codeUnitCompare(left.id, right.id));
  const packages = surfaces.map((surface) =>
    packageFor(surface, `package:ecc-mcp/${surface.id.slice("mcp:".length)}`),
  );
  return PackageGraphAuthorityDocumentSchema.parse({
    authority: {
      id: input.authorityId,
      kind: "catalog",
      sourceDigest: {
        algorithm: "sha256",
        value: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
      },
    },
    graph: { schemaVersion: 1, surfaces, packages },
  });
}

/**
 * Derive package-shaped policy roots from the exact ECC baseline lock projection.
 * This is a deterministic view of the lock; it is not a catalog, approval, or
 * receipt authority and does not assert that any component is materialized.
 */
export function projectEccCapabilityPackageAuthority(
  input: EccCapabilityPackageAuthorityInput,
): PackageGraphAuthorityDocument {
  const baseline = PackageGraphAuthorityDocumentSchema.parse(input.baseline);
  if (baseline.authority.kind !== "lock") {
    throw new Error("ECC capability package projection requires a baseline lock authority");
  }
  const baselinePackage = baseline.graph.packages.find(({ id }) => id === "package:baseline/ecc");
  if (baselinePackage === undefined) {
    throw new Error("ECC capability package projection requires the ECC baseline package");
  }

  const surfaces: PackageGraphSurface[] = [];
  const packages: PackageGraphPackage[] = [];
  for (const sourceSurface of baseline.graph.surfaces) {
    const directPackageId = packageIdFor(sourceSurface.id);
    if (directPackageId !== undefined) {
      const surface = structuredClone(sourceSurface);
      surfaces.push(surface);
      packages.push(packageFor(surface, directPackageId, baselinePackage));
      continue;
    }
    if (sourceSurface.id !== "baseline:rules") continue;
    const surface: PackageGraphSurface = {
      ...structuredClone(sourceSurface),
      id: "rule:ecc/rules",
    };
    surfaces.push(surface);
    packages.push(packageFor(surface, "package:ecc-rule/rules", baselinePackage));
  }

  surfaces.sort((left, right) => codeUnitCompare(left.id, right.id));
  packages.sort((left, right) => codeUnitCompare(left.id, right.id));
  return PackageGraphAuthorityDocumentSchema.parse({
    authority: {
      id: input.authorityId,
      kind: "lock",
      sourceDigest: { ...baseline.authority.sourceDigest },
    },
    graph: { schemaVersion: 1, surfaces, packages },
  });
}
