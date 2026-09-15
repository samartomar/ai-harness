import { beforeAll, describe, expect, it } from "vitest";
import type { GovernedMcpTarget } from "../../../src/internals/cli-registry.js";
import { policyAuthoringCatalog } from "../../../src/org-policy/catalog.js";
import {
  approvalAttestationDigest,
  candidateIdentityDigest,
  resolveEffectiveOrgPolicy,
  reviewedControlDigest,
} from "../../../src/org-policy/effective.js";
import { parseOrgPolicy } from "../../../src/org-policy/schema.js";
import { policyStudioModel } from "../../../src/org-policy/studio-model.js";
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
let legacy: PreparedWorkbenchCatalogV1;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected test fixture value");
  return value;
}
beforeAll(() => {
  const catalog = policyAuthoringCatalog();
  current = prepareWorkbenchCatalog(catalog);
  const previous = structuredClone(catalog);
  for (const item of previous.mcp) item.control.targets = ["claude", "kiro"];
  legacy = prepareWorkbenchCatalog(previous);
});

function authored(prepared: PreparedWorkbenchCatalogV1, targets = ["claude"]) {
  const state = reduceWorkbenchAction(prepared.bundle, createWorkbenchState(), {
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
    prepared.bundle,
    prepared.bindings,
  );
  expect(result.accepted, result.diagnostics.join("; ")).toBe(true);
  return { state, policy: result.policy };
}

describe("saved Workbench MCP target compatibility", () => {
  it("reopens and edits an old policy with all seven permitted hosts without stale-pin repair or broader approval", () => {
    const targets = ["claude", "codex", "cursor", "copilot", "opencode", "kimi", "kiro"];
    const saved = authored(legacy, targets);
    const input = parseOrgPolicy(saved.policy);
    if (input.schemaVersion !== 3) throw new Error("expected saved Workbench policy");
    const governance = required(input.governance);
    const candidate = required(governance.catalog.reviewed[0]);
    const approval = {
      id: "security-approval",
      candidate: candidate.id,
      kind: candidate.kind,
      source: candidate.source,
      issuer: "platform-security",
      sourceDigest: candidateIdentityDigest(candidate),
      evidenceDigest: candidateIdentityDigest(candidate),
      projector: candidate.projector,
      policyVersion: governance.policyVersion,
      reason: "Reviewed bounded use.",
      clarification: "Keep the approved host scope.",
      scope: [...candidate.targets],
      notBefore: "2026-08-01T00:00:00Z",
      expiresAt: "2026-08-31T00:00:00Z",
      github: {
        repository: "acme/governance",
        attestationId: "original-receipt",
        subjectDigest: `sha256:${"a".repeat(64)}`,
      },
    };
    approval.github.subjectDigest = approvalAttestationDigest(approval);
    governance.authority.approvals = [approval];
    const before = structuredClone(input);
    const model = policyStudioModel(undefined, undefined, { initialPolicy: input });
    const imported = importWorkbenchPolicySelections(
      model.initialPolicy,
      model.workbenchBundle,
      model.workbenchBindings,
      model.workbenchSourceInputs,
    );
    expect(imported.accepted).toBe(true);
    expect(imported.diagnostics).toEqual([]);
    const edited = compilePolicy(
      { ...model.initialPolicy, references: { repoContract: "ai-coding/reopened.json" } },
      imported.state,
      model.workbenchBundle,
      model.workbenchBindings,
      "author",
      model.workbenchSourceInputs,
    );
    expect(edited.accepted, edited.diagnostics.join("; ")).toBe(true);
    expect(edited.policy.governance).toEqual(before.governance);
    expect(edited.policy.authoringSelections).toEqual(before.authoringSelections);
    expect(input).toEqual(before);
    expect(
      required(parseOrgPolicy(edited.policy).governance).authority.approvals[0]?.github
        .subjectDigest,
    ).toBe(approval.github.subjectDigest);
  });
  it("consumes old exact pins and leaves their policy, approval scope and digests unchanged", () => {
    const saved = authored(legacy);
    const before = structuredClone(saved.policy);
    const consumed = consumeWorkbenchPolicy(saved.policy, saved.state, current);
    expect(consumed.accepted, consumed.diagnostics.join("; ")).toBe(true);
    expect(consumed.policy).toEqual(parseOrgPolicy(before));
    expect(saved.policy).toEqual(before);
    const consumedPolicy = required(consumed.policy);
    const candidate = required(required(consumedPolicy.governance).catalog.reviewed[0]);
    expect(candidate.targets).toEqual(["claude", "kiro"]);
    const shipped = required(current.catalog.mcp.find((item) => item.id === candidate.id)).control;
    const effective = resolveEffectiveOrgPolicy(consumedPolicy, {
      preparedWorkbenchCatalog: current,
      targets: ["claude"],
      aihReviewedControls: {
        [shipped.id]: { control: shipped, controlDigest: reviewedControlDigest(shipped) },
      },
      mcpIdentities: {
        [shipped.id]: {
          subject: candidate.source.type === "mcp" ? candidate.source.subject : "",
          projectable: true,
        },
      },
    });
    expect(effective.candidates[0]).toMatchObject({
      effective: true,
      projection: { requestedTargets: ["claude"] },
    });
  });

  it("authors a fresh expanded declaration for Codex", () => {
    const saved = authored(current, ["codex"]);
    const consumed = consumeWorkbenchPolicy(saved.policy, saved.state, current);
    expect(consumed.accepted, consumed.diagnostics.join("; ")).toBe(true);
    expect(consumed.policy?.governance?.activations[0]?.targets).toEqual(["codex"]);
    expect(consumed.policy?.governance?.catalog.reviewed[0]?.targets).toContain("codex");
    const model = policyStudioModel(undefined, undefined, {
      initialPolicy: parseOrgPolicy(saved.policy),
    });
    const imported = importWorkbenchPolicySelections(
      model.initialPolicy,
      model.workbenchBundle,
      model.workbenchBindings,
      model.workbenchSourceInputs,
    );
    expect(imported.diagnostics).toEqual([]);
    expect(model.workbenchBindings["aih/sequential-thinking"]?.candidate?.targets).toContain(
      "codex",
    );
  });

  it("keeps genuine pin and source changes visible when reopening a saved policy", () => {
    for (const change of ["content-pin", "source-identity"]) {
      const saved = authored(legacy);
      const input = parseOrgPolicy(saved.policy);
      if (input.schemaVersion !== 3) throw new Error("expected saved Workbench policy");
      if (change === "content-pin") {
        const root = required(input.authoringSelections.roots[0]);
        root.contentDigest = `sha256:${"f".repeat(64)}`;
        for (const pin of root.resolvedItems) {
          if (pin.assetId === root.assetId) pin.contentDigest = root.contentDigest;
        }
      } else {
        const candidate = required(required(input.governance).catalog.reviewed[0]);
        if (candidate.source.type !== "mcp") throw new Error("expected MCP fixture source");
        candidate.source.subject = `mcp-server-sha256:${"f".repeat(64)}`;
      }
      const before = structuredClone(input);
      const model = policyStudioModel(undefined, undefined, { initialPolicy: input });
      const imported = importWorkbenchPolicySelections(
        model.initialPolicy,
        model.workbenchBundle,
        model.workbenchBindings,
        model.workbenchSourceInputs,
      );
      expect(imported.diagnostics).toContain("Stale saved asset: aih/sequential-thinking");
      expect(model.workbenchBindings["aih/sequential-thinking"]?.candidate?.targets).toContain(
        "codex",
      );
      expect(input).toEqual(before);
    }
  });

  it("refuses an old pin paired with new activation targets or a mixed invented target inventory", () => {
    for (const candidateTargets of [
      ["claude", "kiro"],
      ["claude", "kiro", "codex"],
    ]) {
      const saved = authored(legacy);
      const policy = parseOrgPolicy(saved.policy);
      const governance = required(policy.governance);
      required(governance.catalog.reviewed[0]).targets = candidateTargets as GovernedMcpTarget[];
      required(governance.activations[0]).targets = ["codex"];
      governance.supportedClis = ["codex"];
      expect(
        consumeWorkbenchPolicy(policy as unknown as Record<string, unknown>, saved.state, current)
          .accepted,
      ).toBe(false);
    }
  });

  it("refuses changed source identity and tampered historical content pins", () => {
    const changedCatalog = structuredClone(current.catalog);
    const changed = required(changedCatalog.mcp.find((item) => item.id === "sequential-thinking"));
    if (changed.control.source.type !== "mcp") throw new Error("expected MCP");
    changed.control.source.subject = `mcp-server-sha256:${"b".repeat(64)}`;
    const saved = authored(legacy);
    expect(
      consumeWorkbenchPolicy(saved.policy, saved.state, prepareWorkbenchCatalog(changedCatalog))
        .accepted,
    ).toBe(false);
    const tampered = authored(legacy);
    required(
      (tampered.policy.authoringSelections as typeof tampered.state).roots[0],
    ).contentDigest = `sha256:${"f".repeat(64)}`;
    expect(consumeWorkbenchPolicy(tampered.policy, tampered.state, current).accepted).toBe(false);
  });
});
