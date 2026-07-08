import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBugbountyReport,
  parseBugbountyFindings,
  parseHistoricalBugbountySummary,
  summarizeBugbountyReport,
} from "../../src/internals/bugbounty-report.js";

describe("BUGBOUNTY reporting", () => {
  it("counts findings by category, severity, test status, and outcome", () => {
    const findings = parseBugbountyFindings(`
### BB-001 finding

- Area: src/internals
- Category: bug
- Severity: P1
- Test status: Unit
- Outcome: Fixed locally

### BB-002 finding

- Area: docs
- Lane: Documentation/evidence
- Severity: P2
- Test status: Docs-only
- Outcome: Finding drafted
`);

    expect(findings).toHaveLength(2);
    const root = mkdtempSync(join(tmpdir(), "aih-bugbounty-report-"));
    const source = join(root, "BUGBOUNTY.md");
    writeFileSync(
      source,
      `
### BB-001 finding

- Area: src/internals
- Category: bug
- Severity: P1
- Test status: Unit
- Outcome: Fixed locally

### BB-002 finding

- Area: docs
- Lane: Documentation/evidence
- Severity: P2
- Test status: Docs-only
- Outcome: Finding drafted
`,
    );

    const report = buildBugbountyReport(source);

    expect(report.counts).toMatchObject({
      total: 2,
      byCategory: { bug: 1, "Documentation/evidence": 1 },
      bySeverity: { P0: 0, P1: 1, P2: 1, P3: 0, Unspecified: 0 },
      byTestStatus: { Unit: 1, "Docs-only": 1 },
      byOutcome: { "Fixed locally": 1, "Finding drafted": 1 },
    });
  });

  it("treats a missing source as a non-mutating skipped report", () => {
    const report = buildBugbountyReport(join(tmpdir(), "missing-bugbounty.md"));

    expect(report.status).toBe("absent");
    expect(report.counts.total).toBe(0);
    expect(report.historical.fixedFindings).toBeUndefined();
  });

  it("ignores fenced finding templates", () => {
    const findings = parseBugbountyFindings(`
\`\`\`md
### BB-000 finding

- Area:
- Category:
- Severity: P0/P1/P2/P3
\`\`\`
`);

    expect(findings).toEqual([]);
  });

  it("parses historical campaign summary and fix-count tables separately", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-bugbounty-report-"));
    const source = join(root, "BUGBOUNTY.md");
    writeFileSync(
      source,
      `
## Final Campaign Close-out

- Outcomes at close: 19 \`Fixed locally\`, 0 \`No finding\`, 0 \`Deferred\`.
- Fixed findings recorded: 134 top-level independent ECC-agent findings fixed
  locally.
- Active rows at close: 0 Running, 0 Blocked.
`,
    );
    writeFileSync(
      join(root, "BUGBOUNTY_FIX_INVENTORY.md"),
      `
## Fix Counts

| Check | Area | Fixed findings |
| --- | --- | ---: |
| BB-001 | Execution, filesystem, rendering internals | 9 |
| BB-002 | Command registry and plugin dispatch | 7 |
`,
    );

    const report = buildBugbountyReport(source);

    expect(report.counts.total).toBe(0);
    expect(report.historical).toMatchObject({
      fixedFindings: 134,
      focusedChecks: 19,
      fixedLocallyRows: 19,
      runningRows: 0,
      blockedRows: 0,
      rows: [
        { id: "BB-001", area: "Execution, filesystem, rendering internals", fixedFindings: 9 },
        { id: "BB-002", area: "Command registry and plugin dispatch", fixedFindings: 7 },
      ],
    });
    expect(summarizeBugbountyReport(report)).toContain(
      "Historical fixed findings: 134 across 19 focused check(s).",
    );
  });

  it("sums historical fixed-count tables when no summary count is present", () => {
    const summary = parseHistoricalBugbountySummary(`
| Check | Area | Fixed findings |
| --- | --- | ---: |
| BB-001 | Execution | 2 |
| BB-002 | Docs | 3 |
`);

    expect(summary.fixedFindings).toBe(5);
    expect(summary.focusedChecks).toBe(2);
  });
});
