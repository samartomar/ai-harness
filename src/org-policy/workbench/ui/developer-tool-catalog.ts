import {
  DEFAULT_DEVELOPER_TOOL_IDS,
  type DeveloperToolId,
} from "../../../tools/default-tool-selection.js";
import type { CatalogBrowseInventory } from "../catalog-browse.js";
import type { AuthoringAssetV1 } from "../contracts.js";

const CATALOG_ASSET_IDS_BY_TOOL: Readonly<Record<DeveloperToolId, readonly string[]>> = {
  "code-review-graph": ["aih/code-review-graph", "ecc/mcp:code-review-graph"],
  "codebase-memory-mcp": ["aih/codebase-memory-mcp", "ecc/mcp:codebase-memory-mcp"],
  serena: ["aih/serena"],
  "token-optimizer": ["ecc/mcp:token-optimizer"],
  context7: ["aih/context7", "ecc/mcp:context7"],
  playwright: ["aih/playwright"],
  // The setup choice is the local CLI. The catalog's optional MCP is distinct.
  markitdown: [],
};

const SETUP_OWNED_CATALOG_ASSET_IDS = Object.freeze(
  Object.values(CATALOG_ASSET_IDS_BY_TOOL).flat(),
);
const SETUP_OWNED_CATALOG_ASSET_ID_SET = new Set(SETUP_OWNED_CATALOG_ASSET_IDS);

/** Exact catalog identities represented exclusively by Developer tool setup. */
export function developerToolCatalogAssetIds(): readonly string[] {
  return SETUP_OWNED_CATALOG_ASSET_IDS;
}

export function isDeveloperToolCatalogAssetId(assetId: string): boolean {
  return SETUP_OWNED_CATALOG_ASSET_ID_SET.has(assetId);
}

/** Browse-only projection. The authoritative bundle and saved pins stay intact. */
export function projectDeveloperToolCatalogInventory(
  inventory: CatalogBrowseInventory,
): CatalogBrowseInventory {
  return {
    sources: inventory.sources,
    assets: Object.fromEntries(
      Object.entries(inventory.assets).filter(
        ([assetId]) => !SETUP_OWNED_CATALOG_ASSET_ID_SET.has(assetId),
      ),
    ),
  };
}

/** Prefer first-party metadata, then an exact packaged duplicate when available. */
export function preferredDeveloperToolCatalogAssetId(
  toolId: DeveloperToolId,
  assets: Readonly<Record<string, AuthoringAssetV1 | undefined>>,
): string | undefined {
  return CATALOG_ASSET_IDS_BY_TOOL[toolId]?.find((assetId) => assets[assetId] !== undefined);
}

export function availableDeveloperToolCatalogDetails(
  assets: Readonly<Record<string, AuthoringAssetV1 | undefined>>,
): Readonly<Partial<Record<DeveloperToolId, string>>> {
  const available: Partial<Record<DeveloperToolId, string>> = {};
  for (const toolId of DEFAULT_DEVELOPER_TOOL_IDS) {
    const assetId = preferredDeveloperToolCatalogAssetId(toolId, assets);
    if (assetId !== undefined) available[toolId] = assetId;
  }
  return available;
}
