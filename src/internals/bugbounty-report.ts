import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type BountySeverity = "P0" | "P1" | "P2" | "P3" | "Unspecified";

export interface BountyFinding {
  id: string;
  area: string;
  category: string;
  severity: BountySeverity;
  testStatus: string;
  outcome: string;
}

export interface HistoricalBountyRow {
  id: string;
  area: string;
  fixedFindings: number;
}

export interface HistoricalBountySummary {
  focusedChecks: number | undefined;
  fixedFindings: number | undefined;
  fixedLocallyRows: number | undefined;
  runningRows: number | undefined;
  blockedRows: number | undefined;
  rows: HistoricalBountyRow[];
}

export interface BountyReport {
  source: string;
  status: "ok" | "absent";
  findings: BountyFinding[];
  historical: HistoricalBountySummary;
  counts: {
    total: number;
    byCategory: Record<string, number>;
    bySeverity: Record<BountySeverity, number>;
    byTestStatus: Record<string, number>;
    byOutcome: Record<string, number>;
  };
}

const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

function field(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`^-\\s*${name}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

function normalizeSeverity(value: string | undefined): BountySeverity {
  return value !== undefined && SEVERITIES.has(value) ? (value as BountySeverity) : "Unspecified";
}

function countBy<T extends string>(
  items: readonly BountyFinding[],
  select: (item: BountyFinding) => T,
): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const item of items) {
    const key = select(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function emptyHistoricalSummary(): HistoricalBountySummary {
  return {
    focusedChecks: undefined,
    fixedFindings: undefined,
    fixedLocallyRows: undefined,
    runningRows: undefined,
    blockedRows: undefined,
    rows: [],
  };
}

interface CurrentLedgerSummary {
  fixedLocallyRows: number;
  runningRows: number;
  blockedRows: number;
}

function numberFrom(pattern: RegExp, markdown: string): number | undefined {
  const raw = markdown.match(pattern)?.[1];
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function parseHistoricalRows(markdown: string): HistoricalBountyRow[] {
  const rows: HistoricalBountyRow[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const cells = line
      .trim()
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const [id, area, count] = cells;
    if (!id || !area || !count || !/^BB-\d{3}$/.test(id)) continue;
    const fixedFindings = Number.parseInt(count.replace(/[^0-9]/g, ""), 10);
    if (!Number.isFinite(fixedFindings)) continue;
    rows.push({ id, area, fixedFindings });
  }
  return rows;
}

function normalizeTableCell(value: string | undefined): string {
  return (value ?? "").replace(/`/g, "").trim();
}

