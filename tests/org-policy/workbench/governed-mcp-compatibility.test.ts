import { beforeAll, describe, expect, it } from "vitest";
import { policyAuthoringCatalog } from "../../../src/org-policy/catalog.js";
import { parseOrgPolicy } from "../../../src/org-policy/schema.js";
import { compilePolicy } from "../../../src/org-policy/workbench/policy-compiler.js";
import { consumeWorkbenchPolicy } from "../../../src/org-policy/workbench/policy-consumption.js";
import { importWorkbenchPolicySelections } from "../../../src/org-policy/workbench/policy-import.js";
import {
  type PreparedWorkbenchCatalogV1,
  prepareWorkbenchCatalog,
} from "../../../src/org-policy/workbench/prepared-catalog.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../../src/org-policy/workbench/selection-engine.js";

let current: PreparedWorkbenchCatalogV1;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected test fixture value");
  return value;
}

beforeAll(() => {
  current = prepareWorkbenchCatalog(policyAuthoringCatalog());
});

function authored(targets = ["claude"]) {
  const state = reduceWorkbenchAction(current.bundle, createWorkbenchState(), {
    type: "select-root",
    assetId: "aih/sequential-thinking",
    origin: { kind: "administrator" },
  }).state;
  const result = compilePolicy(
    {
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      mcp: { allowManagedOnly: true },
      governance: { supportedClis: targets },
    },
    state,
    current.bundle,
    current.bindings,
  );
  expect(result.accepted, result.diagnostics.join("; ")).toBe(true);
  return { state, policy: result.policy };
}

describe("saved Workbench MCP target compatibility", () => {
  it("refuses a stale historical MCP declaration until the policy is re-saved", () => {
    const saved = authored();
    const policy = parseOrgPolicy(saved.policy);
    if (policy.schemaVersion !== 3) throw new Error("expected saved Workbench policy");
    const root = required(policy.authoringSelections.roots[0]);
    root.contentDigest = `sha256:${"f".repeat(64)}`;
    for (const pin of root.resolvedItems) {
      if (pin.assetId === root.assetId) pin.contentDigest = root.contentDigest;
    }
    const before = structuredClone(policy);
    const consumed = consumeWorkbenchPolicy(policy, saved.state, current);
    expect(consumed.accepted).toBe(false);
    expect(consumed.diagnostics).toContain("Stale selected content: aih/sequential-thinking");
    expect(consumed.policy).toBeUndefined();
    expect(policy).toEqual(before);
  });

  it("authors and reopens a fresh expanded declaration for Codex", () => {
    const saved = authored(["codex"]);
    const consumed = consumeWorkbenchPolicy(saved.policy, saved.state, current);
    expect(consumed.accepted, consumed.diagnostics.join("; ")).toBe(true);
    expect(consumed.policy?.governance?.activations[0]?.targets).toEqual(["codex"]);
    expect(consumed.policy?.governance?.catalog.reviewed[0]?.targets).toContain("codex");
    const input = parseOrgPolicy(saved.policy);
    const imported = importWorkbenchPolicySelections(
      input,
      current.bundle,
      current.bindings,
      current.sourceInputs,
    );
    expect(imported.diagnostics).toEqual([]);
    expect(current.bindings["aih/sequential-thinking"]?.candidate?.targets).toContain("codex");
  });
});
