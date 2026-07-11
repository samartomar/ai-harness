import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  baselineAnalyzerVersions,
  REQUIRED_BASELINE_ANALYZERS,
  requiredBaselineAnalyzersForComponent,
} from "../baseline-evidence/analyzer-profile.js";
import type { BaselineEvidenceLock } from "../baseline-evidence/schema.js";
import { readVendorBaselineLock } from "../baseline-evidence/vendor.js";

export interface BaselineAnalyzerFinding {
  sourceId: string;
  componentId: string;
  detail: string;
}

export interface BaselineAnalyzerReport {
  ok: boolean;
  findings: BaselineAnalyzerFinding[];
}

export function checkBaselineAnalyzerReceipts(lock: BaselineEvidenceLock): BaselineAnalyzerReport {
  const expectedVersions = baselineAnalyzerVersions();
  const findings: BaselineAnalyzerFinding[] = [];

  for (const source of lock.sources) {
    for (const component of source.components) {
      const actual = new Map(component.analyzers.map((receipt) => [receipt.name, receipt.version]));
      for (const name of requiredBaselineAnalyzersForComponent(component)) {
        const expected = expectedVersions[name] ?? "";
        const found = actual.get(name);
        if (found === undefined) {
          findings.push({
            sourceId: source.id,
            componentId: component.id,
            detail: `missing ${name}@${expected}`,
          });
        } else if (found !== expected) {
          findings.push({
            sourceId: source.id,
            componentId: component.id,
            detail: `expected ${name}@${expected}, found ${found}`,
          });
        }
        actual.delete(name);
      }
      for (const [name, version] of [...actual].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        findings.push({
          sourceId: source.id,
          componentId: component.id,
          detail: `unexpected ${name}@${version}`,
        });
      }
    }
  }

  return { ok: findings.length === 0, findings };
}

function main(): void {
  const report = checkBaselineAnalyzerReceipts(readVendorBaselineLock());
  if (!report.ok) {
    for (const finding of report.findings) {
      process.stderr.write(`${finding.sourceId}/${finding.componentId}: ${finding.detail}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `vendor baseline analyzer receipts complete for ${REQUIRED_BASELINE_ANALYZERS.join(", ")}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main();
}
