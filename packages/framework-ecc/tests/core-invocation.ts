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
import type { FrameworkCoreRuntimeV1 } from "../../../src/framework-plugin/contract-v1.js";
import { executePlan } from "../../../src/internals/execute.js";
import { eccDescriptorFor, setEccTestInvocation } from "../src/invocation.js";
import { descriptorOf, fixtureDescriptorBytes } from "./context.js";

// Each member calls the imported binding at call time, so a test's vi.mock of
// a Core module still applies.
const runtime: FrameworkCoreRuntimeV1 = {
  get planContext(): never {
    throw new Error("ECC module tests pass their plan context explicitly");
  },
  executePlan: (...args) => executePlan(...args),
};

setEccTestInvocation({
  descriptor: eccDescriptorFor(descriptorOf(fixtureDescriptorBytes())),
  runtime,
});
