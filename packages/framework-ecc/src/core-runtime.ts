import type { FrameworkCoreRuntimeV1 } from "@aihq/core/framework-host";
import { currentCoreRuntime } from "./invocation.js";

/**
 * Core's runtime operations under the names the ECC modules call them by. Each
 * delegates to the runtime Core bound to the current invocation, so the ECC
 * modules keep calling `executePlan(plan, ctx)` while Core decides the pins,
 * the environment and the lifetime behind it.
 */
type Runtime = FrameworkCoreRuntimeV1;

export const executePlan: Runtime["executePlan"] = (...args) =>
  currentCoreRuntime().executePlan(...args);
export const executeBaselineEvidencePipeline: Runtime["executeBaselineEvidencePipeline"] = (
  ...args
) => currentCoreRuntime().executeBaselineEvidencePipeline(...args);
export const resolveTrustSource: Runtime["resolveTrustSource"] = (...args) =>
  currentCoreRuntime().resolveTrustSource(...args);
export const cleanupQuarantine: Runtime["cleanupQuarantine"] = (...args) =>
  currentCoreRuntime().cleanupQuarantine(...args);
export const verifiedOrgPolicyTargets: Runtime["verifiedOrgPolicyTargets"] = (...args) =>
  currentCoreRuntime().verifiedOrgPolicyTargets(...args);
export const assertPolicyBindingCurrent: Runtime["assertPolicyBindingCurrent"] = (...args) =>
  currentCoreRuntime().assertPolicyBindingCurrent(...args);
export const policyBindingFileAssertion: Runtime["policyBindingFileAssertion"] = (...args) =>
  currentCoreRuntime().policyBindingFileAssertion(...args);
export const assertOrgPolicyMutationSource: Runtime["assertOrgPolicyMutationSource"] = (...args) =>
  currentCoreRuntime().assertOrgPolicyMutationSource(...args);
export const readOrgPolicy: Runtime["readOrgPolicy"] = (...args) =>
  currentCoreRuntime().readOrgPolicy(...args);
export const baselineCatalogById: Runtime["baselineCatalogById"] = (...args) =>
  currentCoreRuntime().baselineCatalogById(...args);
export const loadCatalogPackageV1: Runtime["loadCatalogPackageV1"] = (...args) =>
  currentCoreRuntime().loadCatalogPackageV1(...args);
export const historicalEccRuntimeDescriptorsFromSourceDataV1: Runtime["historicalEccRuntimeDescriptorsFromSourceDataV1"] =
  (...args) => currentCoreRuntime().historicalEccRuntimeDescriptorsFromSourceDataV1(...args);
export const workbenchSourceDataRootV1: Runtime["workbenchSourceDataRootV1"] = (...args) =>
  currentCoreRuntime().workbenchSourceDataRootV1(...args);
export const consumeWorkbenchPolicy: Runtime["consumeWorkbenchPolicy"] = (...args) =>
  currentCoreRuntime().consumeWorkbenchPolicy(...args);
