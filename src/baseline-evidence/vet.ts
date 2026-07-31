import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Check } from "../internals/verify.js";
import {
  type CiscoShardManifest,
  type CiscoShardResult,
  type JoinedCiscoShardEvidence,
  joinCiscoShardResults,
} from "../trust/cisco-shards.js";
import {
  buildCiscoSourceShardManifest,
  joinedCiscoShardSarif,
  runCiscoSourceShard,
} from "../trust/detectors.js";
import { scanTrustTreeWithAnalyzers, type TrustScanResult } from "../trust/scan.js";
import { VERSION } from "../version.js";
import type { BaselineCatalog, BaselineCatalogComponent } from "./catalog.js";
import { resolveVetConcurrency, runWithConcurrency } from "./concurrency.js";
import { hashComponentTree, hashSourceTree } from "./hash.js";
import { componentIdentityPaths, repositoryLicensePath } from "./license.js";
import {
  type ComponentReuseRecord,
  decideComponentReuse,
  findPriorSource,
  formatCatalogReuseSummary,
  spliceReusedComponent,
} from "./reuse.js";
import {
  type BaselineAnalyzerReceipt,
  type BaselineComponentEvidence,
  type BaselineEvidenceFinding,
  type BaselineEvidenceLock,
  type BaselineSourceEvidence,
  BaselineSourceEvidenceSchema,
} from "./schema.js";

type ScanTrustTreeOptions = NonNullable<Parameters<typeof scanTrustTreeWithAnalyzers>[1]>;
const MAX_REPORTED_DETECTOR_DURATION_MS = 24 * 60 * 60 * 1_000;
const DETECTOR_STARTED = /^trust scan: detector ([a-z-]+) started$/;
const DETECTOR_COMPLETED = /^trust scan: detector ([a-z-]+) complete$/;

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

interface DetectorTiming {
  name: string;
  startedAt: number;
  endedAt?: number;
}

/**
 * Emits baseline-only timing diagnostics from the existing detector start events.
 * Timings never enter a check, receipt, or lock: those artifacts are intentionally
 * reproducible and must not contain wall-clock data.
 */
function baselineDetectorTiming(
  componentId: string,
  progress: ScanTrustTreeOptions["progress"],
): {
  progress: ScanTrustTreeOptions["progress"];
  complete: (scan: TrustScanResult) => void;
  fail: () => void;
} {
  const timings: DetectorTiming[] = [];
  let active: DetectorTiming | undefined;
  const finishActive = (endedAt: number): void => {
    if (active !== undefined && active.endedAt === undefined) active.endedAt = endedAt;
  };
  const report = (
    timing: DetectorTiming,
    outcome: "complete" | "failed",
    endedAt: number,
  ): void => {
    const elapsed = Math.max(0, Math.round(endedAt - timing.startedAt));
    const durationMs = Math.min(elapsed, MAX_REPORTED_DETECTOR_DURATION_MS);
    progress?.(
      `baseline vet: component ${componentId}, detector ${timing.name} ${outcome} in ${durationMs}ms`,
    );
  };
  return {
    progress: (message) => {
      const started = DETECTOR_STARTED.exec(message);
      const completed = DETECTOR_COMPLETED.exec(message);
      if (started?.[1] !== undefined) {
        const now = performance.now();
        finishActive(now);
        active = { name: started[1], startedAt: now };
        timings.push(active);
      } else if (completed?.[1] !== undefined && active?.name === completed[1]) {
        finishActive(performance.now());
      }
      progress?.(message);
    },
    complete: (scan) => {
      const endedAt = performance.now();
      finishActive(endedAt);
      for (const timing of timings) {
        const completed = scan.checks.some(
          (check) => check.name === `trust detector ${timing.name}` && check.verdict === "pass",
        );
        report(timing, completed ? "complete" : "failed", timing.endedAt ?? endedAt);
      }
    },
    fail: () => {
      const endedAt = performance.now();
      finishActive(endedAt);
      for (const timing of timings) report(timing, "failed", timing.endedAt ?? endedAt);
    },
  };
}

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
  /** Per-occurrence evidence side channel; never folded into vendor-lock aggregation. */
  onComponentScan?: (component: BaselineCatalogComponent, scan: TrustScanResult) => void;
  /** Capture one complete source ledger and deterministically project it into components. */
  sourceWideScan?: boolean;
  onSourceWideScan?: (scan: TrustScanResult) => void;
  /** Prior lock to splice unchanged, identity-matched receipts from (Decision 1/4).
   * Absent ⟹ every component is treated as new and fully scanned. */
  reuseFrom?: BaselineEvidenceLock;
  /** Disable reuse outright and rescan every component (Decision 5's escape
   * hatch and the migration tool) — takes priority over `reuseFrom`. */
  full?: boolean;
  /**
   * Scan every Cisco skill input once under one exact-source manifest, then
   * project the validated SARIF into component scans. A dispatcher may execute
   * disjoint shards on remote vets; without one, exactly one local shard is
   * allowed so a single host is never accidentally oversubscribed.
   */
  sourceWideCisco?: {
    analyzerLockSha256: string;
    shardCount?: number;
    profile?: string;
    workerConcurrency?: number;
    dispatch?: (manifest: CiscoShardManifest) => Promise<readonly CiscoShardResult[]>;
  };
}

