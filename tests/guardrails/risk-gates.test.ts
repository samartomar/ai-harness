import { describe, expect, it } from "vitest";
import {
  APPROVAL_SOURCES,
  RISK_GATES,
  riskGatesDoc,
  riskGatesJson,
} from "../../src/guardrails/risk-gates.js";

const NAMES = [
  "auth_rewrite",
  "payment_logic",
  "destructive_migration",
  "new_dependency",
  "public_api_break",
  "broad_refactor",
  "security_sensitive_change",
];

const gate = (name: string) => RISK_GATES.find((g) => g.name === name);

describe("RISK_GATES data", () => {
  it("has exactly the 7 named categories", () => {
    expect(RISK_GATES).toHaveLength(7);
    expect(RISK_GATES.map((g) => g.name).sort()).toEqual([...NAMES].sort());
  });

  it("ask-not-deny invariant: every gate behavior is 'ask'", () => {
    for (const g of RISK_GATES) {
      expect(g.behavior).toBe("ask");
    }
  });

  it("ports the path/command patterns verbatim (spot checks)", () => {
    expect(gate("auth_rewrite")?.pathPatterns).toContain("**/auth/**");
    expect(gate("payment_logic")?.pathPatterns).toContain("**/billing/**");
    expect(gate("destructive_migration")?.commandPatterns).toContain("*drop*");
    expect(gate("new_dependency")?.pathPatterns).toContain("package.json");
    expect(gate("new_dependency")?.pathPatterns).toContain("Cargo.toml");
    expect(gate("public_api_break")?.pathPatterns).toContain("**/api/**");
    expect(gate("security_sensitive_change")?.commandPatterns).toContain("*chmod 777*");
  });

  it("broad_refactor has no patterns (heuristic/explicit trigger only)", () => {
    expect(gate("broad_refactor")?.pathPatterns).toEqual([]);
    expect(gate("broad_refactor")?.commandPatterns).toEqual([]);
  });
});

describe("riskGatesJson() — CI-checkable sidecar", () => {
  it("is valid JSON and includes version, gates, and approvalSources", () => {
    const json = JSON.parse(JSON.stringify(riskGatesJson())) as {
      version: string;
      gates: unknown[];
      approvalSources: string[];
    };
    expect(json.version).toBeTruthy();
    expect(json.gates).toHaveLength(7);
    expect(json.approvalSources).toEqual([...APPROVAL_SOURCES]);
  });
});

describe("riskGatesDoc()", () => {
  it("is deterministic and says it runs in YOUR CI (ask-not-deny boundary)", () => {
    const doc = riskGatesDoc();
    expect(doc).toBe(riskGatesDoc());
    expect(doc).toContain("YOUR CI");
    for (const name of NAMES) {
      expect(doc).toContain(name);
    }
  });
});
