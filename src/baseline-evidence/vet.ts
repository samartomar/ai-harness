import { lstatSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Check } from "../internals/verify.js";
import { scanTrustTreeWithAnalyzers, type TrustScanResult } from "../trust/scan.js";
import { VERSION } from "../version.js";
import type { BaselineCatalog, BaselineCatalogComponent } from "./catalog.js";
import { hashComponentTree } from "./hash.js";
import {
  type BaselineAnalyzerReceipt,
  type BaselineEvidenceFinding,
  type BaselineSourceEvidence,
  BaselineSourceEvidenceSchema,
} from "./schema.js";

type ScanTrustTreeOptions = NonNullable<Parameters<typeof scanTrustTreeWithAnalyzers>[1]>;

export interface BaselineComponentScanInput {
  sourceRoot: string;
  component: BaselineCatalogComponent;
}

export type BaselineComponentScanner = (
  input: BaselineComponentScanInput,
) => Promise<TrustScanResult>;

export interface VetBaselineCatalogOptions {
  scanComponent?: BaselineComponentScanner;
  scanOptions?: ScanTrustTreeOptions;
  analyzerVersions?: Readonly<Record<string, string>>;
}

function checkKey(check: Check): string {
  return JSON.stringify([
    check.name,
    check.verdict,
    check.code,
    check.detail,
    check.location?.uri,
    check.location?.startLine,
    check.fingerprint,
  ]);
}

function dedupeChecks(checks: readonly Check[]): Check[] {
  const seen = new Set<string>();
  return checks.filter((check) => {
    const key = checkKey(check);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function checkBelongsToFile(check: Check, fileName: string): boolean {
  const uri = check.location?.uri?.replace(/\\/g, "/");
  return uri === undefined || uri === fileName;
}

function defaultComponentScanner(scanOptions: ScanTrustTreeOptions): BaselineComponentScanner {
  return async ({ sourceRoot, component }) => {
    const checks: Check[] = [];
    const analyzers = new Set<string>();
    for (const rel of component.paths) {
      const target = resolve(sourceRoot, ...rel.split("/"));
      const stat = lstatSync(target);
      const scanRoot = stat.isDirectory() ? target : dirname(target);
      const scan = await scanTrustTreeWithAnalyzers(scanRoot, {
        ...scanOptions,
        posture: "enterprise",
      });
      for (const analyzer of scan.analyzersRun) analyzers.add(analyzer);
      checks.push(
        ...(stat.isDirectory()
          ? scan.checks
          : scan.checks.filter((check) => checkBelongsToFile(check, basename(target)))),
      );
    }
    return {
      analyzersRun: [...analyzers].sort((left, right) => left.localeCompare(right)),
      checks: dedupeChecks(checks),
    };
  };
}

function analyzerReceipts(
  analyzersRun: readonly string[],
  versions: Readonly<Record<string, string>>,
): BaselineAnalyzerReceipt[] {
  const analyzers = [...new Set(analyzersRun)].sort((left, right) => left.localeCompare(right));
  if (analyzers.length === 0) throw new Error("baseline vet produced no analyzer receipt");
  return analyzers.map((name) => {
    const version = versions[name]?.trim();
    if (!version) throw new Error(`baseline analyzer ${name} ran without a version receipt`);
    return { name, version };
  });
}

function blockingFindings(checks: readonly Check[]): BaselineEvidenceFinding[] {
  return checks
    .filter((check) => check.verdict === "fail")
    .map((check) => ({
      code: check.code ?? "trust.detector-finding",
      detail: check.detail?.trim() || check.name,
      ...(check.fingerprint !== undefined ? { fingerprint: check.fingerprint } : {}),
    }));
}

export async function vetBaselineCatalog(
  sourceRoot: string,
  catalog: BaselineCatalog,
  options: VetBaselineCatalogOptions = {},
): Promise<BaselineSourceEvidence> {
  const scanComponent = options.scanComponent ?? defaultComponentScanner(options.scanOptions ?? {});
  const versions = { "aih-native": VERSION, ...(options.analyzerVersions ?? {}) };
  const components = [];
  for (const component of catalog.components) {
    const tree = hashComponentTree(sourceRoot, component.paths);
    const scan = await scanComponent({ sourceRoot, component });
    const findings = blockingFindings(scan.checks);
    components.push({
      id: component.id,
      paths: [...component.paths],
      treeSha256: tree.treeSha256,
      verdict: findings.length > 0 ? ("blocked" as const) : ("pass" as const),
      analyzers: analyzerReceipts(scan.analyzersRun, versions),
      findings,
    });
  }
  return BaselineSourceEvidenceSchema.parse({
    id: catalog.id,
    owner: catalog.owner,
    repo: catalog.repo,
    pinnedSha: catalog.pinnedSha,
    components,
  });
}
