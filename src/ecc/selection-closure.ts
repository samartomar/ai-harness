import type { EccComponentId, EccMcpComponentId } from "./components.js";
import { eccModuleDependencyIds } from "./evidence.js";
import { eccComponentRequiredModuleRootIds } from "./materialize.js";

/**
 * Structural module requirements for one catalog-validated ECC component.
 * Optional declaration riders and aggregate members are deliberately absent:
 * administrators may remove those suggestions in the Workbench.
 */
export function eccMandatoryRequirementIds(id: string): string[] {
  if (id.startsWith("runtime:")) return [];
  try {
    return [
      ...new Set(
        eccComponentRequiredModuleRootIds(id as EccComponentId | EccMcpComponentId).flatMap(
          (moduleId) => [moduleId, ...eccModuleDependencyIds(moduleId)],
        ),
      ),
    ]
      .map((moduleId) => `module:${moduleId}`)
      .filter((dependency) => dependency !== id);
  } catch {
    // The catalog/provenance gate owns unknown-component refusal. Keeping this
    // helper total lets lower-level evidence tests use synthetic component ids
    // without turning dependency inference into a second catalog validator.
    return [];
  }
}
