import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { policyAuthoringCatalog } from "../../../src/org-policy/catalog.js";
import * as packagedSourceData from "../../../src/org-policy/workbench/core/packaged-source-data.js";
import {
  defaultPreparedWorkbenchCatalog,
  packagedPreparedWorkbenchCatalogV1,
  prepareWorkbenchCatalog,
} from "../../../src/org-policy/workbench/prepared-catalog.js";

let admittedPackage: ReturnType<typeof packagedPreparedWorkbenchCatalogV1>;

beforeAll(() => {
  // The reuse contract starts from a package that has already been admitted.
  // Cold package admission is covered independently; keep this assertion focused
  // on the live exact-pin reuse path.
  admittedPackage = packagedPreparedWorkbenchCatalogV1();
});

describe("prepared workbench catalog", () => {
  it("reuses the admitted package for current exact pins without rebuilding its overlays", () => {
    const baseline = admittedPackage;
    const asset = baseline.bundle.assets["mattpocock/skill:tdd"];
    if (asset === undefined) throw new Error("Missing packaged Matt skill");
    const pin = {
      assetId: asset.id,
      sourceId: asset.sourceId,
      sourceRevisionId: asset.sourceRevisionId,
      contentDigest: asset.contentDigest,
    };
    const overlay = vi.spyOn(packagedSourceData, "applyPackagedWorkbenchSourceDataV1");
    try {
      const first = prepareWorkbenchCatalog(baseline.catalog, {
        sourceDataPins: [pin],
        packageDataOnly: true,
      });
      expect(first).toEqual(baseline);
      expect(overlay).not.toHaveBeenCalled();
      const firstAsset = first.bundle.assets[pin.assetId];
      if (firstAsset === undefined) throw new Error("Missing detached Matt skill");
      firstAsset.label = "caller mutation";
      first.bindings[pin.assetId] = { kind: "intent" };
      expect(
        prepareWorkbenchCatalog(baseline.catalog, {
          sourceDataPins: [pin],
          packageDataOnly: true,
        }),
      ).toEqual(baseline);
      expect(overlay).not.toHaveBeenCalled();
      prepareWorkbenchCatalog(baseline.catalog, {
        sourceDataPins: [{ ...pin, contentDigest: `sha256:${"0".repeat(64)}` }],
        packageDataOnly: true,
      });
      expect(overlay).toHaveBeenCalledOnce();
    } finally {
      overlay.mockRestore();
    }
  });

  it("rechecks source-store bytes after reusing an admitted package snapshot", () => {
    const baseline = admittedPackage;
    const root = mkdtempSync(join(tmpdir(), "aih-prepared-catalog-live-store-"));
    vi.stubEnv("AIH_WORKBENCH_DATA", root);
    try {
      expect(prepareWorkbenchCatalog(baseline.catalog)).toEqual(baseline);
      // A store added after the first call must still enter the real trust parser.
      writeFileSync(join(root, "active.json"), '{"version":1,"sources":{}}');
      writeFileSync(join(root, "trust.json"), '{"version":1,"version":1}');
      expect(() => prepareWorkbenchCatalog(baseline.catalog)).toThrow(/duplicate JSON object key/);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

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
    const firstFramework = first.catalog.frameworks[0];
    if (firstFramework === undefined) throw new Error("expected framework catalog entry");
    firstFramework.repository = "https://mutated.example.test/catalog";

    const second = prepareWorkbenchCatalog(catalog);
    expect(second.bundle.assets[assetId]?.label).not.toBe("mutated caller copy");
    expect(second.catalog.frameworks[0]?.repository).not.toBe(
      "https://mutated.example.test/catalog",
    );

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
  it("keeps the package-owned prepared catalog memo detached from callers", () => {
    const first = packagedPreparedWorkbenchCatalogV1();
    const assetId = Object.keys(first.bundle.assets)[0];
    if (assetId === undefined) throw new Error("expected prepared catalog asset");
    const asset = first.bundle.assets[assetId];
    if (asset === undefined) throw new Error("expected prepared catalog asset");
    asset.label = "mutated caller copy";
    const framework = first.catalog.frameworks[0];
    if (framework === undefined) throw new Error("expected framework catalog entry");
    framework.repository = "https://mutated.example.test/catalog";

    const second = packagedPreparedWorkbenchCatalogV1();
    expect(second.bundle.assets[assetId]?.label).not.toBe("mutated caller copy");
    expect(second.catalog.frameworks[0]?.repository).not.toBe(
      "https://mutated.example.test/catalog",
    );
  });
});
