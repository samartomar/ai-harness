import { AihError } from "../errors.js";
import type { BaselineCatalog } from "./catalog.js";
import type { BaselineEvidenceLock } from "./schema.js";

/**
 * Why an assembled lock does not carry the inventory of the catalog its source resolved to:
 * an unknown subject, a source at another identity, or a component that is missing, extra or
 * carries other paths.
 */
export type BaselineAssemblyInventoryRefusalReasonV1 =
  | "unknown-source"
  | "source-identity-mismatch"
  | "component-missing"
  | "component-extra"
  | "component-paths-differ";

/**
 * The assembled lock's inventory is not the resolved catalog's. Assembly emits a lock whose
 * component list is exactly what the preview was authorized against; a lock that carries an
 * omitted, extra or altered component is refused, with a stable machine reason, before
 * anything is written.
 */
export class BaselineAssemblyInventoryRefusalError extends AihError {
  readonly reason: BaselineAssemblyInventoryRefusalReasonV1;

  constructor(reason: BaselineAssemblyInventoryRefusalReasonV1, detail: string) {
    super(`baseline assembly inventory: ${detail}`, "AIH_BASELINE_ASSEMBLY_INVENTORY");
    this.reason = reason;
  }
}

function refuse(reason: BaselineAssemblyInventoryRefusalReasonV1, detail: string): never {
  throw new BaselineAssemblyInventoryRefusalError(reason, detail);
}

/**
 * Bind every assembled source to the catalog it resolved to: the source identity
 * (owner/repo/pin) and each component's id and paths must equal the catalog's, in the
 * catalog's order, exactly as the preview boundary binds the installer. `catalogFor` returns
 * the catalog the bridge resolved for one source id, or undefined when it has none.
 */
export function assertAssembledInventoryV1(
  lock: BaselineEvidenceLock,
  catalogFor: (sourceId: string) => BaselineCatalog | undefined,
): void {
  for (const source of lock.sources) {
    const catalog = catalogFor(source.id);
    if (catalog === undefined)
      refuse(
        "unknown-source",
        `assembled source ${source.id} has no resolved catalog to bind its inventory to`,
      );
    if (
      source.owner !== catalog.owner ||
      source.repo !== catalog.repo ||
      source.pinnedSha !== catalog.pinnedSha
    )
      refuse(
        "source-identity-mismatch",
        `assembled ${source.id} is ${source.owner}/${source.repo}@${source.pinnedSha}; its resolved catalog is ${catalog.owner}/${catalog.repo}@${catalog.pinnedSha}`,
      );
    const assembled = new Map(source.components.map((component) => [component.id, component]));
    for (const component of catalog.components) {
      const entry = assembled.get(component.id);
      if (entry === undefined)
        refuse(
          "component-missing",
          `assembled ${source.id} omits component ${component.id} of ${catalog.owner}/${catalog.repo}@${catalog.pinnedSha}`,
        );
      if (JSON.stringify(entry.paths) !== JSON.stringify(component.paths))
        refuse(
          "component-paths-differ",
          `assembled ${source.id} component ${component.id} paths are ${JSON.stringify(entry.paths)}; the resolved catalog's are ${JSON.stringify(component.paths)}`,
        );
      assembled.delete(component.id);
    }
    const extra = [...assembled.keys()].sort();
    if (extra.length > 0)
      refuse(
        "component-extra",
        `assembled ${source.id} carries component(s) its resolved catalog does not: ${extra.join(", ")}`,
      );
  }
}
