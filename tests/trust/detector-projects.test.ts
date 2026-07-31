import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CISCO_MCP_SCANNER_PROJECT,
  CISCO_SKILL_SCANNER_PROJECT,
  SEMGREP_PROJECT,
  SNYK_AGENT_SCAN_PROJECT,
} from "../../src/trust/detectors.js";

describe("detector project roots", () => {
  it("can load the detector module directly without a circular initialization failure", () => {
    expect(basename(CISCO_SKILL_SCANNER_PROJECT)).toBe("cisco-skill-scanner");
    expect(basename(CISCO_MCP_SCANNER_PROJECT)).toBe("cisco-mcp");
    expect(basename(SEMGREP_PROJECT)).toBe("semgrep");
    expect(basename(SNYK_AGENT_SCAN_PROJECT)).toBe("snyk-agent-scan");
  });
});
