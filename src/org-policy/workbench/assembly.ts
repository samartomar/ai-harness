import {
  authoringCatalogDigestV1 as digest,
  verifyAuthoringCatalogBundleIntegrityV1,
} from "./catalog-integrity.js";
import {
  type CatalogCompilerAssemblyInputV1,
  rejectTrustedCompilerEvidence,
} from "./compiler-input.js";
import {
  consumeFreshOrganizationPreparationV1,
  type FreshOrganizationPreparationV1,
} from "./core/organization-preparation.js";

export type { CatalogCompilerAssemblyInputV1 } from "./compiler-input.js";

import { canonicalStrictJsonSha256V1 } from "../../contract/strict-json-v1.js";
import {
  assemblyRegistryForCompiledDeclarationsV1,
  type CompiledDeclarationV1,
  compilerRegistrationForInputFormatV1,
} from "./compilers/registry.js";
import {
  type AuthoringAssetV1,
  type AuthoringCatalogBundleV1,
  assembleAuthoringAssetV1,
  type CoreAuthoringCapabilityRegistryEntryV1,
  parseAuthoringCatalogBundleV1,
} from "./contracts.js";

function bundleDigest(bundle: Omit<AuthoringCatalogBundleV1, "provenance">): string {
  return `sha256:${canonicalStrictJsonSha256V1({ ...bundle, provenance: {} })}`;
}
function mergeRecords<T>(label: string, records: readonly Record<string, T>[]): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const record of records) {
    for (const [id, value] of Object.entries(record)) {
      if (merged[id] !== undefined) throw new Error(`duplicate ${label} ${id}`);
      merged[id] = value;
    }
  }
  return merged;
}

function requireUniqueDeclarations(declarations: readonly CompiledDeclarationV1[]): void {
  const ids = new Set<string>();
  for (const { declaration } of declarations) {
    if (ids.has(declaration.id)) throw new Error(`duplicate compiled asset ${declaration.id}`);
    ids.add(declaration.id);
  }
}

function requireUniqueRelations(relations: AuthoringCatalogBundleV1["relations"]): void {
  const endpoints = new Set<string>();
  for (const relation of relations) {
    const endpoint = `${relation.fromAssetId}\u0000${relation.toAssetId}`;
    if (endpoints.has(endpoint)) {
      throw new Error(
        `ambiguous catalog relation ${relation.fromAssetId} -> ${relation.toAssetId}`,
      );
    }
    endpoints.add(endpoint);
  }
}

/**
 * Assembles any reviewed compiler outputs. This is the only point where source
 * declarations receive the closed Core action policy and can match exact Core
 * controls. It deliberately has no source- or UI-specific branch.
 */
export function assembleCompilerOutputsV1(
  ordinaryInputs: readonly CatalogCompilerAssemblyInputV1[],
  coreCapabilities: readonly CoreAuthoringCapabilityRegistryEntryV1[],
  preparations: readonly FreshOrganizationPreparationV1[] = [],
): AuthoringCatalogBundleV1 {
  rejectTrustedCompilerEvidence(ordinaryInputs);
  const corePreparedInputs = preparations.map((preparation) => {
    const input = consumeFreshOrganizationPreparationV1(preparation);
    if (input === undefined)
      throw new TypeError("fresh organization preparation custody is unavailable");
    return input;
  });
  const inputs = [...ordinaryInputs, ...corePreparedInputs];
  const declarations = inputs.flatMap((input) => input.declarations);
  requireUniqueDeclarations(declarations);
  const sources = mergeRecords(
    "source",
    inputs.map((input) => input.sources),
  );
  for (const { declaration, inputFormat } of declarations) {
    const source = sources[declaration.sourceId];
    if (source === undefined || source.revision.id !== declaration.sourceRevisionId) {
      throw new Error(`compiled declaration has no matching immutable source ${declaration.id}`);
    }
    if (
      source.inputFormat !== inputFormat ||
      source.compiler.id !== compilerRegistrationForInputFormatV1(inputFormat).id ||
      source.compiler.version !== compilerRegistrationForInputFormatV1(inputFormat).version
    ) {
      throw new Error(`compiled declaration has an unregistered source compiler ${declaration.id}`);
    }
  }
  const registry = assemblyRegistryForCompiledDeclarationsV1(declarations, coreCapabilities);
  const assets = Object.fromEntries(
    declarations.map(({ declaration }) => {
      const asset = assembleAuthoringAssetV1(declaration, registry);
      return [asset.id, asset];
    }),
  ) as Record<string, AuthoringAssetV1>;
  const detailBytes = mergeRecords(
    "detail chunk",
    inputs.map((input) => input.detailBytes),
  );
  const relations = inputs.flatMap((input) => input.relations ?? []);
  requireUniqueRelations(relations);
  const bareBundle = {
    version: "authoring-catalog-bundle/v1" as const,
    sources,
    assets,
    groups: mergeRecords(
      "group",
      inputs.map((input) => input.groups ?? {}),
    ),
    relations,
    templates: mergeRecords(
      "template",
      inputs.map((input) => input.templates ?? {}),
    ),
    evidence: mergeRecords(
      "evidence",
      inputs.map((input) => input.evidence ?? {}),
    ),
    detailChunks: Object.fromEntries(
      Object.entries(detailBytes).map(([id, bytes]) => [id, { bytes, digest: digest(bytes) }]),
    ),
  };
  const bundle = parseAuthoringCatalogBundleV1({
    ...bareBundle,
    provenance: { bundleDigest: bundleDigest(bareBundle) },
  });
  verifyAuthoringCatalogBundleIntegrityV1(bundle);
  return bundle;
}

/** Assemble non-Core compiler output with no authority to elevate a control. */
export function assembleAuthoringCatalogBundleFromCompilerOutputsV1(
  inputs: readonly CatalogCompilerAssemblyInputV1[],
): AuthoringCatalogBundleV1 {
  rejectTrustedCompilerEvidence(inputs);
  return assembleCompilerOutputsV1(inputs, []);
}
