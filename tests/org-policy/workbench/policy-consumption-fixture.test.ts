import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalStrictJsonSha256V1 } from "../../../src/contract/strict-json-v1.js";
import { resolveEffectiveOrgPolicy } from "../../../src/org-policy/effective.js";
import type { OrgPolicy } from "../../../src/org-policy/schema.js";
import { parseAuthoringCatalogBundleV1 } from "../../../src/org-policy/workbench/contracts.js";
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

/**
 * Keep generic consumer transitions independent of the full packaged catalog.
 * Organization manifest bytes still go through the production compiler; this
 * fixture only supplies its inert assembly and a sealed, non-production baseline.
 */
vi.mock("../../../src/org-policy/workbench/prepared-catalog.js", async () => {
  const { tinyStudioModel } = await import("../studio-test-fixture.js");
  const { compileOrganizationManifestV1 } = await import(
    "../../../src/org-policy/workbench/compilers/organization-manifest.js"
  );
  const baseline = () => {
    const model = tinyStudioModel();
    return {
      catalog: {},
      bundle: model.workbenchBundle,
      bindings: model.workbenchBindings,
      sourceInputs: model.workbenchSourceInputs,
    };
  };
  const prepare = (
    _catalog: unknown,
    options?: { organizationManifestBytes?: readonly string[] },
  ) => {
    const manifests = options?.organizationManifestBytes ?? [];
    if (manifests.length === 0) return baseline();
    if (manifests.length !== 1) throw new TypeError("fixture accepts one organization manifest");
    const manifest = manifests[0];
    if (manifest === undefined) throw new TypeError("fixture manifest is unavailable");
    const model = tinyStudioModel();
    const compiled = compileOrganizationManifestV1(manifest);
    const assets = Object.fromEntries(
      compiled.declarations.map(({ declaration }) => [
        declaration.id,
        {
          ...declaration,
          authoring: {
            action: declaration.kind === "mcp" ? "record-request" : "record-selection",
            supportedTargets: [],
          },
        },
      ]),
    );
    const detailChunks = Object.fromEntries(
      Object.entries(compiled.detailBytes).map(([id, bytes]) => [
        id,
        { bytes, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` },
      ]),
    );
    const bareBundle = {
      version: "authoring-catalog-bundle/v1" as const,
      sources: {
        ...model.workbenchBundle.sources,
        [compiled.source.id]: {
          id: compiled.source.id,
          distributor: { kind: "organization" as const, locator: compiled.source.locator },
          upstreamOrigin: { kind: "organization" as const, locator: compiled.source.locator },
          inputFormat: compiled.source.inputFormat,
          revision: {
            id: compiled.source.revisionId,
            contentDigest: compiled.source.contentDigest,
          },
          compiler: { id: "organization-manifest", version: "1" },
          policyInputRequired: true,
        },
      },
      assets: { ...model.workbenchBundle.assets, ...assets },
      groups: model.workbenchBundle.groups,
      relations: [...model.workbenchBundle.relations, ...compiled.relations],
      templates: model.workbenchBundle.templates,
      evidence: model.workbenchBundle.evidence,
      detailChunks: { ...model.workbenchBundle.detailChunks, ...detailChunks },
    };
    const bundle = parseAuthoringCatalogBundleV1({
      ...bareBundle,
      provenance: {
        bundleDigest: `sha256:${canonicalStrictJsonSha256V1({
          ...bareBundle,
          provenance: {},
        })}`,
      },
    });
    return {
      catalog: model.catalog,
      bundle,
      bindings: {
        ...model.workbenchBindings,
        ...Object.fromEntries(Object.keys(assets).map((assetId) => [assetId, { kind: "intent" }])),
      },
      sourceInputs: {
        ...model.workbenchSourceInputs,
        [compiled.source.id]: {
          kind: "organization-manifest",
          sourceId: compiled.source.id,
          sourceRevisionId: compiled.source.revisionId,
          inputFormat: "organization-authoring-manifest/v1",
          digest: compiled.source.contentDigest,
          byteLength: Buffer.byteLength(manifest, "utf8"),
          bytesBase64: Buffer.from(manifest, "utf8").toString("base64"),
        },
      },
    };
  };
  return {
    defaultPreparedWorkbenchCatalog: baseline,
    packagedPreparedWorkbenchCatalogV1: baseline,
    prepareWorkbenchCatalog: prepare,
  };
});

const basePolicy = {
  schemaVersion: 2,
  minimumPosture: "vibe",
  references: { repoContract: "repo" },
};

describe("schema-v3 policy consumption with a sealed fixture baseline", () => {
  it("reports pinned request intent separately from effective candidates", () => {
    const prepared = defaultPreparedWorkbenchCatalog();
    const asset = prepared.bundle.assets["fixture:request"];
    if (asset === undefined) throw new Error("expected fixture request-only catalog asset");
    const state = reduceWorkbenchAction(prepared.bundle, createWorkbenchState(), {
      type: "record-request",
      assetId: asset.id,
      origin: { kind: "administrator" },
    }).state;
    const authored = compilePolicy(basePolicy, state, prepared.bundle, prepared.bindings);
    expect(authored.accepted).toBe(true);
    expect(authored.policy).toMatchObject({
      schemaVersion: 3,
      authoringSelections: { requests: [{ assetId: asset.id }] },
    });
    expect(consumeWorkbenchPolicy(authored.policy, state, prepared)).toMatchObject({
      accepted: true,
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
      basePolicy,
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
    const source = tampered.authoringSources[0];
    if (source === undefined) throw new Error("expected transported authoring source");
    source.bytesBase64 = "e30=";
    source.byteLength = 2;
    expect(
      consumeWorkbenchPolicy(tampered, state, defaultPreparedWorkbenchCatalog()),
    ).toMatchObject({
      accepted: false,
      requestedIntent: [],
      selectedControls: [],
    });
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
      basePolicy,
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
    const control = prepared.bundle.assets["fixture:control"];
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
      basePolicy,
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

  it("reports distinct missing and stale v3 pins while leaving all effects inert", () => {
    const prepared = defaultPreparedWorkbenchCatalog();
    const asset = prepared.bundle.assets["fixture:external"];
    if (asset === undefined) throw new Error("expected fixture record-selection asset");
    const state = reduceWorkbenchAction(prepared.bundle, createWorkbenchState(), {
      type: "select-root",
      assetId: asset.id,
      origin: { kind: "administrator" },
    }).state;
    const authored = compilePolicy(basePolicy, state, prepared.bundle, prepared.bindings);
    expect(authored.accepted).toBe(true);

    const stale = structuredClone(authored.policy) as {
      authoringSelections: {
        roots: Array<{ contentDigest: string; resolvedItems: Array<{ contentDigest: string }> }>;
      };
    };
    const staleRoot = stale.authoringSelections.roots[0];
    const staleItem = staleRoot?.resolvedItems[0];
    if (staleRoot === undefined || staleItem === undefined)
      throw new Error("expected pinned fixture selection");
    staleRoot.contentDigest = `sha256:${"f".repeat(64)}`;
    staleItem.contentDigest = `sha256:${"f".repeat(64)}`;
    const staleEffective = resolveEffectiveOrgPolicy(stale as OrgPolicy, {
      preparedWorkbenchCatalog: prepared,
    });
    expect(staleEffective.authoringDiagnostics).toContain(`Stale selected content: ${asset.id}`);
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
    const root = missing.authoringSelections.roots[0];
    if (root === undefined) throw new Error("expected pinned fixture selection");
    root.assetId = "source:missing";
    root.sourceId = "source:missing";
    root.sourceRevisionId = "missing";
    root.contentDigest = `sha256:${"e".repeat(64)}`;
    root.resolvedItems = [
      {
        assetId: root.assetId,
        sourceId: root.sourceId,
        sourceRevisionId: root.sourceRevisionId,
        contentDigest: root.contentDigest,
      },
    ];
    const missingEffective = resolveEffectiveOrgPolicy(missing as OrgPolicy, {
      preparedWorkbenchCatalog: prepared,
    });
    expect(missingEffective.authoringDiagnostics).toContain(
      "missing authoring source input for source:missing",
    );
    expect(missingEffective.candidates).toEqual([]);
    expect(missingEffective.activeMcpServerIds).toEqual([]);
  });
});
