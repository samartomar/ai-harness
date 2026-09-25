// Core's analyzer labels: the names `analyzersRun`, baseline receipts and
// normalization record for each third-party detector Scan executes. They are
// identifiers, not execution: the analyzer projects, their locks and every
// runtime live in @aihq/scan.
export const CISCO_SKILL_SCANNER_VERSION = "2.1.0";
export const CISCO_MCP_SCANNER_VERSION = "4.8.4";
export const SEMGREP_VERSION = "1.178.0";
export const SNYK_AGENT_SCAN_VERSION = "0.6.4";
export const CISCO_SKILL_SCANNER_ANALYZER = "cisco@uvx";
export const CISCO_MCP_SCANNER_ANALYZER = `mcp-scanner@uv:${CISCO_MCP_SCANNER_VERSION}`;
export const SEMGREP_ANALYZER = `semgrep@uv:${SEMGREP_VERSION}`;
export const SNYK_AGENT_SCAN_ANALYZER = `snyk-agent-scan@uv:${SNYK_AGENT_SCAN_VERSION}`;
