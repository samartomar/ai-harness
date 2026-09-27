import type { CatalogCompilerAssemblyInputV1 } from "../compiler-input.js";
import { compileOrganizationManifestV1 } from "../compilers/organization-manifest.js";

/** Compile organization-authored policy input; no Catalog-owned source enters here. */
export function compileOrganizationManifestAssemblyInputV1(
  manifestBytes: string,
): CatalogCompilerAssemblyInputV1 {
  const result = compileOrganizationManifestV1(manifestBytes);
  return {
    sources: {
      [result.source.id]: {
        id: result.source.id,
        distributor: { kind: "organization", locator: result.source.locator },
        upstreamOrigin: { kind: "organization", locator: result.source.locator },
        inputFormat: result.source.inputFormat,
        revision: { id: result.source.revisionId, contentDigest: result.source.contentDigest },
        compiler: { id: "organization-manifest", version: "1" },
        policyInputRequired: true,
      },
    },
    declarations: result.declarations,
    relations: result.relations,
    detailBytes: result.detailBytes,
  };
}
