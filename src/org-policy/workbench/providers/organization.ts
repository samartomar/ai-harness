import type { CatalogCompilerAssemblyInputV1 } from "../compiler-input.js";
import { compilerRegistrationForInputFormatV1 } from "../compilers/formats.js";
import { compileOrganizationManifestV1 } from "../compilers/organization-manifest.js";
import { defineCatalogProviderV1 } from "./contracts.js";
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
        compiler: compilerRegistrationForInputFormatV1(result.source.inputFormat),
        policyInputRequired: true,
      },
    },
    declarations: result.declarations,
    relations: result.relations,
    detailBytes: result.detailBytes,
  };
}
export const organizationCatalogProviderV1 = defineCatalogProviderV1({
  providerId: "organization",
  providerVersion: "1",
  fixture: () =>
    JSON.stringify({
      version: "organization-authoring-manifest/v1",
      source: { id: "source:fixture", revisionId: "1", locator: "fixture" },
      assets: [{ id: "skill:fixture", kind: "skill", label: "Fixture", path: "skills/fixture.md" }],
    }),
  compile: (input: string) => [compileOrganizationManifestAssemblyInputV1(input)],
});
