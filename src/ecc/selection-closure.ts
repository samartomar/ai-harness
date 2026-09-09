import type { EccComponentId, EccMcpComponentId } from "./components.js";
import { eccModuleDependencyIds } from "./evidence.js";
import { eccComponentRequiredModuleRootIds } from "./materialize.js";

/**
 * Structural dependencies carried by a sealed historical ECC runtime descriptor.
 *
 * The descriptor resolver is the authority boundary. This is only the pure
 * closure view it passes to consumers after authenticating the descriptor and
 * its adapter compatibility; callers without it keep the active snapshot.
 */
export interface EccStructuralRelationView {
  readonly mandatoryRequirementsById: ReadonlyMap<string, readonly string[]>;
}

/**
 * Exact policy provenance paths. The active catalog keeps its narrow
 * adapter-owned aliases. A sealed historical descriptor supplies its own exact
 * paths and never inherits aliases from the current snapshot.
 */
export function eccSelectionSourcePaths(
  id: string,
  catalogPaths: readonly string[],
  historicalComponentPaths?: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (historicalComponentPaths !== undefined) {
    return [...(historicalComponentPaths.get(id) ?? [])];
  }
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
export function eccMandatoryRequirementIds(
  id: string,
  relations?: EccStructuralRelationView,
): string[] {
  if (relations !== undefined) return [...(relations.mandatoryRequirementsById.get(id) ?? [])];
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