// Vendor-authored symlinks must never survive into a component projection: a
// projected symlink can point anywhere on the host (including outside the
// source root entirely), and the host-side analyzers that scan the
// projection would follow it, leaking file contents into SARIF/lock output
// that was never part of the vetted component. cpSync's filter runs on every
// copied entry, including the top-level declared path itself, so this alone
// is sufficient to exclude both nested and top-level symlinked paths.
function isNotSymlink(candidate: string): boolean {
  return !lstatSync(candidate).isSymbolicLink();
}

function projectRepositoryLicense(sourceRoot: string, projectionRoot: string): void {
  const name = repositoryLicensePath(sourceRoot);
  if (name === undefined) return;
  const source = resolve(sourceRoot, name);
  const target = resolve(projectionRoot, name);
  if (!existsSync(target)) {
    cpSync(source, target, {
      errorOnExist: true,
      force: false,
      dereference: false,
      preserveTimestamps: true,
    });
  }
}

function componentContainsCiscoJob(
  component: BaselineCatalogComponent,
  evidence: JoinedCiscoShardEvidence,
): boolean {
  return evidence.outputs.some((output) =>
    component.paths.some(
      (path) =>
        output.path === path ||
        output.path.startsWith(`${path}/`) ||
        path.startsWith(`${output.path}/`),
    ),
  );
}

function sourcePathIncluded(uri: string, paths: readonly string[]): boolean {
  const normalized = uri.split("#", 1)[0]?.replace(/\\/g, "/") ?? "";
  return paths.some(
    (path) =>
      normalized === path || normalized.startsWith(`${path}/`) || path.startsWith(`${normalized}/`),
  );
}

function projectSourceWideScan(scan: TrustScanResult, paths: readonly string[]): TrustScanResult {
  const rawOccurrences = (scan.rawOccurrences ?? []).filter(
    (occurrence) =>
      occurrence.location === undefined || sourcePathIncluded(occurrence.location.uri, paths),
  );
  const rawFingerprints = new Set(rawOccurrences.map((occurrence) => occurrence.fingerprint));
  const normalizedFindings = (scan.normalizedFindings ?? []).filter(
    (finding) =>
      finding.location === undefined ||
      sourcePathIncluded(finding.location.uri, paths) ||
      finding.rawOccurrenceFingerprints.some((fingerprint) => rawFingerprints.has(fingerprint)),
  );
  const findingFingerprints = new Set(normalizedFindings.map((finding) => finding.fingerprint));
  return {
    checks: scan.checks.filter(
      (check) => check.location === undefined || sourcePathIncluded(check.location.uri, paths),
    ),
    analyzersRun: [...scan.analyzersRun],
    rawOccurrences,
    normalizedFindings,
    policyDispositions: (scan.policyDispositions ?? []).filter((disposition) =>
      findingFingerprints.has(disposition.findingFingerprint),
    ),
  };
}

