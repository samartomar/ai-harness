import { describe, expect, it } from "vitest";
import { remediationBlock } from "../../src/report/render.js";

describe("remediationBlock — copy-pasteable remediation commands", () => {
  it("puts each command on its OWN bare indented line (no `→`/label gluing the line)", () => {
    const out = remediationBlock("  To close 1 gap:", [
      { command: "aih mcp --apply --cli opencode", label: "opencode-mcp" },
    ]);
    expect(out[0]).toBe("  To close 1 gap:");
    // The command line starts with whitespace then the command verbatim — pasteable.
    expect(out[1]).toMatch(/^ {4}aih mcp --apply --cli opencode {2}# opencode-mcp$/);
    // No arrow or "label:" prefix anywhere on the runnable line.
    expect(out[1]).not.toContain("→");
    expect(out[1]?.trimStart().startsWith("aih ")).toBe(true);
  });

  it("uses a trailing `# label` shell comment (ignored by PowerShell AND bash)", () => {
    const [, line] = remediationBlock("h", [{ command: "aih tools --apply", label: "tools" }]);
    // The command comes first; everything from `#` on is a comment, so the whole line
    // runs verbatim in both shells.
    expect(line).toMatch(/^ {4}aih tools --apply\s+# tools$/);
  });

  it("strips a `run: ` prefix from the remediation", () => {
    const [, line] = remediationBlock("h", [{ command: "run: aih scaffold --apply" }]);
    expect(line?.trim()).toBe("aih scaffold --apply");
  });

  it("dedupes by command, joining the labels of gaps that share one fix", () => {
    const out = remediationBlock("h", [
      { command: "aih guardrails --apply", label: "gitleaks" },
      { command: "aih guardrails --apply", label: "pre-commit" },
    ]);
    expect(out).toHaveLength(2); // header + ONE command line
    expect(out[1]).toContain("aih guardrails --apply");
    expect(out[1]).toContain("# gitleaks, pre-commit");
  });

  it("aligns the `#` comments into a column across commands of different lengths", () => {
    const out = remediationBlock("h", [
      { command: "aih mcp --apply --cli opencode", label: "a" },
      { command: "aih tools", label: "b" },
    ]);
    const hashCols = out.slice(1).map((l) => l.indexOf("#"));
    expect(hashCols[0]).toBe(hashCols[1]); // same column → aligned
  });

  it("returns [] when there are no commands to run", () => {
    expect(remediationBlock("h", [])).toEqual([]);
    expect(remediationBlock("h", [{ command: "   " }])).toEqual([]);
  });
});
