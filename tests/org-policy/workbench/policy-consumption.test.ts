import { describe, expect, it } from "vitest";
import { resolveEffectiveOrgPolicy } from "../../../src/org-policy/effective.js";
import type { OrgPolicy } from "../../../src/org-policy/schema.js";
import { compilePolicy } from "../../../src/org-policy/workbench/policy-compiler.js";
import { consumeWorkbenchPolicy } from "../../../src/org-policy/workbench/policy-consumption.js";
import {
  defaultPreparedWorkbenchCatalog,
  prepareWorkbenchCatalog,
} from "../../../src/org-policy/workbench/prepared-catalog.js";
import {
  createWorkbenchState,
  reduceWorkbenchAction,
} from "../../../src/org-policy/workbench/selection-engine.js";

describe("schema-v3 policy consumption", () => {
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
  it("reports pinned request intent separately from effective candidates", () => {
    const prepared = defaultPreparedWorkbenchCatalog();
    const asset = Object.values(prepared.bundle.assets).find(
      (candidate) => candidate.authoring.action === "record-request",
    );
    if (asset === undefined) throw new Error("expected request-only catalog asset");
    const state = reduceWorkbenchAction(prepared.bundle, createWorkbenchState(), {
      type: "record-request",
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
    expect(authored.policy).toMatchObject({
      schemaVersion: 3,
      authoringSelections: { requests: [{ assetId: asset.id }] },
    });
    const consumed = consumeWorkbenchPolicy(authored.policy, state, prepared);
    expect(consumed).toMatchObject({ accepted: true });
    const effective = resolveEffectiveOrgPolicy(authored.policy as OrgPolicy);
    expect(effective.authoringIntent).toEqual({
      requestedIntent: [asset.id],
      selectedControls: [],
    });
    expect(effective.candidates).toEqual([]);
    expect(effective.activeMcpServerIds).toEqual([]);
  });
  it("reports a selected organization declaration as inert generic intent", () => {
    const prepared = prepareWorkbenchCatalog(undefined, {
      organizationManifestBytes: [
        JSON.stringify({
          version: "organization-authoring-manifest/v1",
          source: { id: "source:acme", revisionId: "v1", locator: "Acme catalog" },
          assets: [
            {
              id: "skill:triage",
              kind: "skill",
              label: "Triage",
              path: "skills/triage/SKILL.md",
            },
          ],
        }),
      ],
    });
    const asset = Object.values(prepared.bundle.assets).find(
      (candidate) => candidate.sourceId === "source:acme",
    );
    if (asset === undefined) throw new Error("expected organization asset");
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
      "author",
      prepared.sourceInputs,
    );
    expect(authored.accepted).toBe(true);
    const consumed = consumeWorkbenchPolicy(authored.policy, state, prepared);
    expect(consumed).toMatchObject({
      accepted: true,
      requestedIntent: [asset.id],
      selectedControls: [],
    });
    const effective = resolveEffectiveOrgPolicy(authored.policy as OrgPolicy, {
      preparedWorkbenchCatalog: prepared,
    });
    expect(effective.authoringIntent).toEqual({
      requestedIntent: [asset.id],
      selectedControls: [],
    });
    expect(effective.candidates).toEqual([]);
    expect(effective.activeMcpServerIds).toEqual([]);
  });

  it("reconstructs exact organization sources while retaining known Core controls", () => {
    const manifest = JSON.stringify({
      version: "organization-authoring-manifest/v1",
      source: { id: "source:acme", revisionId: "v1", locator: "Acme catalog" },
      assets: [
        {
          id: "skill:triage",
          kind: "skill",
          label: "Triage",
          path: "skills/triage/SKILL.md",
        },
      ],
    });
    const prepared = prepareWorkbenchCatalog(undefined, { organizationManifestBytes: [manifest] });
    const organizationAsset = Object.values(prepared.bundle.assets).find(
      (asset) => asset.sourceId === "source:acme",
    );
    const control = prepared.bundle.assets["aih/usage-metering"];
    if (organizationAsset === undefined || control === undefined)
      throw new Error("expected organization intent and Core control");

    let state = createWorkbenchState();
    state = reduceWorkbenchAction(prepared.bundle, state, {
      type: "select-root",
      assetId: control.id,
      origin: { kind: "administrator" },
    }).state;
    state = reduceWorkbenchAction(prepared.bundle, state, {
      type: "select-root",
      assetId: organizationAsset.id,
      origin: { kind: "administrator" },
    }).state;
    const authored = compilePolicy(
      { schemaVersion: 2, minimumPosture: "vibe", references: { repoContract: "repo" } },
      state,
      prepared.bundle,
      prepared.bindings,
      "author",
      prepared.sourceInputs,
    );
    expect(authored.accepted).toBe(true);
    expect(authored.policy).toMatchObject({
      schemaVersion: 3,
      authoringSources: [
        expect.objectContaining({ sourceId: "source:acme", sourceRevisionId: "v1" }),
      ],
    });

    const consumed = consumeWorkbenchPolicy(
      authored.policy,
      createWorkbenchState(),
      defaultPreparedWorkbenchCatalog(),
    );
    expect(consumed).toMatchObject({
      accepted: true,
      requestedIntent: [organizationAsset.id],
      selectedControls: [control.id],
    });
    const effective = resolveEffectiveOrgPolicy(authored.policy as OrgPolicy);
    expect(effective.authoringIntent).toEqual({
      requestedIntent: [organizationAsset.id],
      selectedControls: [control.id],
    });
    expect(effective.candidates).toContainEqual(
      expect.objectContaining({ id: "usage-metering", requested: true, effective: false }),
    );
    expect(effective.candidates.some((candidate) => candidate.id === organizationAsset.id)).toBe(
      false,
    );
    expect(effective.activeMcpServerIds).not.toContain(organizationAsset.id);
    expect(effective.capabilityPackages).toBeUndefined();
    expect(effective.externalSelections).toEqual([]);
  });

  it("rejects omitted and tampered organization source transport before projection", () => {
    const manifest = JSON.stringify({
      version: "organization-authoring-manifest/v1",
      source: { id: "source:acme", revisionId: "v1", locator: "Acme catalog" },
      assets: [
        {
          id: "skill:triage",
          kind: "skill",
          label: "Triage",
          path: "skills/triage/SKILL.md",
        },
      ],
    });
    const prepared = prepareWorkbenchCatalog(undefined, { organizationManifestBytes: [manifest] });
    const asset = Object.values(prepared.bundle.assets).find(
      (candidate) => candidate.sourceId === "source:acme",
    );
    if (asset === undefined) throw new Error("expected organization asset");
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
      "author",
      prepared.sourceInputs,
    );
    if (!authored.accepted) throw new Error(authored.diagnostics.join("; "));

    const missing = structuredClone(authored.policy);
    delete (missing as Record<string, unknown>).authoringSources;
    expect(consumeWorkbenchPolicy(missing, state, defaultPreparedWorkbenchCatalog())).toMatchObject(
      {
        accepted: false,
        diagnostics: ["missing authoring source input for source:acme"],
      },
    );

    const tampered = structuredClone(authored.policy) as {
      authoringSources: Array<{ bytesBase64: string; byteLength: number }>;
    };
    tampered.authoringSources[0]!.bytesBase64 = "e30=";
    tampered.authoringSources[0]!.byteLength = 2;
    expect(
      consumeWorkbenchPolicy(tampered, state, defaultPreparedWorkbenchCatalog()),
    ).toMatchObject({
      accepted: false,
      requestedIntent: [],
      selectedControls: [],
    });
  });
  it("reports distinct missing and stale v3 pins while leaving all effects inert", () => {
    const prepared = defaultPreparedWorkbenchCatalog();
    const asset = Object.values(prepared.bundle.assets).find(
      (candidate) => candidate.authoring.action === "record-selection",
    );
    if (asset === undefined) throw new Error("expected record-selection asset");
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

    const stale = structuredClone(authored.policy) as {
      authoringSelections: {
        roots: Array<{ contentDigest: string; resolvedItems: Array<{ contentDigest: string }> }>;
      };
    };
    stale.authoringSelections.roots[0]!.contentDigest = "sha256:" + "f".repeat(64);
    stale.authoringSelections.roots[0]!.resolvedItems[0]!.contentDigest =
      "sha256:" + "f".repeat(64);
    const staleEffective = resolveEffectiveOrgPolicy(stale as OrgPolicy);
    expect(staleEffective.authoringDiagnostics).toContain("Stale selected content: " + asset.id);
    expect(staleEffective.candidates).toEqual([]);
    expect(staleEffective.activeMcpServerIds).toEqual([]);

    const missing = structuredClone(authored.policy) as {
      authoringSelections: {
        roots: Array<{
          assetId: string;
          sourceId: string;
          sourceRevisionId: string;
          contentDigest: string;
          resolvedItems: Array<{
            assetId: string;
            sourceId: string;
            sourceRevisionId: string;
            contentDigest: string;
          }>;
        }>;
      };
    };
    const root = missing.authoringSelections.roots[0]!;
    root.assetId = "source:missing";
    root.sourceId = "source:missing";
    root.sourceRevisionId = "missing";
    root.contentDigest = "sha256:" + "e".repeat(64);
    root.resolvedItems = [
      {
        assetId: root.assetId,
        sourceId: root.sourceId,
        sourceRevisionId: root.sourceRevisionId,
        contentDigest: root.contentDigest,
      },
    ];
    const missingEffective = resolveEffectiveOrgPolicy(missing as OrgPolicy);
    expect(missingEffective.authoringDiagnostics).toContain(
      "missing authoring source input for source:missing",
    );
    expect(missingEffective.candidates).toEqual([]);
    expect(missingEffective.activeMcpServerIds).toEqual([]);
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