export function defaultComponentScanner(
  scanOptions: ScanTrustTreeOptions,
  scanTree: BaselineTreeScanner,
  requiredDetectorsForComponent?: VetBaselineCatalogOptions["requiredDetectorsForComponent"],
  sharedCiscoEvidence?: JoinedCiscoShardEvidence,
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
          filter: isNotSymlink,
        });
      }
      // Component scans are isolated, but a repository license is still valid
      // evidence for the selected skill. Project only that top-level legal file
      // so the scanner can resolve inheritance without exposing unrelated source.
      projectRepositoryLicense(sourceRoot, projectionRoot);
      const timing = baselineDetectorTiming(component.id, scanOptions.progress);
      try {
        const requiredDetectors =
          requiredDetectorsForComponent?.(component, sourceRoot) ?? scanOptions.requiredDetectors;
        const usesCisco = requiredDetectors?.includes("cisco") === true;
        if (
          sharedCiscoEvidence !== undefined &&
          usesCisco &&
          !componentContainsCiscoJob(component, sharedCiscoEvidence)
        ) {
          throw new Error(
            `baseline component ${component.id} requires Cisco but has no exact source-wide Cisco job`,
          );
        }
        const detectors =
          sharedCiscoEvidence === undefined || usesCisco
            ? scanOptions.detectors
            : (["skillspector", "mcp-scanner", "semgrep", "snyk-agent-scan"] as const).filter(
                (detector) => scanOptions.detectors?.includes(detector) ?? true,
              );
        const scan = await scanTree(projectionRoot, {
          ...scanOptions,
          detectors,
          precomputedDetectorSarif:
            sharedCiscoEvidence !== undefined && usesCisco
              ? {
                  ...scanOptions.precomputedDetectorSarif,
                  cisco: joinedCiscoShardSarif(sharedCiscoEvidence, component.paths),
                }
              : scanOptions.precomputedDetectorSarif,
          progress: timing.progress,
          posture: "enterprise",
          requiredDetectors,
        });
        timing.complete(scan);
        return scan;
      } catch (error) {
        timing.fail();
        throw error;
      }
    } finally {
      rmSync(projectionRoot, { recursive: true, force: true });
    }
  };
}

async function prepareSourceWideCiscoEvidence(
  sourceRoot: string,
  catalog: BaselineCatalog,
  versions: Readonly<Record<string, string>>,
  scanOptions: ScanTrustTreeOptions,
  options: NonNullable<VetBaselineCatalogOptions["sourceWideCisco"]>,
): Promise<JoinedCiscoShardEvidence> {
  const analyzerVersion = versions["cisco@uvx"]?.trim();
  const policyVersion = versions["aih-native"]?.trim();
  if (!analyzerVersion) throw new Error("source-wide Cisco scan requires a Cisco version receipt");
  if (!policyVersion) throw new Error("source-wide Cisco scan requires an AIH policy identity");
  const shardCount = options.shardCount ?? 1;
  const manifest = buildCiscoSourceShardManifest(sourceRoot, {
    source: { id: catalog.id, pinnedSha: catalog.pinnedSha },
    analyzer: {
      version: analyzerVersion,
      lockSha256: options.analyzerLockSha256,
    },
    policy: {
      version: policyVersion,
      profile: options.profile ?? `${catalog.id}:source-wide-inventory`,
    },
    shardCount,
  });
  scanOptions.progress?.(
    `baseline vet: Cisco source manifest ${manifest.manifestSha256} has ${manifest.jobs.length} jobs in ${manifest.shards.length} shard(s)`,
  );
  let results: readonly CiscoShardResult[];
  if (options.dispatch !== undefined) {
    results = await options.dispatch(manifest);
  } else {
    if (manifest.shards.length !== 1) {
      throw new Error(
        "source-wide Cisco scan with multiple shards requires an explicit shard dispatcher",
      );
    }
    if (scanOptions.run === undefined || scanOptions.platform === undefined) {
      throw new Error("source-wide Cisco scan requires run and platform runtime options");
    }
    const shard = manifest.shards[0];
    if (shard === undefined) throw new Error("source-wide Cisco manifest has no shard");
    results = [
      await runCiscoSourceShard(sourceRoot, manifest, shard.id, {
        run: scanOptions.run,
        platform: scanOptions.platform,
        env: scanOptions.env ?? {},
        ...(options.workerConcurrency === undefined
          ? {}
          : { concurrency: options.workerConcurrency }),
      }),
    ];
  }
  const joined = joinCiscoShardResults(manifest, results);
  scanOptions.progress?.(
    `baseline vet: Cisco source evidence joined ${joined.outputs.length} exact jobs`,
  );
  return joined;
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
  for (const name of analyzers) {
    if (!versions[name]?.trim()) {
      throw new Error(`baseline analyzer ${name} ran without a version receipt`);
    }
  }
  return [...new Set(requiredAnalyzers)]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
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
      ...(group.every((finding) => finding.fingerprint !== undefined)
        ? { fingerprints: group.map((finding) => finding.fingerprint as string) }
        : {}),
    };
  });
}

