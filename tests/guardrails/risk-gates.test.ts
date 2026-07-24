import { describe, expect, it } from "vitest";
import {
  APPROVAL_SOURCES,
  RISK_GATES,
  riskGatesDoc,
  riskGatesJson,
  riskGatesTouched,
  riskGatesWorkflowYaml,
} from "../../src/guardrails/risk-gates.js";
import { scaWorkflowYaml } from "../../src/guardrails/sca.js";

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

  it("describes the generated workflow consumer, not a wire-it-yourself TODO", () => {
    const doc = riskGatesDoc();
    expect(doc).toContain(".github/workflows/risk-gates.yml");
    expect(doc).toContain("never fails the build");
  });
});

describe("riskGatesTouched() — TS mirror of the generated workflow's matcher", () => {
  const names = (paths: string[]) => riskGatesTouched(paths).map((t) => t.name);

  it("maps a PR's changed paths to the gates the workflow would surface", () => {
    const touched = riskGatesTouched(["src/auth/login.ts", "package.json", "docs/guide.md"]);
    expect(touched.map((t) => t.name)).toEqual(["auth_rewrite", "new_dependency"]);
    expect(touched.find((t) => t.name === "auth_rewrite")?.paths).toEqual(["src/auth/login.ts"]);
    expect(touched.find((t) => t.name === "new_dependency")?.paths).toEqual(["package.json"]);
  });

  it("`**/` matches zero directories: root-level auth files still trigger auth_rewrite", () => {
    expect(names(["auth/session-store.ts"])).toContain("auth_rewrite");
    expect(names(["oauth.ts"])).toContain("auth_rewrite"); // **/*auth* at repo root
  });

  it("one changed path can trigger multiple gates", () => {
    const hit = names(["src/api/token-schema.ts"]);
    expect(hit).toContain("public_api_break"); // **/api/**
    expect(hit).toContain("security_sensitive_change"); // **/*token*
  });

  it("destructive_migration triggers on migration dirs and schema files", () => {
    expect(names(["db/migrations/0001_drop.sql"])).toContain("destructive_migration");
    expect(names(["schema.prisma"])).toContain("destructive_migration"); // **/schema.* at root
  });

  it("broad_refactor never triggers from paths (heuristic-only gate)", () => {
    expect(names(["a.ts", "src/x/y.ts", "auth/x.ts", "package.json"])).not.toContain(
      "broad_refactor",
    );
  });

  it("docs-only changes trigger no gates and an empty diff is clean", () => {
    expect(riskGatesTouched(["README.md", "docs/guide.md"])).toEqual([]);
    expect(riskGatesTouched([])).toEqual([]);
  });

  it("path patterns carry no whitespace (the workflow space-joins them via jq)", () => {
    for (const g of RISK_GATES) {
      for (const p of g.pathPatterns) {
        expect(p).not.toMatch(/\s/);
      }
    }
  });

  it("gate path patterns use NO bracket expressions (F4: mirror escapes [abc], bash wouldn't)", () => {
    // The TS mirror escapes `[`/`]` to literals; a bash `case` treats them as a
    // char class. A future bracket pattern would silently desync mirror vs shell,
    // so forbid them at the source (mirrors the no-whitespace guard above).
    for (const g of RISK_GATES) {
      for (const p of g.pathPatterns) {
        expect(p).not.toMatch(/[[\]]/);
      }
    }
  });
});

describe("riskGatesWorkflowYaml() — the generated CI consumer", () => {
  const yaml = riskGatesWorkflowYaml(".ai-context/risk-gates.json");

  it("is a managed, PR-only workflow whose job name matches the sidecar checkName", () => {
    expect(yaml.split("\n")[0]).toContain("managed by aih guardrails");
    expect(yaml).toContain("name: risk-gates");
    const checkName = (riskGatesJson() as { ci: { checkName: string } }).ci.checkName;
    expect(yaml).toContain(`\n  ${checkName}:`);
    expect(yaml).toContain("pull_request:");
    expect(yaml).not.toContain("push:");
    expect(yaml).toContain("contents: read");
  });

  it("consumes the sidecar it is pointed at (jq over .gates[])", () => {
    expect(yaml).toContain("SIDECAR: .ai-context/risk-gates.json");
    expect(yaml).toContain("jq -r");
    expect(yaml).toContain(".gates[]");
    expect(yaml).toContain("pathPatterns");
    // A custom context dir rewires the consumer to the matching sidecar path.
    expect(riskGatesWorkflowYaml(".context/risk-gates.json")).toContain(
      "SIDECAR: .context/risk-gates.json",
    );
  });

  it("disables globbing as an ACTIVE line before matching (F3a: not a comment substring)", () => {
    // `set -f` must be a real statement (exact trimmed line, never text inside a
    // comment) and must run before the first pattern-match `case`, or an unquoted
    // $pattern word would expand against the checkout instead of matching the diff.
    const scriptLines = yaml.split("\n").map((line) => line.trim());
    const noglobIndex = scriptLines.indexOf("set -f");
    expect(noglobIndex).toBeGreaterThanOrEqual(0);
    const firstCaseIndex = scriptLines.findIndex((line) =>
      line.startsWith('case "$path" in $pattern)'),
    );
    expect(firstCaseIndex).toBeGreaterThan(noglobIndex);
  });

  it("strips a trailing CR from both field reads so CRLF sidecars/diffs still match (F3b)", () => {
    // jq/git may write CRLF; without the strip a \r glues onto the last pattern or
    // path token and the match silently fails. The TS mirror doesn't model CRLF,
    // so pin the shell strip on BOTH reads directly (neutering either goes red).
    const scriptLines = yaml.split("\n").map((line) => line.trim());
    // Distinct substrings of `${patterns%$'\r'}` / `${path%$'\r'}` — the `%$'\r'}`
    // suffix only exists as part of the CR-strip parameter expansion.
    expect(scriptLines.some((line) => line.includes("patterns%$'\\r'}"))).toBe(true);
    expect(scriptLines.some((line) => line.includes("path%$'\\r'}"))).toBe(true);
  });

  it("ask-not-deny: warns and summarizes but never fails on a touched gate", () => {
    expect(yaml).toContain("::warning::");
    expect(yaml).toContain("GITHUB_STEP_SUMMARY");
    // The only non-zero exit is the malformed-sidecar infrastructure guard; a
    // touched gate never produces one (grading: warn at every posture).
    const exitOneLines = yaml.split("\n").filter((line) => line.includes("exit 1"));
    expect(exitOneLines).toHaveLength(1);
    expect(exitOneLines[0]).toContain("not valid JSON");
    // A missing sidecar is a notice + clean exit, not a failure.
    expect(yaml).toContain("exit 0");
  });

  it("SHA-pins actions and shares the exact checkout pin with the SCA workflow", () => {
    expect(yaml).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v/);
    const pin = (source: string) => source.match(/actions\/checkout@[0-9a-f]{40} # v[\w.]+/g);
    const scaPins = pin(scaWorkflowYaml()) ?? [];
    const riskPins = pin(yaml) ?? [];
    expect(riskPins).toHaveLength(1);
    expect(new Set([...scaPins, ...riskPins]).size).toBe(1);
  });
});
