import type { EccComponentId, EccMcpComponentId } from "./components.js";
import { eccModuleDependencyIds } from "./evidence.js";
import { eccComponentRequiredModuleRootIds } from "./materialize.js";

/** Exact policy provenance paths, including narrow adapter-owned aliases. */
export function eccSelectionSourcePaths(id: string, catalogPaths: readonly string[]): string[] {
  const paths = new Set(catalogPaths);
  if (id === "baseline:rules") paths.add("rules");
  if (id.startsWith("skill:")) {
    const skillDirectory = `skills/${id.slice("skill:".length)}`;
    paths.add(skillDirectory);
    paths.add(`${skillDirectory}/SKILL.md`);
  }
  return [...paths];
}

/** Preferred exact provenance path emitted by the Workbench. */
export function eccPreferredSelectionSourcePath(
  id: string,
  catalogPaths: readonly string[],
): string | undefined {
  if (id === "baseline:rules") return "rules";
  if (id.startsWith("skill:")) {
    const directSkill = `skills/${id.slice("skill:".length)}`;
    if (catalogPaths.includes(directSkill)) return directSkill;
  }
  return catalogPaths[0];
}

/**
 * Structural module requirements for one caller-validated ECC component.
 * Optional declaration riders and aggregate members are deliberately absent:
 * administrators may remove those suggestions in the Workbench.
 * Trust-boundary callers must first prove the identifier belongs to the active
 * pinned catalog; this lower-level helper stays total for synthetic tests.
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
