import { describe, expect, it } from "vitest";
import type { AuthoringAssetV1 } from "../../../src/org-policy/workbench/contracts.js";
import {
  availableDeveloperToolCatalogDetails,
  developerToolCatalogAssetIds,
  preferredDeveloperToolCatalogAssetId,
  projectDeveloperToolCatalogInventory,
} from "../../../src/org-policy/workbench/ui/developer-tool-catalog.js";

const digest = `sha256:${"d".repeat(64)}`;

function asset(id: string, label = id): AuthoringAssetV1 {
  return {
    id,
    sourceId: id.startsWith("ecc/") ? "source:ecc" : "source:aih",
    sourceRevisionId: "revision:1",
    contentDigest: digest,
    originalPath: "catalog.json",
    derivation: "organization-declaration",
    kind: "mcp",
    label,
    detailChunkId: `detail:${id}`,
    declaredHostCapabilities: [],
    authoring: { action: "record-selection", supportedTargets: [] },
  };
}

describe("developer-tool catalog projection", () => {
  it("maps setup-owned tools to exact first-party and ECC catalog identities", () => {
    expect(developerToolCatalogAssetIds()).toEqual([
      "aih/code-review-graph",
      "ecc/mcp:code-review-graph",
      "aih/codebase-memory-mcp",
      "ecc/mcp:codebase-memory-mcp",
      "aih/serena",
      "ecc/mcp:token-optimizer",
      "aih/context7",
      "ecc/mcp:context7",
      "aih/playwright",
    ]);
  });

  it("removes only exact setup-owned assets from browse inventory", () => {
    const hidden = asset("aih/context7", "Context7");
    const hiddenDuplicate = asset("ecc/mcp:context7", "Context7");
    const customWithSameLabel = asset("custom/context7", "Context7");
    const optionalMarkItDownMcp = asset("aih/markitdown", "MarkItDown MCP");
    const inventory = projectDeveloperToolCatalogInventory({
      sources: {},
      assets: Object.fromEntries(
        [hidden, hiddenDuplicate, customWithSameLabel, optionalMarkItDownMcp].map((item) => [
          item.id,
          item,
        ]),
      ),
    });

    expect(Object.keys(inventory.assets)).toEqual(["custom/context7", "aih/markitdown"]);
  });

  it("chooses the preferred available metadata asset without treating MarkItDown MCP as its CLI", () => {
    const firstParty = asset("aih/context7");
    const duplicate = asset("ecc/mcp:context7");
    const playwright = asset("aih/playwright");
    const tokenOptimizer = asset("ecc/mcp:token-optimizer");
    const markItDownMcp = asset("aih/markitdown");
    const assets = {
      [duplicate.id]: duplicate,
      [firstParty.id]: firstParty,
      [playwright.id]: playwright,
      [tokenOptimizer.id]: tokenOptimizer,
      [markItDownMcp.id]: markItDownMcp,
    };

    expect(preferredDeveloperToolCatalogAssetId("context7", assets)).toBe("aih/context7");
    expect(preferredDeveloperToolCatalogAssetId("markitdown", assets)).toBeUndefined();
    expect(availableDeveloperToolCatalogDetails(assets)).toMatchObject({
      context7: "aih/context7",
      playwright: "aih/playwright",
      "token-optimizer": "ecc/mcp:token-optimizer",
    });
  });
});
