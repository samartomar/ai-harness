import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  baselineAnalyzerVersions,
  REQUIRED_BASELINE_ANALYZERS,
  requiredBaselineAnalyzersForComponent,
} from "../baseline-evidence/analyzer-profile.js";
import { BASELINE_CATALOG_IDS, baselineCatalogById } from "../baseline-evidence/catalogs.js";
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
  const sourceIds = new Set(lock.sources.map((source) => source.id));

  for (const sourceId of BASELINE_CATALOG_IDS) {
    if (!sourceIds.has(sourceId)) {
      findings.push({
        sourceId,
        componentId: "<catalog>",
        detail: "source is missing from the vendor baseline lock",
      });
    }
  }

  for (const source of lock.sources) {
    let canonicalComponents: Map<
      string,
      ReturnType<typeof baselineCatalogById>["components"][number]
    >;
    try {
      canonicalComponents = new Map(
        baselineCatalogById(source.id, source.pinnedSha).components.map((component) => [
          component.id,
          component,
        ]),
      );
    } catch (error) {
      findings.push({
        sourceId: source.id,
        componentId: "<catalog>",
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const activePin = baselineCatalogById(source.id).pinnedSha;
    if (source.pinnedSha !== activePin) {
      findings.push({
        sourceId: source.id,
        componentId: "<catalog>",
        detail: `lock pinned ${source.pinnedSha} but active catalog pin is ${activePin}`,
      });
      continue;
    }
    const componentIds = new Set(source.components.map((component) => component.id));
    for (const component of source.components) {
      const canonical = canonicalComponents.get(component.id);
      if (canonical === undefined) {
        findings.push({
          sourceId: source.id,
          componentId: component.id,
          detail: "component is missing from the canonical baseline catalog",
        });
        continue;
      }
      const actual = new Map(component.analyzers.map((receipt) => [receipt.name, receipt.version]));
      for (const name of requiredBaselineAnalyzersForComponent(canonical)) {
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
    for (const componentId of canonicalComponents.keys()) {
      if (!componentIds.has(componentId)) {
        findings.push({
          sourceId: source.id,
          componentId,
          detail: "component is missing from the vendor baseline lock",
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
