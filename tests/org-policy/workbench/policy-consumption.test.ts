import { describe, expect, it } from "vitest";
import { resolveEffectiveOrgPolicy } from "../../../src/org-policy/effective.js";
import type { OrgPolicy } from "../../../src/org-policy/schema.js";
import { compilePolicy } from "../../../src/org-policy/workbench/policy-compiler.js";
import { consumeWorkbenchPolicy } from "../../../src/org-policy/workbench/policy-consumption.js";
import { importWorkbenchPolicySelections } from "../../../src/org-policy/workbench/policy-import.js";
import { defaultPreparedWorkbenchCatalog } from "../../../src/org-policy/workbench/prepared-catalog.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../../src/org-policy/workbench/selection-engine.js";
import { mcpRuntimeOverlapPresentation } from "../../../src/org-policy/workbench/ui/selection-comparison.js";

describe("schema-v3 policy consumption", () => {
  it("advises on the five exact declared AIH and ECC MCP registration-name pairs", () => {
    const prepared = defaultPreparedWorkbenchCatalog();
    for (const id of [
      "code-review-graph",
      "codebase-memory-mcp",
      "context7",
      "github",
      "sequential-thinking",
    ]) {
      const aih = prepared.bundle.assets[`aih/${id}`];
      const ecc = prepared.bundle.assets[`ecc/mcp:${id}`];
      if (aih === undefined || ecc === undefined)
        throw new Error(`expected AIH and ECC ${id} MCP records`);
      expect(aih.runtimeIdentity).toBe(`mcp:${id}`);
      expect(ecc.runtimeIdentity).toBe(`mcp:${id}`);
      const action =
        aih.authoring.action === "record-request"
          ? {
              type: "record-request" as const,
              assetId: aih.id,
              origin: { kind: "administrator" as const },
            }
          : {
              type: "select-root" as const,
              assetId: aih.id,
              origin: { kind: "administrator" as const },
            };
      const result = reduceWorkbenchAction(prepared.bundle, createWorkbenchState(), action);
      expect(result.accepted).toBe(true);
      expect(mcpRuntimeOverlapPresentation(ecc, prepared.bundle, result.state)).toMatchObject({
        kind: "potential-overlap",
        runtimeIdentity: `mcp:${id}`,
        candidates: [{ assetId: `aih/${id}` }],
      });
    }
  });
  it("keeps malformed authoring intent inert and blocking for direct effective callers", () => {
    const policy = {
      schemaVersion: 3,
      minimumPosture: "vibe",
      references: { repoContract: "repo" },
      authoringSources: [],
      authoringSelections: {
        selectionVersion: "workbench-selection/v1",
        roots: {},
        exclusions: [],
        requests: [],
      },
    } as unknown as OrgPolicy;
    expect(() => resolveEffectiveOrgPolicy(policy)).not.toThrow();
    const effective = resolveEffectiveOrgPolicy(policy);
    expect(effective.blocking).toBe(true);
    expect(effective.projectionBlocking).toBe(true);
    expect(
      effective.decisionBlockers.some((blocker) => blocker.code === "authoring-selection-invalid"),
    ).toBe(true);
    expect(effective.candidates).toEqual([]);
    expect(effective.authoringDiagnostics).toEqual([
      "Workbench state exceeds its aggregate budget or contains malformed collections",
    ]);
  });

  it("blocks a V3 object missing its authoring selection envelope", () => {
    const effective = resolveEffectiveOrgPolicy({
      schemaVersion: 3,
      minimumPosture: "vibe",
      references: { repoContract: "repo" },
    } as unknown as OrgPolicy);
    expect(effective).toMatchObject({ blocking: true, projectionBlocking: true });
    expect(effective.decisionBlockers).toContainEqual(
      expect.objectContaining({ code: "authoring-selection-invalid" }),
    );
  });
  it("restores package-sealed ECC compiler bindings and rejects forged legacy mirrors", () => {
    const prepared = defaultPreparedWorkbenchCatalog();
    const asset = prepared.bundle.assets["ecc/mcp:supabase"];
    const binding = prepared.bindings["ecc/mcp:supabase"];
    if (asset === undefined || binding?.kind !== "external-selection" || !binding.external)
      throw new Error("expected package-sealed ECC MCP binding");
    expect(
      Object.values(prepared.bundle.evidence).some((report) =>
        report.subjects.some((subject) => subject.assetId === asset.id),
      ),
    ).toBe(true);

    const state = reduceWorkbenchAction(prepared.bundle, createWorkbenchState(), {
      type: "select-root",
      assetId: asset.id,
      origin: { kind: "administrator" },
    }).state;
    const authored = compilePolicy(
      { schemaVersion: 2, minimumPosture: "vibe", references: { repoContract: "repo" } },
      state,
      prepared.bundle,
      prepared.bindings,
    );
    expect(authored.accepted).toBe(true);
    if (!authored.accepted) throw new Error(authored.diagnostics.join("; "));
    expect(authored.policy.authoringSelections).toMatchObject({
      roots: [expect.objectContaining({ assetId: asset.id })],
    });
    expect((authored.policy.governance as Record<string, unknown>).externalSelections).toEqual([
      {
        framework: "ecc",
        items: [binding.external.item],
        roots: [binding.external.item.id],
        unattributedItems: [],
      },
    ]);
    expect(
      importWorkbenchPolicySelections(
        authored.policy,
        prepared.bundle,
        prepared.bindings,
        prepared.sourceInputs,
      ),
    ).toEqual({ accepted: true, state, diagnostics: [] });
    expect(consumeWorkbenchPolicy(authored.policy, state, prepared)).toMatchObject({
      accepted: true,
      requestedIntent: [asset.id],
      selectedControls: [],
    });
    const forged = structuredClone(authored.policy);
    const governance = forged.governance as { externalSelections: unknown[] };
    const selection = governance.externalSelections[0] as { items: unknown[] } | undefined;
    if (selection === undefined) throw new Error("expected ECC external selection");
    selection.items.push({ ...binding.external.item, id: "mcp:forged" });
    expect(consumeWorkbenchPolicy(forged, state, prepared)).toMatchObject({
      accepted: false,
      diagnostics: ["Legacy external selections disagree with pinned authoring selections"],
    });
  });

  it("leaves schema-v2 resolution unchanged", () => {
    const effective = resolveEffectiveOrgPolicy({
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "repo" },
    });
    expect(effective.blocking).toBe(false);
    expect(effective.candidates).toEqual([]);
  });
});
