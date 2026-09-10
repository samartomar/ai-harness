import { ECC_INSTALL_TARGETS } from "../ecc/install-targets.js";
import { WIRED_MATERIALIZATION_TARGETS } from "../ecc/materialization-target.js";
import { entry, GOVERNED_MCP_TARGETS, GOVERNED_USAGE_TARGETS } from "./cli-registry.js";
import type { Cli } from "./clis.js";

/** Supported operations, independent of installed configuration or runtime proof. */
export interface CliCapabilities {
  genericMcp: boolean;
  governedMcp: boolean;
  eccInstall: boolean;
  governedEcc: boolean;
  governedUsage: boolean;
  contextVerification: "manual" | "command";
  mcpContract?: string;
  requirements: string[];
}

export function cliCapabilities(cli: Cli): CliCapabilities {
  const profile = entry(cli);
  const requirements = [
    "Installed runtime version is unverified; configuration support does not prove host consumption.",
  ];
  if (profile.mcp.governed) {
    requirements.push(
      `MCP contract: ${profile.mcp.governed.contract}; governed built-in distribution supports stdio only.`,
    );
  }
  if (cli === "opencode")
    requirements.push(
      "OpenCode V1 only; V2 and ambiguous alternate configuration require a compatible adapter.",
    );
  if (cli === "kimi")
    requirements.push(
      "Kimi Code only; legacy Kimi is unsupported. Trust the workspace and start a new session after adding MCP configuration.",
    );
  if (cli === "kiro")
    requirements.push(
      "Kiro custom agents may override workspace MCP. Standalone hooks require ide1-cli3; CLI2 remains advisory.",
    );
  if (cli === "claude")
    requirements.push(
      "Claude managed settings require administrator deployment; project MCP discovery does not verify managed enforcement.",
    );
  if (cli === "cursor" || cli === "copilot" || cli === "codex")
    requirements.push(
      "Workspace trust and host tool approvals can prevent configured MCP servers from running.",
    );
  return {
    genericMcp: profile.mcp.support === "native",
    governedMcp: (GOVERNED_MCP_TARGETS as readonly string[]).includes(cli),
    eccInstall: (ECC_INSTALL_TARGETS as readonly string[]).includes(cli),
    governedEcc: (WIRED_MATERIALIZATION_TARGETS as readonly string[]).includes(cli),
    governedUsage: (GOVERNED_USAGE_TARGETS as readonly string[]).includes(cli),
    contextVerification: profile.dryRunProbe.kind,
    ...(profile.mcp.governed ? { mcpContract: profile.mcp.governed.contract } : {}),
    requirements,
  };
}

export function cliCapabilitySummary(cli: Cli, support = cliCapabilities(cli)): string {
  const state = (supported: boolean) => (supported ? "supported" : "unsupported");
  return `${cli}: MCP generic ${state(support.genericMcp)}, governed ${state(support.governedMcp)}; ECC install ${state(support.eccInstall)}, governed ${state(support.governedEcc)}; governed usage ${state(support.governedUsage)}; context verification ${support.contextVerification}`;
}
