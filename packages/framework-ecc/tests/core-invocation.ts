/**
 * The ambient invocation for this package's ECC module tests. The moved ECC
 * modules read descriptor data and reach Core's executors through the current
 * invocation; these tests call the modules directly, so the invocation holds
 * the descriptor built from Catalog's sections at the pinned commit and Core's
 * own functions, unbound. A module that reads a section Catalog has not yet
 * produced at that commit refuses with `sections.<name> is missing`. Core's bound
 * runtime (root check, pins, revocation) is tested in
 * tests/framework-plugin/ecc-command.test.ts.
 */
import { baselineCatalogById } from "../../../src/baseline-evidence/catalogs.js";
import { executeBaselineEvidencePipeline } from "../../../src/baseline-evidence/pipeline.js";
import { loadCatalogPackageV1 } from "../../../src/catalog-package/load-catalog-package.js";
import type { FrameworkCoreRuntimeV1 } from "../../../src/framework-plugin/contract-v1.js";
import { executePlan } from "../../../src/internals/execute.js";
import {
  assertPolicyBindingCurrent,
  policyBindingFileAssertion,
} from "../../../src/org-policy/binding.js";
import { assertOrgPolicyMutationSource } from "../../../src/org-policy/drift.js";
import { verifiedOrgPolicyTargets } from "../../../src/org-policy/project.js";
import { readOrgPolicy } from "../../../src/org-policy/schema.js";
import {
  historicalEccRuntimeDescriptorsFromSourceDataV1,
  workbenchSourceDataRootV1,
} from "../../../src/org-policy/workbench/core/source-data.js";
import { consumeWorkbenchPolicy } from "../../../src/org-policy/workbench/policy-consumption.js";
import { cleanupQuarantine, resolveTrustSource } from "../../../src/trust/fetch.js";
import { eccDescriptorFor, setEccTestInvocation } from "../src/invocation.js";
import { pinnedDescriptor } from "./context.js";

// Each member calls the imported binding at call time, so a test's vi.mock of
// a Core module still applies.
const runtime: FrameworkCoreRuntimeV1 = {
  get planContext(): never {
    throw new Error("ECC module tests pass their plan context explicitly");
  },
  executePlan: (...args) => executePlan(...args),
  executeBaselineEvidencePipeline: (...args) => executeBaselineEvidencePipeline(...args),
  resolveTrustSource: (...args) => resolveTrustSource(...args),
  cleanupQuarantine: (...args) => cleanupQuarantine(...args),
  verifiedOrgPolicyTargets: (...args) => verifiedOrgPolicyTargets(...args),
  assertPolicyBindingCurrent: (...args) => assertPolicyBindingCurrent(...args),
  policyBindingFileAssertion: (...args) => policyBindingFileAssertion(...args),
  assertOrgPolicyMutationSource: (...args) => assertOrgPolicyMutationSource(...args),
  readOrgPolicy: (...args) => readOrgPolicy(...args),
  baselineCatalogById: (...args) => baselineCatalogById(...args),
  loadCatalogPackageV1: (...args) => loadCatalogPackageV1(...args),
  historicalEccRuntimeDescriptorsFromSourceDataV1: (...args) =>
    historicalEccRuntimeDescriptorsFromSourceDataV1(...args),
  workbenchSourceDataRootV1: (...args) => workbenchSourceDataRootV1(...args),
  consumeWorkbenchPolicy: (...args) => consumeWorkbenchPolicy(...args),
};

setEccTestInvocation({
  descriptor: eccDescriptorFor(pinnedDescriptor()),
  runtime,
});
