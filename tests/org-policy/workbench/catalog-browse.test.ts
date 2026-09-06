import { describe, expect, it } from "vitest";
import {
  catalogBrowse,
  catalogSourceDisplayName,
} from "../../../src/org-policy/workbench/catalog-browse.js";
import type {
  AuthoringAssetV1,
  AuthoringCatalogBundleV1,
} from "../../../src/org-policy/workbench/contracts.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

const digest = `sha256:${"c".repeat(64)}`;

function asset(id: string, sourceId: string, kind: string, label = id): AuthoringAssetV1 {
  return {
    id,
    sourceId,
    sourceRevisionId: "revision:1",
    contentDigest: digest,
    originalPath: "catalog.json",
    derivation: "organization-declaration",
    kind,
    label,
    detailChunkId: `detail:${id}`,
    declaredHostCapabilities: [],
    authoring: { action: "record-selection", supportedTargets: [] },
  };
}

function fixtureBundle(): AuthoringCatalogBundleV1 {
  const bundle = structuredClone(tinyStudioModel().workbenchBundle);
  for (const id of ["source:a", "source:b"]) {
    bundle.sources[id] = {
      id,
      distributor: { kind: "organization", locator: id },
      upstreamOrigin: { kind: "organization", locator: id },
      inputFormat: "organization-authoring-manifest/v1",
      revision: { id: "revision:1", contentDigest: digest },
      compiler: { id: "organization-manifest", version: "1" },
    };
  }
  bundle.assets["profile:alpha"] = asset("profile:alpha", "source:a", "profile");
  bundle.assets["profile:beta"] = asset("profile:beta", "source:b", "profile");
  bundle.assets["mcp:request"] = asset("mcp:request", "source:a", "mcp");
  bundle.sources["source:c"] = {
    id: "source:c",
    distributor: { kind: "organization", locator: "catalogs/Third source" },
    upstreamOrigin: { kind: "organization", locator: "catalogs/Third source" },
    inputFormat: "organization-authoring-manifest/v1",
    revision: { id: "revision:1", contentDigest: digest },
    compiler: { id: "organization-manifest", version: "1" },
  };
  bundle.sources["source:e"] = {
    id: "source:e",
    distributor: { kind: "organization", locator: "catalogs/Third source" },
    upstreamOrigin: { kind: "organization", locator: "catalogs/Third source" },
    inputFormat: "organization-authoring-manifest/v1",
    revision: { id: "revision:1", contentDigest: digest },
    compiler: { id: "organization-manifest", version: "1" },
  };
  bundle.sources["source:d"] = {
    id: "source:d",
    distributor: { kind: "organization", locator: "other/Third source" },
    upstreamOrigin: { kind: "organization", locator: "other/Third source" },
    inputFormat: "organization-authoring-manifest/v1",
    revision: { id: "revision:1", contentDigest: digest },
    compiler: { id: "organization-manifest", version: "1" },
  };
  bundle.sources[" source: padded "] = {
    id: " source: padded ",
    distributor: { kind: "organization", locator: "catalogs/Padded source" },
    upstreamOrigin: { kind: "organization", locator: "catalogs/Padded source" },
    inputFormat: "organization-authoring-manifest/v1",
    revision: { id: "revision:1", contentDigest: digest },
    compiler: { id: "organization-manifest", version: "1" },
  };
  bundle.assets["agent:padded"] = asset("agent:padded", " source: padded ", "agent");
  bundle.assets["agent:guide"] = asset("agent:guide", "source:c", "agent", "Guide agent");
  bundle.assets["agent:duplicate"] = asset(
    "agent:duplicate",
    "source:e",
    "agent",
    "Duplicate locator agent",
  );

  for (let index = 0; index < 55; index++) {
    const id = `skill:page-${String(index).padStart(2, "0")}`;
    bundle.assets[id] = asset(id, "source:c", "skill", `Page skill ${index}`);
  }
  return bundle;
}

describe("catalogBrowse", () => {
  it("discovers third-source and observed-kind facets from prepared bundle metadata", () => {
    const bundle = fixtureBundle();
    const browse = catalogBrowse(bundle, { sourceId: "source:c" });

    expect(catalogSourceDisplayName(bundle, "source:c")).toBe("catalogs/Third source (source:c)");
    expect(catalogSourceDisplayName(bundle, "source:e")).toBe("catalogs/Third source (source:e)");
    expect(catalogBrowse(bundle, { query: "source:e" }).pageAssetIds).toEqual(["agent:duplicate"]);
    expect(browse.total).toBe(56);
    expect(catalogBrowse(bundle, { sourceId: " source: padded " }).pageAssetIds).toEqual([
      "agent:padded",
    ]);
    expect(catalogBrowse(bundle, { sourceId: "source: padded" }).total).toBe(0);
    expect(browse.sourceOptions.map((option) => option.label)).toContain(
      "other/Third source (source:d)",
    );
    expect(browse.pageAssetIds).toContain("agent:guide");
    expect(browse.sourceOptions.find((option) => option.id === "source:c")).toMatchObject({
      label: "catalogs/Third source (source:c)",
      count: 56,
    });
    expect(browse.typeOptions.slice(0, 3).map((option) => option.id)).toEqual([
      "skill",
      "agent",
      "profile",
    ]);
    expect(browse.typeOptions.find((option) => option.id === "agent")).toMatchObject({ count: 1 });
    expect(browse.typeOptions.find((option) => option.id === "profile")).toMatchObject({
      count: 0,
    });
  });

  it("keeps facet counts scoped to the other filters and reports an empty type in a prepared source", () => {
    const bundle = fixtureBundle();
    const noAgentsInSourceB = catalogBrowse(bundle, {
      sourceId: "source:b",
      kind: "agent",
    });
    const matchingRequest = catalogBrowse(bundle, { query: "mcp:request" });

    expect(noAgentsInSourceB).toMatchObject({
      active: true,
      total: 0,
      pageAssetIds: [],
    });
    expect(matchingRequest.total).toBe(1);
    expect(matchingRequest.sourceOptions.find((option) => option.id === "source:a")).toMatchObject({
      count: 1,
    });
    expect(matchingRequest.sourceOptions.find((option) => option.id === "source:b")).toMatchObject({
      count: 0,
    });
  });

  it("pages filtered matches without expanding the entire prepared catalog", () => {
    const bundle = fixtureBundle();
    const firstPage = catalogBrowse(bundle, {
      sourceId: "source:c",
      kind: "skill",
      page: 0,
    });
    const secondPage = catalogBrowse(bundle, {
      sourceId: "source:c",
      kind: "skill",
      page: 1,
    });

    expect(firstPage).toMatchObject({ total: 55, page: 0, pageCount: 2 });
    expect(firstPage.pageAssetIds).toHaveLength(50);
    expect(secondPage).toMatchObject({ total: 55, page: 1, pageCount: 2 });
    expect(secondPage.pageAssetIds).toHaveLength(5);
  });
});