function decisionFindings(scan: TrustScanResult): BaselineEvidenceFinding[] {
  if (scan.normalizedFindings === undefined || scan.policyDispositions === undefined) {
    return blockingFindings(scan.checks);
  }
  const findingByFingerprint = new Map(
    scan.normalizedFindings.map((finding) => [finding.fingerprint, finding]),
  );
  const groups = new Map<
    string,
    Array<{
      detail: string;
      fingerprints: string[];
    }>
  >();
  for (const disposition of scan.policyDispositions) {
    if (disposition.level !== "BLOCK" && disposition.level !== "REVIEW") continue;
    const finding = findingByFingerprint.get(disposition.findingFingerprint);
    if (finding === undefined) {
      throw new Error(
        `policy disposition has no normalized finding: ${disposition.findingFingerprint}`,
      );
    }
    const code = finding.code ?? "trust.detector-finding";
    const location =
      finding.location === undefined
        ? ""
        : `${finding.location.uri}${
            finding.location.startLine === undefined ? "" : `:${finding.location.startLine}`
          } — `;
    const fingerprints =
      finding.rawOccurrenceFingerprints.length > 0
        ? [...finding.rawOccurrenceFingerprints]
        : [finding.fingerprint];
    const group = groups.get(code) ?? [];
    group.push({
      detail: `${disposition.level}: ${location}${finding.sourceValue ?? finding.detail}`,
      fingerprints,
    });
    groups.set(code, group);
  }
  return [...groups.entries()].map(([code, group]) => {
    const fingerprints = [...new Set(group.flatMap((entry) => entry.fingerprints))];
    return {
      code,
      ...(group.length > 1 ? { count: group.length } : {}),
      detail:
        group.length === 1
          ? (group[0]?.detail ?? code).slice(0, 2_000)
          : `${group.length} policy-held findings; first: ${group[0]?.detail ?? code}`.slice(
              0,
              2_000,
            ),
      ...(fingerprints.length === 1 ? { fingerprint: fingerprints[0] } : {}),
      fingerprints,
    };
  });
}

