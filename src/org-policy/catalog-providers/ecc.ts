import type { BaselineCatalog } from "../../baseline-evidence/catalog.js";
import type { readVendorBaselineLock } from "../../baseline-evidence/vendor.js";
import {
  CORE_ECC_COMPONENTS,
  ECC_DECLARATION_RIDERS,
  type EccComponentId,
  type EccMcpComponentId,
} from "../../ecc/components.js";
import { eccModuleDependencyIds, eccProfileModuleIds } from "../../ecc/evidence.js";
import {
  eccComponentInstallDescriptor,
  eccComponentRequiredModuleRootIds,
  eccModuleSelectableMemberIds,
} from "../../ecc/materialize.js";
import {
  eccPreferredSelectionSourcePath,
  eccSelectionSourcePaths,
} from "../../ecc/selection-closure.js";
import {
  type PolicyAuthoringComposition,
  type PolicyAuthoringFramework,
  policyAuthoringAssetKind,
  policyAuthoringCurationKind,
} from "../catalog-provider-types.js";
import { eccContentMetadata } from "../ecc-content-metadata.js";
import {
  ECC_SKILL_CATALOG_PROVENANCE,
  type EccSkillCatalogEntry,
  eccSkillCatalogInventory,
} from "../ecc-skill-catalog.js";

type SourceSnapshot = ReturnType<typeof readVendorBaselineLock>["sources"][number];

export interface PrepareEccCatalogSourceV1Input {
  baseline: BaselineCatalog;
  sourceSnapshot: SourceSnapshot;
}

/** Direct, source-local ECC preparation from already-normalized pinned input. */
export function prepareEccCatalogSourceV1(
  input: PrepareEccCatalogSourceV1Input,
): PolicyAuthoringFramework {
  const { baseline, sourceSnapshot } = input;
  if (
    baseline.id !== "ecc" ||
    baseline.owner !== sourceSnapshot.owner ||
    baseline.repo !== sourceSnapshot.repo ||
    baseline.pinnedSha !== sourceSnapshot.pinnedSha ||
    sourceSnapshot.id !== baseline.id
  )
    throw new Error("ECC baseline input does not match its vetted source snapshot");
  const present = new Set(baseline.components.map((component) => component.id));
  const vetted = new Map(sourceSnapshot.components.map((component) => [component.id, component]));
  const assets = baseline.components.map((component) => {
    const id = component.id;
    const kind = policyAuthoringAssetKind(id);
    const path = eccPreferredSelectionSourcePath(id, component.paths);
    if (!path) throw new Error(`baseline component ${id} declares no path`);
    const rider: string[] = [...(ECC_DECLARATION_RIDERS[id] ?? [])];
    if (/^(?:lang|framework|capability):/.test(id)) {
      const descriptor = eccComponentInstallDescriptor(id as EccComponentId);
      rider.push(...(descriptor.skills ?? []).map((name) => `skill:${name}`));
      for (const moduleId of descriptor.wholeModules ?? [])
        for (const member of eccModuleSelectableMemberIds(moduleId, [...present]))
          if (member.startsWith("skill:")) rider.push(member);
    }
    const riders = [...new Set(rider)].filter((value) => present.has(value));
    const dependencies = id.startsWith("runtime:")
      ? []
      : [
          ...new Set(
            eccComponentRequiredModuleRootIds(id as EccComponentId | EccMcpComponentId)
              .flatMap((moduleId) => [moduleId, ...eccModuleDependencyIds(moduleId)])
              .map((moduleId) => `module:${moduleId}`)
              .filter((value) => value !== id),
          ),
        ];
    for (const value of dependencies)
      if (!present.has(value))
        throw new Error(
          `baseline component ${id} requires ${value}, which the pinned catalog does not contain`,
        );
    const members = id.startsWith("module:")
      ? eccModuleSelectableMemberIds(id.slice("module:".length), [...present])
      : [];
    const metadata =
      kind === "agent" || kind === "skill"
        ? eccContentMetadata(kind, id.slice(id.indexOf(":") + 1))
        : undefined;
    if ((kind === "agent" || kind === "skill") && !metadata)
      throw new Error(`ECC ${kind} ${id} has no source-authored metadata`);
    const vet = vetted.get(id);
    return {
      id,
      kind,
      ...(policyAuthoringCurationKind(id) === undefined
        ? {}
        : { curationKind: policyAuthoringCurationKind(id) }),
      ...(riders.length ? { riders } : {}),
      ...(dependencies.length ? { dependencies } : {}),
      ...(members.length ? { members } : {}),
      ...(vet
        ? {
            vet: {
              verdict: vet.verdict,
              treeSha256: vet.treeSha256,
              analyzers: vet.analyzers.map((entry) => ({
                name: entry.name,
                version: entry.version,
              })),
              findings: vet.findings.map((entry) => ({
                code: entry.code,
                ...(typeof entry.count === "number" ? { count: entry.count } : {}),
                detail: entry.detail,
              })),
            },
          }
        : {}),
      ...(metadata
        ? {
            metadata: {
              title: metadata.title,
              summary: metadata.summary,
              usageContext: metadata.usageContext,
              allowedTools: metadata.allowedTools,
              sourcePath: metadata.path,
              sourceSha256: metadata.sourceSha256,
            },
          }
        : {}),
      source: {
        repository: `${baseline.owner}/${baseline.repo}`,
        commit: baseline.pinnedSha,
        path,
      },
      sourcePaths: eccSelectionSourcePaths(id, component.paths),
    };
  });
  const framework = {
    id: "ecc" as const,
    repository: `${baseline.owner}/${baseline.repo}`,
    commit: baseline.pinnedSha,
    assets,
  };
  validateEccSkillCatalogV1(framework, eccSkillCatalogInventory);
  return framework;
}

