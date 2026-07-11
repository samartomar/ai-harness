import { z } from "zod";
import eccModulesJson from "../baseline-evidence/ecc-modules.json";
import eccProfilesJson from "../baseline-evidence/ecc-profiles.json";
import type { BaselineAuthorization } from "../baseline-evidence/verify.js";
import type { Cli } from "../internals/clis.js";
import type { EccComponentId, EccComponentSelection } from "./components.js";
import { eccComponentInstallDescriptor } from "./materialize.js";
import type { InstalledComponentRegistration } from "./registration.js";
import type { EccLanguagePack } from "./select.js";

const ModulesSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    modules: z.array(
      z
        .object({
          id: z.string().min(1),
          paths: z.array(z.string().min(1)).min(1),
          targets: z.array(z.string().min(1)).min(1),
          dependencies: z.array(z.string().min(1)),
        })
        .strict(),
    ),
  })
  .strict();

const ProfilesSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    profiles: z.record(
      z.string(),
      z
        .object({
          description: z.string(),
          modules: z.array(z.string().min(1)),
        })
        .strict(),
    ),
  })
  .strict();

const modules = ModulesSnapshotSchema.parse(eccModulesJson).modules;
const profiles = ProfilesSnapshotSchema.parse(eccProfilesJson).profiles;
const moduleById = new Map(modules.map((module) => [module.id, module]));

const PACK_MODULES: Record<EccLanguagePack, readonly string[]> = {
  typescript: ["framework-language"],
  python: ["framework-language"],
  golang: ["framework-language"],
  swift: ["swift-apple"],
  php: ["framework-language"],
  ruby: ["framework-language", "security"],
  web: ["framework-language"],
  angular: ["framework-language"],
  vue: ["framework-language"],
  nuxt: ["framework-language"],
  arkts: ["framework-language"],
};

function addWithDependencies(selected: Set<string>, id: string): void {
  if (selected.has(id)) return;
  const module = moduleById.get(id);
  if (module === undefined) throw new Error(`pinned ECC module snapshot is missing ${id}`);
  for (const dependency of module.dependencies) addWithDependencies(selected, dependency);
  selected.add(id);
}

export function eccEvidenceComponentIds(
  profileId: string,
  target: Cli,
  packs: readonly EccLanguagePack[],
): string[] {
  const profile = profiles[profileId];
  if (profile === undefined)
    throw new Error(`unknown ECC profile in pinned snapshot: ${profileId}`);
  const selected = new Set<string>();
  for (const id of profile.modules) addWithDependencies(selected, id);
  for (const pack of packs) {
    for (const id of PACK_MODULES[pack]) addWithDependencies(selected, id);
  }
  return [
    "runtime:ecc-installer",
    ...modules
      .filter((module) => selected.has(module.id) && module.targets.includes(target))
      .map((module) => `module:${module.id}`),
  ];
}

function moduleSupportsTarget(moduleId: string, target: Cli): boolean {
  const module = moduleById.get(moduleId);
  if (module === undefined) throw new Error(`pinned ECC module snapshot is missing ${moduleId}`);
  return module.targets.includes(target);
}

function scopedComponentIds(selection: EccComponentSelection): EccComponentId[] {
  return [...selection.components, ...selection.mcps];
}

export function authorizedEccSelection(
  selection: EccComponentSelection,
  authorizations: readonly BaselineAuthorization[],
  targets: readonly Cli[] = [],
): EccComponentSelection {
  const authorizedIds = new Set(authorizations.map((authorization) => authorization.componentId));
  if (
    selection.scope === "full" &&
    targets.length > 0 &&
    targets.every((target) =>
      eccEvidenceComponentIdsForSelection(target, selection).every((componentId) =>
        authorizedIds.has(componentId),
      ),
    )
  ) {
    return {
      scope: "full",
      components: [...selection.components],
      mcps: [...selection.mcps],
      recommendations: [...selection.recommendations],
    };
  }
  const authorized = (componentId: EccComponentId | EccComponentSelection["mcps"][number]) =>
    authorizedIds.has(eccComponentInstallDescriptor(componentId).evidenceComponentId);
  return {
    scope: "scoped",
    components: selection.components.filter(authorized),
    mcps: selection.mcps.filter(authorized),
    recommendations: [...selection.recommendations],
  };
}

export function eccEvidenceComponentIdsForSelection(
  target: Cli,
  selection: EccComponentSelection,
): string[] {
  if (selection.scope === "full") return eccEvidenceComponentIds("full", target, []);
  const selected = new Set<string>(["runtime:ecc-installer"]);
  for (const componentId of scopedComponentIds(selection)) {
    const descriptor = eccComponentInstallDescriptor(componentId);
    if (!moduleSupportsTarget(descriptor.containingModuleId, target)) continue;
    selected.add(descriptor.evidenceComponentId);
  }
  return [...selected];
}

export function installedEccComponentRegistrations(
  target: Cli,
  selection: EccComponentSelection,
  authorizations: readonly BaselineAuthorization[],
): InstalledComponentRegistration[] {
  const authorizationById = new Map(
    authorizations.map((authorization) => [authorization.componentId, authorization]),
  );
  const installed: InstalledComponentRegistration[] = [];
  for (const componentId of scopedComponentIds(selection)) {
    const descriptor = eccComponentInstallDescriptor(componentId);
    if (!moduleSupportsTarget(descriptor.containingModuleId, target)) continue;
    const exact = authorizationById.get(componentId);
    const containing = authorizationById.get(`module:${descriptor.containingModuleId}`);
    const authorization = exact ?? containing;
    if (authorization === undefined) {
      throw new Error(`missing ECC evidence authorization for ${componentId}`);
    }
    installed.push({ id: componentId, authorization });
  }
  return installed;
}
