import type { CompiledDeclarationV1 } from "./compilers/formats.js";
import type { AuthoringCatalogBundleV1 } from "./contracts.js";
/** A source-neutral compiler result accepted by the Core-only bundle assembler. */
export interface CatalogCompilerAssemblyInputV1 {
  sources: AuthoringCatalogBundleV1["sources"];
  declarations: readonly CompiledDeclarationV1[];
  relations?: AuthoringCatalogBundleV1["relations"];
  groups?: AuthoringCatalogBundleV1["groups"];
  templates?: AuthoringCatalogBundleV1["templates"];
  evidence?: AuthoringCatalogBundleV1["evidence"];
  detailBytes: Record<string, string>;
}

/** Generic compiler output cannot claim Scanner/Core custody or qualification. */
export function rejectTrustedCompilerEvidence(
  inputs: readonly CatalogCompilerAssemblyInputV1[],
): void {
  for (const input of inputs) {
    for (const evidence of Object.values(input.evidence ?? {})) {
      if (
        evidence.verification.state === "verified" ||
        evidence.qualification.state === "qualified"
      ) {
        throw new Error(
          `untrusted compiler evidence claims Core verification or qualification: ${evidence.id}`,
        );
      }
    }
  }
}