export function eccEnterpriseCompositionV1(
  ecc: PolicyAuthoringFramework,
): PolicyAuthoringComposition {
  const core = eccProfileModuleIds("core").map((id) => `module:${id}`);
  const inCore = new Set(core);
  const parts = [
    {
      id: "ecc-install-core",
      label: "ECC install profile: core",
      rule: 'ecc-profiles.json profile "core", dependency-closed by eccProfileModuleIds()',
      selection: "composed" as const,
      componentIds: core,
    },
    {
      id: "aih-core-closure",
      label: "AIH's named ECC Core closure",
      rule: "CORE_ECC_COMPONENTS — AIH's own curation, not a set ECC declares",
      selection: "additive" as const,
      componentIds: [...CORE_ECC_COMPONENTS],
    },
    {
      id: "language",
      label: "Language composition, additive on top of Core",
      rule: "every ECC component in the lang: namespace",
      selection: "additive" as const,
      componentIds: ecc.assets.filter((asset) => asset.kind === "lang").map((asset) => asset.id),
    },
    {
      id: "security",
      label: "Security composition",
      rule: 'capability:security is what selectEccComponents() recommends at enterprise posture; module:security is what ECC\'s "security" profile adds over "core"',
      selection: "additive" as const,
      componentIds: [
        "capability:security",
        ...eccProfileModuleIds("security")
          .map((id) => `module:${id}`)
          .filter((id) => !inCore.has(id)),
      ],
    },
  ];
  const owned = new Set(ecc.assets.map((asset) => asset.id));
  for (const part of parts)
    for (const id of part.componentIds)
      if (!owned.has(id))
        throw new Error(
          `enterprise composition part ${part.id} names ${id}, which the pinned ECC catalog does not contain`,
        );
  return { framework: "ecc", parts };
}

function validateEccSkillCatalogV1(
  ecc: PolicyAuthoringFramework,
  skills: readonly EccSkillCatalogEntry[],
): void {
  if (
    ECC_SKILL_CATALOG_PROVENANCE.repository !== ecc.repository ||
    ECC_SKILL_CATALOG_PROVENANCE.commit !== ecc.commit
  )
    throw new Error(
      "source-locked ECC skill inventory provenance does not match the policy catalog",
    );
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  for (const skill of skills)
    if (!skill.governable || !ecc.assets.some((asset) => asset.id === `skill:${skill.id}`))
      throw new Error(`ECC skill ${skill.id} is absent from the selectable policy catalog`);
  for (const asset of ecc.assets.filter((asset) => asset.kind === "skill")) {
    const name = asset.id.slice("skill:".length);
    if (!byId.get(name)?.governable)
      throw new Error(
        `policy skill ${asset.id} is absent or unavailable in the source-locked ECC inventory`,
      );
  }
}
