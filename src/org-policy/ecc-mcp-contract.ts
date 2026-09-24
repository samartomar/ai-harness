/** Pinned ECC MCP identity used by policy validation without loading Catalog data. */
export const ECC_MCP_CATALOG_PROVENANCE = {
  repository: "affaan-m/ECC",
  commit: "5caf398a91599029a176ca6d806409b00d1052c4",
  path: "mcp-configs/mcp-servers.json",
  contentSha256: "a4426254c55a5352db2672bc86a87f10b0029f5e4ae1b74817841e87d9ab1e57",
} as const;

export const AIH_OWNED_ECC_MCP_EXCLUSIONS = [
  "github",
  "sequential-thinking",
  "context7",
  "playwright",
] as const;
