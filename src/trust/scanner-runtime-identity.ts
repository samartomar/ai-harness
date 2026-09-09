import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Keep immutable analyzer identities independent of detector execution and policy imports.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const trustScannerRootCandidates = [
  resolve(moduleDir, "..", "tools", "trust-scanners"),
  resolve(moduleDir, "..", "..", "tools", "trust-scanners"),
] as const;
const TRUST_SCANNERS_ROOT =
  trustScannerRootCandidates.find((candidate) => existsSync(candidate)) ??
  trustScannerRootCandidates[0];
const ciscoSkillScannerProjectCandidates = [
  resolve(moduleDir, "..", "tools", "cisco-skill-scanner"),
  resolve(moduleDir, "..", "..", "tools", "cisco-skill-scanner"),
] as const;
export const CISCO_SKILL_SCANNER_PROJECT =
  ciscoSkillScannerProjectCandidates.find((candidate) => existsSync(join(candidate, "uv.lock"))) ??
  ciscoSkillScannerProjectCandidates[0];
export const CISCO_MCP_SCANNER_PROJECT = join(TRUST_SCANNERS_ROOT, "cisco-mcp");
export const SEMGREP_PROJECT = join(TRUST_SCANNERS_ROOT, "semgrep");
export const SNYK_AGENT_SCAN_PROJECT = join(TRUST_SCANNERS_ROOT, "snyk-agent-scan");
export const CISCO_SKILL_SCANNER_VERSION = "2.0.14";
export const CISCO_MCP_SCANNER_VERSION = "4.8.2";
export const SEMGREP_VERSION = "1.173.0";
export const SNYK_AGENT_SCAN_VERSION = "0.5.17";
export const CISCO_SKILL_SCANNER_ANALYZER = "cisco@uvx";
export const CISCO_MCP_SCANNER_ANALYZER = `mcp-scanner@uv:${CISCO_MCP_SCANNER_VERSION}`;
export const SEMGREP_ANALYZER = `semgrep@uv:${SEMGREP_VERSION}`;
export const SNYK_AGENT_SCAN_ANALYZER = `snyk-agent-scan@uv:${SNYK_AGENT_SCAN_VERSION}`;
