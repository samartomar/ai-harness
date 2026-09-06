import type { BaselineCatalog } from "../../baseline-evidence/catalog.js";
import type { readVendorBaselineLock } from "../../baseline-evidence/vendor.js";
import {
  type PolicyAuthoringFramework,
  policyAuthoringAssetKind,
  policyAuthoringCurationKind,
  policyAuthoringPreferredSelectionSourcePath,
  policyAuthoringSelectionSourcePaths,
} from "../catalog-provider-types.js";

type SourceSnapshot = ReturnType<typeof readVendorBaselineLock>["sources"][number];
export interface PrepareSuperpowersCatalogSourceV1Input {
  baseline: BaselineCatalog;
  sourceSnapshot: SourceSnapshot;
}

/** Direct, source-local Superpowers preparation from already-normalized pinned input. */
export function prepareSuperpowersCatalogSourceV1(
  input: PrepareSuperpowersCatalogSourceV1Input,
): PolicyAuthoringFramework {
  const { baseline, sourceSnapshot } = input;
  if (
    baseline.id !== "superpowers" ||
    baseline.pinnedSha !== sourceSnapshot.pinnedSha ||
    sourceSnapshot.id !== baseline.id
  )
    throw new Error("Superpowers baseline input does not match its vetted source snapshot");
  const vetted = new Map(sourceSnapshot.components.map((component) => [component.id, component]));
  return {
    id: "superpowers",
    repository: `${baseline.owner}/${baseline.repo}`,
    commit: baseline.pinnedSha,
    assets: baseline.components.map((component) => {
      const vet = vetted.get(component.id);
      return {
        id: component.id,
        kind: policyAuthoringAssetKind(component.id),
        ...(policyAuthoringCurationKind(component.id) === undefined
          ? {}
          : { curationKind: policyAuthoringCurationKind(component.id) }),
        source: {
          repository: `${baseline.owner}/${baseline.repo}`,
          commit: baseline.pinnedSha,
          path: policyAuthoringPreferredSelectionSourcePath(component.id, component.paths) ?? "",
        },
        sourcePaths: policyAuthoringSelectionSourcePaths(component.id, component.paths),
        ...(vet === undefined
          ? {}
          : {
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
            }),
      };
    }),
  };
}
