import { readVendorBaselineLock } from "../../baseline-evidence/vendor.js";
import {
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
} from "../../contract/strict-json-v1.js";
import { type PolicyAuthoringCatalog, policyAuthoringCatalog } from "../catalog.js";
import {
  assembleAuthoringCatalogBundleFromCompilerOutputsV1,
  assembleCompilerOutputsV1,
} from "./assembly.js";
import type { CatalogCompilerAssemblyInputV1 } from "./compiler-input.js";
import { compileBuiltInCatalogV1 } from "./compilers/built-in.js";
import type { AuthoringCatalogBundleV1 } from "./contracts.js";
import type { FreshOrganizationPreparationV1 } from "./core/organization-preparation.js";
import type { CatalogProviderCompilationV1 } from "./providers/contracts.js";
import { compileOrganizationManifestAssemblyInputV1 } from "./providers/organization.js";
import { registeredCatalogProvidersV1 } from "./providers/registry.js";

export { assembleAuthoringCatalogBundleFromCompilerOutputsV1 } from "./assembly.js";
export { verifyAuthoringCatalogBundleIntegrityV1 } from "./catalog-integrity.js";
export type { CatalogCompilerAssemblyInputV1 } from "./compiler-input.js";
export { compileOrganizationManifestAssemblyInputV1 } from "./providers/organization.js";

/** Compile one offline organization manifest through the same generic assembler. */
export function organizationManifestCatalogBundleV1(
  manifestBytes: string,
): AuthoringCatalogBundleV1 {
  return assembleAuthoringCatalogBundleFromCompilerOutputsV1([
    compileOrganizationManifestAssemblyInputV1(manifestBytes),
  ]);
}

interface CompiledPolicyCatalogInputsV1 {
  inputs: CatalogCompilerAssemblyInputV1[];
  providers: CatalogProviderCompilationV1[];
  coreCapabilities: ReturnType<typeof compileBuiltInCatalogV1>["coreCapabilities"];
}

const MAX_BASELINE_INPUT_CACHE_ENTRIES = 4;
const compiledBaselineInputsByDigest = new Map<string, Readonly<CompiledPolicyCatalogInputsV1>>();

function cacheCompiledBaselineInputsV1(
  digest: string,
  value: CompiledPolicyCatalogInputsV1,
): CompiledPolicyCatalogInputsV1 {
  const snapshot = deepFreezeStrictJsonV1(structuredClone(value));
  compiledBaselineInputsByDigest.delete(digest);
  compiledBaselineInputsByDigest.set(digest, snapshot);
  if (compiledBaselineInputsByDigest.size > MAX_BASELINE_INPUT_CACHE_ENTRIES) {
    const oldest = compiledBaselineInputsByDigest.keys().next().value;
    if (oldest !== undefined) compiledBaselineInputsByDigest.delete(oldest);
  }
  return structuredClone(snapshot);
}

/**
 * Compiling the pinned baseline is pure but comparatively expensive. Cache a
 * sealed snapshot keyed by the canonical catalog bytes, then hand every
 * assembler a detached clone. Recomputing the key makes mutations to a caller
 * supplied catalog a cache miss, while the private snapshot cannot be mutated
 * through a returned bundle.
 */
function compiledPolicyCatalogInputsV1(
  catalog: PolicyAuthoringCatalog,
): CompiledPolicyCatalogInputsV1 {
  const cacheKey = canonicalStrictJsonSha256V1(catalog);
  const cached = compiledBaselineInputsByDigest.get(cacheKey);
  if (cached !== undefined) {
    compiledBaselineInputsByDigest.delete(cacheKey);
    compiledBaselineInputsByDigest.set(cacheKey, cached);
    return structuredClone(cached);
  }
  const sources = readVendorBaselineLock().sources;
  const builtIn = compileBuiltInCatalogV1(catalog);
  const providers = registeredCatalogProvidersV1.flatMap((provider) => {
    const compiled = provider.prepareBaseline?.(catalog, sources);
    return compiled === undefined ? [] : [compiled];
  });
  return cacheCompiledBaselineInputsV1(cacheKey, {
    providers,
    inputs: providers.flatMap((provider) => provider.inputs),
    coreCapabilities: builtIn.coreCapabilities,
  });
}

/** Prepare baseline and real organization manifests without a UI source branch. */
export function policyAuthoringCatalogBundleWithOrganizationManifestsV1(
  organizationManifestBytes: readonly string[],
  catalog: PolicyAuthoringCatalog = policyAuthoringCatalog(),
): AuthoringCatalogBundleV1 {
  const baseline = compiledPolicyCatalogInputsV1(catalog);
  return assembleCompilerOutputsV1(
    [
      ...baseline.inputs,
      ...organizationManifestBytes.map(compileOrganizationManifestAssemblyInputV1),
    ],
    baseline.coreCapabilities,
  );
}

/**
 * Core-only bridge for mixed offline and witnessed organization sources. Fresh
 * preparations are re-read through process-local custody before generic assembly.
 */
export function policyAuthoringCatalogBundleWithOrganizationInputsV1(
  organizationManifestBytes: readonly string[],
  preparations: readonly FreshOrganizationPreparationV1[],
  catalog: PolicyAuthoringCatalog = policyAuthoringCatalog(),
): AuthoringCatalogBundleV1 {
  const baseline = compiledPolicyCatalogInputsV1(catalog);
  return assembleCompilerOutputsV1(
    [
      ...baseline.inputs,
      ...organizationManifestBytes.map(compileOrganizationManifestAssemblyInputV1),
    ],
    baseline.coreCapabilities,
    preparations,
  );
}

/** Core-only bridge for fresh operational organization preparations. */
export function policyAuthoringCatalogBundleWithFreshOrganizationPreparationsV1(
  preparations: readonly FreshOrganizationPreparationV1[],
  catalog: PolicyAuthoringCatalog = policyAuthoringCatalog(),
): AuthoringCatalogBundleV1 {
  return policyAuthoringCatalogBundleWithOrganizationInputsV1([], preparations, catalog);
}

/** Core assembles the compact, source-neutral browser bundle from registered compilers. */
export function policyAuthoringCatalogBundle(
  catalog: PolicyAuthoringCatalog = policyAuthoringCatalog(),
): AuthoringCatalogBundleV1 {
  return policyAuthoringCatalogBundleWithOrganizationManifestsV1([], catalog);
}
