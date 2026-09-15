import { MARKITDOWN_RUNTIME_PIN } from "../tools/markitdown-runtime.js";
import type { McpServer } from "./servers.js";

/** The optional upstream adapter is distinct from the default document CLI. */
export const MARKITDOWN_MCP_PIN = {
  package: "markitdown-mcp==0.0.1a7",
  converterPackage: `markitdown[all]==${MARKITDOWN_RUNTIME_PIN.version}`,
  // Upstream's [all] extra requires a preview distribution; pin that exception explicitly.
  azureContentUnderstandingPackage: "azure-ai-contentunderstanding==1.2.0b3",
  wheelSha256: "e38dce929a28b210a936396c4e1546b30b02601667c79dfa104afd6a7e3b818b",
} as const;

export function optionalMarkItDownMcpServer(): McpServer {
  return {
    type: "stdio",
    command: "uvx",
    args: [
      "--no-config",
      "--no-python-downloads",
      "--no-env-file",
      "--with",
      MARKITDOWN_MCP_PIN.converterPackage,
      "--with",
      MARKITDOWN_MCP_PIN.azureContentUnderstandingPackage,
      MARKITDOWN_MCP_PIN.package,
    ],
    description:
      "Optional Microsoft MarkItDown MCP adapter. Converts user-selected local files and URLs to Markdown with the current user's access. Its first launch acquires packages; it is independent of the default MarkItDown CLI selection.",
    classification: "local",
    egress: "third-party",
    credentials: "none",
    supplyChain: "pinned",
  };
}
