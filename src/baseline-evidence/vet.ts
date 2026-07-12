import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

export type BaselineTreeScanner = (
  root: string,
  options?: ScanTrustTreeOptions,
) => Promise<TrustScanResult>;

export interface VetBaselineCatalogOptions {
  scanComponent?: BaselineComponentScanner;
  scanTree?: BaselineTreeScanner;
  scanOptions?: ScanTrustTreeOptions;
  analyzerVersions?: Readonly<Record<string, string>>;
  requiredAnalyzers?:
    | readonly string[]
    | ((component: BaselineCatalogComponent, sourceRoot: string) => readonly string[]);
  requiredDetectorsForComponent?: (
    component: BaselineCatalogComponent,
    sourceRoot: string,
  ) => NonNullable<ScanTrustTreeOptions["requiredDetectors"]>;
}

function defaultComponentScanner(
  scanOptions: ScanTrustTreeOptions,
  scanTree: BaselineTreeScanner,
  requiredDetectorsForComponent?: VetBaselineCatalogOptions["requiredDetectorsForComponent"],
): BaselineComponentScanner {
  return async ({ sourceRoot, component }) => {
    const projectionRoot = mkdtempSync(
      join(dirname(resolve(sourceRoot)), ".aih-baseline-component-"),
    );
    try {
      for (const rel of component.paths) {
        const source = resolve(sourceRoot, ...rel.split("/"));
        const target = resolve(projectionRoot, ...rel.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target, {
          recursive: true,
          errorOnExist: true,
          force: false,
          dereference: false,
          preserveTimestamps: true,
        });
      }
      return await scanTree(projectionRoot, {
        ...scanOptions,
        posture: "enterprise",
        requiredDetectors:
          requiredDetectorsForComponent?.(component, sourceRoot) ?? scanOptions.requiredDetectors,
      });
    } finally {
      rmSync(projectionRoot, { recursive: true, force: true });
    }
  };
}

// A missing required analyzer is almost always a detector that failed to run
// (e.g. an offline uv cache that no longer resolves the pinned Cisco scanner).
// Surface those underlying reasons so the fail-closed abort is actionable instead
// of opaque.
function detectorDiagnostics(checks: readonly Check[]): string[] {
  return checks
    .filter((check) => check.code === "trust.detector-unavailable" && check.verdict === "fail")
    .map((check) => check.detail?.trim())
    .filter((detail): detail is string => detail !== undefined && detail.length > 0);
}

function analyzerReceipts(
  analyzersRun: readonly string[],
  versions: Readonly<Record<string, string>>,
  requiredAnalyzers: readonly string[],
  componentId: string,
  checks: readonly Check[],
): BaselineAnalyzerReceipt[] {
  const analyzers = [...new Set(analyzersRun)].sort((left, right) => left.localeCompare(right));
  if (analyzers.length === 0) throw new Error("baseline vet produced no analyzer receipt");
  const completed = new Set(analyzers);
  const missing = requiredAnalyzers.filter((name) => !completed.has(name));
  if (missing.length > 0) {
    const diagnostics = detectorDiagnostics(checks);
    const because =
      diagnostics.length > 0 ? `; detector diagnostics: ${diagnostics.join(" | ")}` : "";
    throw new Error(
      `baseline component ${componentId} missing required baseline analyzers: ${missing.join(", ")}${because}`,
    );
  }
  return analyzers.map((name) => {
    const version = versions[name]?.trim();
    if (!version) throw new Error(`baseline analyzer ${name} ran without a version receipt`);
    return { name, version };
  });
}

function blockingFindings(checks: readonly Check[]): BaselineEvidenceFinding[] {
  const groups = new Map<string, Check[]>();
  for (const check of checks) {
    if (check.verdict !== "fail") continue;
    const code = check.code ?? "trust.detector-finding";
    const group = groups.get(code) ?? [];
    group.push(check);
    groups.set(code, group);
  }
  return [...groups.entries()].map(([code, group]) => {
    const first = group[0];
    const firstDetail = first?.detail?.trim() || first?.name || code;
    const detail =
      group.length === 1 ? firstDetail : `${group.length} findings; first: ${firstDetail}`;
    return {
      code,
      ...(group.length > 1 ? { count: group.length } : {}),
      detail: detail.slice(0, 2_000),
      ...(group.length === 1 && first?.fingerprint !== undefined
        ? { fingerprint: first.fingerprint }
        : {}),
    };
  });
}

export async function vetBaselineCatalog(
  sourceRoot: string,
  catalog: BaselineCatalog,
  options: VetBaselineCatalogOptions = {},
): Promise<BaselineSourceEvidence> {
  const scanComponent =
    options.scanComponent ??
    defaultComponentScanner(
      options.scanOptions ?? {},
      options.scanTree ?? scanTrustTreeWithAnalyzers,
      options.requiredDetectorsForComponent,
    );
  const versions = { "aih-native": VERSION, ...(options.analyzerVersions ?? {}) };
  const components = [];
  for (const component of catalog.components) {
    const tree = hashComponentTree(sourceRoot, component.paths);
    const scan = await scanComponent({ sourceRoot, component });
    const afterScan = hashComponentTree(sourceRoot, component.paths);
    if (afterScan.treeSha256 !== tree.treeSha256) {
      throw new Error(`baseline component ${component.id} changed during vet scan`);
    }
    const findings = blockingFindings(scan.checks);
    const requiredAnalyzers =
      typeof options.requiredAnalyzers === "function"
        ? options.requiredAnalyzers(component, sourceRoot)
        : (options.requiredAnalyzers ?? []);
    components.push({
      id: component.id,
      paths: [...component.paths],
      treeSha256: tree.treeSha256,
      verdict: findings.length > 0 ? ("blocked" as const) : ("pass" as const),
      analyzers: analyzerReceipts(
        scan.analyzersRun,
        versions,
        requiredAnalyzers,
        component.id,
        scan.checks,
      ),
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
