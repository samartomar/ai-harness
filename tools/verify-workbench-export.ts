import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveEffectiveOrgPolicy } from "../src/org-policy/effective.js";
import { parseOrgPolicy } from "../src/org-policy/schema.js";
import { consumeWorkbenchPolicy } from "../src/org-policy/workbench/policy-consumption.js";
import { createWorkbenchState } from "../src/org-policy/workbench/selection-engine.js";

const pairs = process.argv.slice(2);
if (!pairs.length || pairs.length % 2 !== 0) throw new Error("Export path and expected asset pairs are required");
for (let index = 0; index < pairs.length; index += 2) {
const path = pairs[index]!;
const assetId = pairs[index + 1]!;
const policy = parseOrgPolicy(JSON.parse(readFileSync(path, "utf8")));
const consumed = consumeWorkbenchPolicy(policy, createWorkbenchState());
assert.equal(consumed.accepted, true, consumed.diagnostics.join("; "));
assert.deepEqual(consumed.requestedIntent, [assetId]);
const effective = resolveEffectiveOrgPolicy(policy);
assert.deepEqual(effective.candidates, []);
assert.deepEqual(effective.activeMcpServerIds, []);
assert.deepEqual(policy.governance?.authority.approvals, []);
assert.deepEqual(policy.governance?.activations, []);
assert.equal(policy.schemaVersion, 3);
if (policy.schemaVersion !== 3) throw new Error("Expected V3 policy");
const selected = policy.authoringSelections?.roots[0];
if (!selected) throw new Error("Missing exported exact-source selection");
selected.contentDigest = `sha256:${"0".repeat(64)}`;
assert.equal(consumeWorkbenchPolicy(policy, createWorkbenchState()).accepted, false);
}
console.log("WORKBENCH_EXPORT_CONSUMPTION_VERIFIED");
