/** Pinned ECC MCP identity used by policy validation without loading Catalog data. */
export const ECC_MCP_CATALOG_PROVENANCE = {
  repository: "affaan-m/ECC",
  commit: "5064474d4d762dc9640234a41617cccb79185cec",
  path: "mcp-configs/mcp-servers.json",
  contentSha256: "d93be2b609a60035c7fdfc0b2bbeb228feb0a5f619c9de5ecf6b6d2acca5bd1f",
} as const;

export const AIH_OWNED_ECC_MCP_EXCLUSIONS = [
  "github",
  "sequential-thinking",
  "context7",
  "playwright",
] as const;