export async function vetBaselineCatalog(
  sourceRoot: string,
  catalog: BaselineCatalog,
  options: VetBaselineCatalogOptions = {},
): Promise<BaselineSourceEvidence> {
  if (options.requiredAnalyzers === undefined) {
    throw new Error("vetBaselineCatalog requires an explicit requiredAnalyzers floor");
  }
  if (options.scanComponent !== undefined && options.sourceWideCisco !== undefined) {
    throw new Error("source-wide Cisco evidence requires the default component scanner");
  }
  const versions = { "aih-native": VERSION, ...(options.analyzerVersions ?? {}) };
  const sourceTreeBefore = hashSourceTree(sourceRoot).treeSha256;
  const priorSource = findPriorSource(options.reuseFrom, catalog);
  const full = options.full === true;
  const prepared = catalog.components.map((component) => {
    const tree = hashComponentTree(sourceRoot, componentIdentityPaths(sourceRoot, component.paths));
    const requiredAnalyzers =
      typeof options.requiredAnalyzers === "function"
        ? options.requiredAnalyzers(component, sourceRoot)
        : (options.requiredAnalyzers ?? []);
    const decision = decideComponentReuse({
      priorSource,
      component,
      currentTreeSha256: tree.treeSha256,
      requiredAnalyzers,
      analyzerVersions: versions,
      full,
    });
    return { tree, requiredAnalyzers, decision };
  });
  const requiresCiscoRescan = prepared.some(
    ({ requiredAnalyzers, decision }) => requiredAnalyzers.includes("cisco@uvx") && !decision.reuse,
  );
  const sharedCiscoEvidence =
    options.sourceWideCisco !== undefined && requiresCiscoRescan
      ? await prepareSourceWideCiscoEvidence(
          sourceRoot,
          catalog,
          versions,
          options.scanOptions ?? {},
          options.sourceWideCisco,
        )
      : undefined;
  const sourceWideScan =
    options.sourceWideScan === true &&
    options.scanComponent === undefined &&
    prepared.some(({ decision }) => !decision.reuse)
      ? await (options.scanTree ?? scanTrustTreeWithAnalyzers)(sourceRoot, {
          ...(options.scanOptions ?? {}),
          requiredDetectors: [
            ...new Set(
              catalog.components.flatMap(
                (component) =>
                  options.requiredDetectorsForComponent?.(component, sourceRoot) ??
                  options.scanOptions?.requiredDetectors ??
                  [],
              ),
            ),
          ],
          precomputedDetectorSarif:
            sharedCiscoEvidence === undefined
              ? options.scanOptions?.precomputedDetectorSarif
              : {
                  ...options.scanOptions?.precomputedDetectorSarif,
                  cisco: joinedCiscoShardSarif(sharedCiscoEvidence),
                },
        })
      : undefined;
  if (sourceWideScan !== undefined) options.onSourceWideScan?.(sourceWideScan);
  const scanComponent =
    options.scanComponent ??
    (sourceWideScan === undefined
      ? undefined
      : async ({ sourceRoot: componentRoot, component }) =>
          projectSourceWideScan(
            sourceWideScan,
            componentIdentityPaths(componentRoot, component.paths),
          )) ??
    defaultComponentScanner(
      options.scanOptions ?? {},
      options.scanTree ?? scanTrustTreeWithAnalyzers,
      options.requiredDetectorsForComponent,
      sharedCiscoEvidence,
    );
  const components: BaselineComponentEvidence[] = [];
  const reuseRecords: ComponentReuseRecord[] = [];
  // Scan components with bounded concurrency (issue #519). Each task writes its
  // result by catalog index, so completion order does not change the produced
  // artifacts — verified byte-identical to the serial output. The default keeps
  // ~2 vCPU per concurrent scan; override with AIH_VET_CONCURRENCY. A
  // concurrency of 1 is exactly the original serial scan.
  await runWithConcurrency(
    catalog.components,
    resolveVetConcurrency(),
    async (component, index) => {
      const preparedComponent = prepared[index];
      if (preparedComponent === undefined) {
        throw new Error(`baseline component ${component.id} preparation is missing`);
      }
      const { tree, requiredAnalyzers, decision } = preparedComponent;
      const analyzerNames =
        decision.reuse && decision.priorEntry !== undefined
          ? decision.priorEntry.analyzers.map((receipt) => receipt.name)
          : requiredAnalyzers;
      reuseRecords[index] = {
        componentId: component.id,
        decision,
        currentTreeSha256: tree.treeSha256,
        priorTreeSha256: decision.priorEntry?.treeSha256,
        analyzerNames,
      };
      if (decision.reuse && decision.priorEntry !== undefined) {
        components[index] = spliceReusedComponent(decision.priorEntry);
        return;
      }
      const scan = await scanComponent({ sourceRoot, component });
      options.onComponentScan?.(component, scan);
      const afterScan = hashComponentTree(
        sourceRoot,
        componentIdentityPaths(sourceRoot, component.paths),
      );
      if (afterScan.treeSha256 !== tree.treeSha256) {
        throw new Error(`baseline component ${component.id} changed during vet scan`);
      }
      const findings = decisionFindings(scan);
      components[index] = {
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
      };
    },
  );
  const progress = options.scanOptions?.progress;
  if (progress) {
    for (const line of formatCatalogReuseSummary(catalog, reuseRecords)) progress(line);
  }
  const sourceTreeAfter = hashSourceTree(sourceRoot).treeSha256;
  if (sourceTreeAfter !== sourceTreeBefore) {
    throw new Error("baseline source tree changed during vet scan");
  }
  return BaselineSourceEvidenceSchema.parse({
    id: catalog.id,
    owner: catalog.owner,
    repo: catalog.repo,
    pinnedSha: catalog.pinnedSha,
    sourceTreeSha256: sourceTreeBefore,
    components,
  });
}
