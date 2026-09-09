import { prepareCollectionScannerCoverageV1 } from "../baseline-evidence/scanner-provider-catalogs.js";
import { prepareSourceDataBaselineCoverageV1 } from "../baseline-evidence/source-data-baseline-preparation.js";
import { canonicalStrictJsonSha256V1 } from "../contract/strict-json-v1.js";
import type { AuthoringCatalogBundleV1 } from "../org-policy/workbench/contracts.js";
import {
  type CompilerQualificationBindingV1,
  compilerQualificationBindingsFromRegisteredCoverageV1,
  qualificationMaterialCoverageFromRegisteredCoverageV1,
  registeredCoverageGovernanceSubjectsV1,
} from "../org-policy/workbench/core/catalog-qualification-v1.js";
import {
  type PackagedSourceDataRecordV1,
  PackagedSourceDataRecordV1Schema,
} from "../org-policy/workbench/core/packaged-source-data-record.js";
import { assertAcquiredGithubSourceRootV1 } from "./bounded-github-source-archive.js";
import { restoreSourceCompilerTemplateV1 } from "./workbench-source-data-material.js";

export interface PackagedSourceQualificationMaterialV1 {
  readonly sourceId: string;
  readonly sourceRoot: string;
  readonly record: PackagedSourceDataRecordV1;
}

function singleSourceId(record: PackagedSourceDataRecordV1): string {
  const ids = Object.keys(record.sourceBundle.sources);
  if (ids.length !== 1 || ids[0] === undefined) throw new TypeError("Packaged source identity");
  return ids[0];
}

/**
 * Rebuilds qualification sidecars from the original package-owned compiler
 * template and an acquired source archive. The packaged binding is never an
 * input to this path.
 */
export function derivePackagedSourceQualificationBindingsV1(
  bundle: AuthoringCatalogBundleV1,
  material: readonly PackagedSourceQualificationMaterialV1[],
): Readonly<Record<string, CompilerQualificationBindingV1>> {
  const bindings: Record<string, CompilerQualificationBindingV1> = {};
  const seenSources = new Set<string>();
  for (const supplied of material) {
    const record = PackagedSourceDataRecordV1Schema.parse(supplied.record);
    const sourceId = singleSourceId(record);
    if (sourceId !== supplied.sourceId || seenSources.has(sourceId))
      throw new TypeError("Packaged qualification source material");
    seenSources.add(sourceId);
    const packagedSource = record.sourceBundle.sources[sourceId];
    const bundleSource = bundle.sources[sourceId];
    if (
      !packagedSource ||
      !bundleSource ||
      canonicalStrictJsonSha256V1(packagedSource) !== canonicalStrictJsonSha256V1(bundleSource)
    )
      throw new TypeError("Packaged qualification source does not match the release bundle");
    if (
      bundleSource.upstreamOrigin.kind !== "git" ||
      bundleSource.revision.id !== record.source.commit ||
      bundleSource.upstreamOrigin.locator.replace(/^https:\/\/github\.com\//, "") !==
        record.source.repository ||
      !assertAcquiredGithubSourceRootV1(
        supplied.sourceRoot,
        record.source.repository,
        record.source.commit,
      )
    )
      throw new TypeError("Packaged qualification source archive custody");

    const compilerInput = restoreSourceCompilerTemplateV1(
      record.compilerTemplate,
      supplied.sourceRoot,
    ) as {
      readonly version?: unknown;
    };
    const prepared =
      compilerInput.version === "pinned-baseline/v1"
        ? prepareSourceDataBaselineCoverageV1(supplied.sourceRoot, compilerInput)
        : compilerInput.version === "pinned-skill-collection/v1" ||
            compilerInput.version === "pinned-component-collection/v1"
          ? prepareCollectionScannerCoverageV1(supplied.sourceRoot, compilerInput as never)
          : undefined;
    if (!prepared) throw new TypeError("Unsupported packaged qualification compiler input");
    const subjects = registeredCoverageGovernanceSubjectsV1(bundle, prepared.coverage);
    const derived =
      subjects === undefined
        ? undefined
        : compilerQualificationBindingsFromRegisteredCoverageV1(
            bundle,
            qualificationMaterialCoverageFromRegisteredCoverageV1(
              supplied.sourceRoot,
              prepared.coverage,
            ),
            subjects,
          );
    if (!derived) throw new TypeError("Packaged qualification binding derivation failed");
    for (const [assetId, binding] of Object.entries(derived)) {
      if (bindings[assetId] !== undefined)
        throw new TypeError("Packaged qualification source material overlaps an asset binding");
      bindings[assetId] = binding;
    }
  }
  return Object.freeze(bindings);
}
