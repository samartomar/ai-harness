import { resolveDeveloperToolSelectionForOrgPolicyV1 } from "../org-policy/developer-tool-policy.js";
import type { OrgPolicy } from "../org-policy/schema.js";
import type { ResolvedDefaultToolSelection } from "../tools/default-tool-selection.js";
import type { McpServer } from "./servers.js";

const MCP_SERVER_BY_DEVELOPER_TOOL = {
  "code-review-graph": "code-review-graph",
  "codebase-memory-mcp": "codebase-memory-mcp",
  serena: "serena",
  context7: "context7",
} as const;

const DEFAULT_DEVELOPER_MCP_NAMES = new Set<string>(Object.values(MCP_SERVER_BY_DEVELOPER_TOOL));

export interface DefaultDeveloperMcpProjection {
  readonly servers: Record<string, McpServer>;
  /** Exact current generated entries omitted by the effective developer-tool decision. */
  readonly excludedServers: Record<string, McpServer>;
  readonly selection: ResolvedDefaultToolSelection;
}

/**
 * Apply the shared developer-tool decision only to its MCP-backed integrations.
 * Token Optimizer and MarkItDown CLI have separate setup and no default MCP name.
 * Unrelated catalog defaults remain intact.
 */
export function projectDefaultDeveloperMcpSelection(
  servers: Readonly<Record<string, McpServer>>,
  policy: OrgPolicy | undefined,
): DefaultDeveloperMcpProjection {
  const selection = resolveDeveloperToolSelectionForOrgPolicyV1(policy);
  const selectedMcpNames = new Set<string>(
    selection.selected.flatMap((id) => {
      const server = MCP_SERVER_BY_DEVELOPER_TOOL[id as keyof typeof MCP_SERVER_BY_DEVELOPER_TOOL];
      return server === undefined ? [] : [server];
    }),
  );
  return {
    selection,
    servers: Object.fromEntries(
      Object.entries(servers).filter(
        ([name]) => !DEFAULT_DEVELOPER_MCP_NAMES.has(name) || selectedMcpNames.has(name),
      ),
    ),
    excludedServers: Object.fromEntries(
      Object.entries(servers).filter(
        ([name]) => DEFAULT_DEVELOPER_MCP_NAMES.has(name) && !selectedMcpNames.has(name),
      ),
    ),
  };
}