function parseCurrentLedgerSummary(markdown: string): CurrentLedgerSummary | undefined {
  const sectionStart = markdown.search(/^##\s+Current Run Ledger\s*$/im);
  if (sectionStart < 0) return undefined;
  const afterHeading = markdown.slice(sectionStart).replace(/^##\s+Current Run Ledger\s*$/im, "");
  const nextHeading = afterHeading.search(/^#{2,3}\s+/m);
  const section = nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
  let rowCount = 0;
  let fixedLocallyRows = 0;
  let runningRows = 0;
  let blockedRows = 0;
  for (const line of section.split(/\r?\n/)) {
    const cells = line
      .trim()
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 8 || !/^BB-\d{3}$/.test(cells[0] ?? "")) continue;
    rowCount += 1;
    const status = normalizeTableCell(cells[3]);
    const outcome = normalizeTableCell(cells[7]);
    if (status === "Running") runningRows += 1;
    if (status === "Blocked") blockedRows += 1;
    if (outcome === "Fixed locally") fixedLocallyRows += 1;
  }
  return rowCount > 0 ? { fixedLocallyRows, runningRows, blockedRows } : undefined;
}

export function parseHistoricalBugbountySummary(markdown: string): HistoricalBountySummary {
  const withoutFencedExamples = markdown.replace(/```[\s\S]*?```/g, "");
  const rows = parseHistoricalRows(withoutFencedExamples);
  const currentLedger = parseCurrentLedgerSummary(withoutFencedExamples);
  const rowFixedFindings = rows.reduce((sum, row) => sum + row.fixedFindings, 0);
  const fixedLocallyRows =
    currentLedger?.fixedLocallyRows ??
    numberFrom(/Outcomes at close:\s*(\d+)\s+`Fixed locally`/i, withoutFencedExamples);
  const runningRows =
    currentLedger?.runningRows ??
    numberFrom(/Active rows at close:\s*(\d+)\s+Running/i, withoutFencedExamples) ??
    numberFrom(
      /Active statuses at close:\s*\d+\s+`Available`,\s*(\d+)\s+`Running`/i,
      withoutFencedExamples,
    ) ??
    numberFrom(/Open blockers at campaign close\s*\|\s*(\d+)\s+Running/i, withoutFencedExamples);
  const blockedRows =
    currentLedger?.blockedRows ??
    numberFrom(
      /Active rows at close:\s*\d+\s+Running,\s*(\d+)\s+Blocked/i,
      withoutFencedExamples,
    ) ??
    numberFrom(
      /Active statuses at close:\s*\d+\s+`Available`,\s*\d+\s+`Running`,\s*(\d+)\s+`Blocked`/i,
      withoutFencedExamples,
    ) ??
    numberFrom(
      /Open blockers at campaign close\s*\|\s*\d+\s+Running\s*\/\s*(\d+)\s+Blocked/i,
      withoutFencedExamples,
    );
  const fixedFindings =
    numberFrom(/Fixed findings recorded:\s*(\d+)/i, withoutFencedExamples) ??
    (rowFixedFindings > 0 ? rowFixedFindings : undefined);
  const focusedChecks =
    numberFrom(/Focused checks completed:\s*(\d+)/i, withoutFencedExamples) ??
    (rows.length > 0 ? rows.length : fixedLocallyRows);
  return {
    focusedChecks,
    fixedFindings,
    fixedLocallyRows,
    runningRows,
    blockedRows,
    rows,
  };
}

function mergeHistoricalSummaries(
  primary: HistoricalBountySummary,
  secondary: HistoricalBountySummary,
): HistoricalBountySummary {
  return {
    focusedChecks: primary.focusedChecks ?? secondary.focusedChecks,
    fixedFindings: primary.fixedFindings ?? secondary.fixedFindings,
    fixedLocallyRows: primary.fixedLocallyRows ?? secondary.fixedLocallyRows,
    runningRows: primary.runningRows ?? secondary.runningRows,
    blockedRows: primary.blockedRows ?? secondary.blockedRows,
    rows: primary.rows.length > 0 ? primary.rows : secondary.rows,
  };
}

export function parseBugbountyFindings(markdown: string): BountyFinding[] {
  const withoutFencedExamples = markdown.replace(/```[\s\S]*?```/g, "");
  const parts = withoutFencedExamples.split(/^###\s+(BB-\d+)\s+finding\s*$/gim);
  const findings: BountyFinding[] = [];
  for (let index = 1; index < parts.length; index += 2) {
    const id = parts[index] ?? "BB-000";
    const block = parts[index + 1] ?? "";
    findings.push({
      id,
      area: field(block, "Area") ?? "Unspecified",
      category: field(block, "Category") ?? field(block, "Lane") ?? "Unspecified",
      severity: normalizeSeverity(field(block, "Severity")),
      testStatus: field(block, "Test status") ?? "Unspecified",
      outcome: field(block, "Outcome") ?? "Finding drafted",
    });
  }
  return findings;
}

export function buildBugbountyReport(source: string): BountyReport {
  if (!existsSync(source)) {
    return {
      source,
      status: "absent",
      findings: [],
      historical: emptyHistoricalSummary(),
      counts: {
        total: 0,
        byCategory: {},
        bySeverity: { P0: 0, P1: 0, P2: 0, P3: 0, Unspecified: 0 },
        byTestStatus: {},
        byOutcome: {},
      },
    };
  }
  const markdown = readFileSync(source, "utf8");
  const inventorySource = join(dirname(source), "BUGBOUNTY_FIX_INVENTORY.md");
  const historical = mergeHistoricalSummaries(
    parseHistoricalBugbountySummary(markdown),
    existsSync(inventorySource)
      ? parseHistoricalBugbountySummary(readFileSync(inventorySource, "utf8"))
      : emptyHistoricalSummary(),
  );
  const findings = parseBugbountyFindings(markdown);
  return {
    source,
    status: "ok",
    findings,
    historical,
    counts: {
      total: findings.length,
      byCategory: countBy(findings, (item) => item.category),
      bySeverity: {
        P0: findings.filter((item) => item.severity === "P0").length,
        P1: findings.filter((item) => item.severity === "P1").length,
        P2: findings.filter((item) => item.severity === "P2").length,
        P3: findings.filter((item) => item.severity === "P3").length,
        Unspecified: findings.filter((item) => item.severity === "Unspecified").length,
      },
      byTestStatus: countBy(findings, (item) => item.testStatus),
      byOutcome: countBy(findings, (item) => item.outcome),
    },
  };
}

export function summarizeBugbountyReport(report: BountyReport): string {
  if (report.status === "absent") {
    return `BUGBOUNTY report skipped: source not present (${report.source}).`;
  }
  const categories = Object.entries(report.counts.byCategory)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const severities = Object.entries(report.counts.bySeverity)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const historical =
    report.historical.fixedFindings !== undefined
      ? ` Historical fixed findings: ${report.historical.fixedFindings}${report.historical.focusedChecks !== undefined ? ` across ${report.historical.focusedChecks} focused check(s)` : ""}.`
      : "";
  return `BUGBOUNTY report parsed ${report.counts.total} structured finding block(s). Categories: ${categories || "none"}. Severities: ${severities}.${historical}`;
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const source = argValue(argv, "--source") ?? ".internal/defects/BUGBOUNTY.md";
  const report = buildBugbountyReport(source);
  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(summarizeBugbountyReport(report));
  return 0;
}

if (basename(process.argv[1] ?? "") === "bugbounty-report.ts") {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
    });
}
