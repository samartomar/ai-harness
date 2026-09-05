import { describe, expect, it } from "vitest";
import { policyAuthoringCatalog } from "../../../src/org-policy/catalog.js";
import {
  defaultPreparedWorkbenchCatalog,
  prepareWorkbenchCatalog,
} from "../../../src/org-policy/workbench/prepared-catalog.js";

describe("prepared workbench catalog", () => {
  it("prepares unknown organization MCP, skill, and agent assets as intent-only bindings", () => {
    const prepared = prepareWorkbenchCatalog(policyAuthoringCatalog(), {
      organizationManifestBytes: [
        JSON.stringify({
          version: "organization-authoring-manifest/v1",
          source: { id: "source:acme", revisionId: "2026-09", locator: "Acme policy catalog" },
          assets: [
            { id: "mcp:unknown", kind: "mcp", label: "Unknown MCP", path: "mcp/unknown.json" },
            {
              id: "skill:unknown",
              kind: "skill",
              label: "Unknown skill",
              path: "skills/unknown/SKILL.md",
            },
            {
              id: "agent:unknown",
              kind: "agent",
              label: "Unknown agent",
              path: "agents/unknown.md",
            },
          ],
        }),
      ],
    });
    const assets = Object.values(prepared.bundle.assets).filter(
      (asset) => asset.sourceId === "source:acme",
    );
    expect(assets.map((asset) => asset.kind).sort()).toEqual(["agent", "mcp", "skill"]);
    expect(assets.every((asset) => asset.authoring.action !== "select-control")).toBe(true);
    expect(assets.map((asset) => prepared.bindings[asset.id]?.kind)).toEqual([
      "intent",
      "intent",
      "intent",
    ]);
    const source = prepared.bundle.sources[assets[0]?.sourceId ?? "missing"];
    if (source === undefined) throw new Error("expected compiled organization source");
    expect(prepared.sourceInputs[source.id]).toMatchObject({
      kind: "organization-manifest",
      sourceId: source.id,
      sourceRevisionId: source.revision.id,
      inputFormat: "organization-authoring-manifest/v1",
      digest: source.revision.contentDigest,
    });
  });

  it("maps exact legacy AIH request identities only to request-action assets", () => {
    const prepared = prepareWorkbenchCatalog();
    for (const legacyRequestId of prepared.catalog.aihMcpRequestIds) {
      const assetId = `aih/${legacyRequestId}`;
      const asset = prepared.bundle.assets[assetId];
      const binding = prepared.bindings[assetId];
      if (asset?.authoring.action === "record-request") {
        expect(binding).toMatchObject({
          kind: "intent",
          legacyRequestId,
          legacyRequestOrder: expect.any(Number),
        });
      } else {
        expect(binding?.legacyRequestId).toBeUndefined();
      }
    }
  });

  it("returns detached prepared snapshots and invalidates them when catalog bytes change", () => {
    const catalog = policyAuthoringCatalog();
    const first = prepareWorkbenchCatalog(catalog);
    const assetId = Object.keys(first.bundle.assets)[0];
    if (assetId === undefined) throw new Error("expected prepared catalog asset");
    const asset = first.bundle.assets[assetId];
    if (asset === undefined) throw new Error("expected prepared catalog asset");
    asset.label = "mutated caller copy";

    const second = prepareWorkbenchCatalog(catalog);
    expect(second.bundle.assets[assetId]?.label).not.toBe("mutated caller copy");

    const changed = structuredClone(catalog);
    const firstMcp = changed.mcp[0];
    if (firstMcp === undefined) throw new Error("expected built-in MCP catalog entry");
    firstMcp.description = `${firstMcp.description} changed`;
    const changedPrepared = prepareWorkbenchCatalog(changed);
    expect(changedPrepared.bundle.provenance.bundleDigest).not.toBe(
      second.bundle.provenance.bundleDigest,
    );
  });
  it("keeps the default prepared catalog memo independent of organization options", () => {
    const first = defaultPreparedWorkbenchCatalog();
    const second = defaultPreparedWorkbenchCatalog();
    expect(first).toEqual(second);
    expect(
      Object.values(first.bundle.sources).some(
        (source) => source.inputFormat === "organization-authoring-manifest/v1",
      ),
    ).toBe(false);
  });
});
