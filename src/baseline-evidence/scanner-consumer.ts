import type {
  BaselineVetBatchResultV1,
  BaselineVetRequestV1,
  BaselineVetTrustRootV1,
} from "@aihq/scan";
import { createBaselineVetRequestV1, verifyBaselineVetAttestationV1 } from "@aihq/scan";
import type { TrustDetectorName } from "../trust/detectors.js";
import { scanTrustTreeWithAnalyzers } from "../trust/scan.js";
import {
  requiredBaselineAnalyzersForComponent,
  requiredBaselineDetectorsForComponent,
} from "./analyzer-profile.js";
import type { BaselineCatalog } from "./catalog.js";
import { hashComponentTree, hashSourceTree } from "./hash.js";
import {
  SCANNER_BASELINE_ANALYZER_VERSIONS,
  SCANNER_TO_CORE_BASELINE_ANALYZER,
  type ScannerBaselineAnalyzer,
} from "./scanner-profile.js";
import type { BaselineSourceEvidence } from "./schema.js";
import { vetBaselineCatalog } from "./vet.js";

const SCANNER_ANALYZER_ORDER = ["aih-native", "skillspector", "semgrep", "cisco"] as const;
const EXTERNAL_SCANNER_ANALYZERS = ["skillspector", "semgrep", "cisco"] as const;

export interface VerifiedScannerBaselineInput {
  sourceRoot: string;
  catalog: BaselineCatalog;
  request: BaselineVetRequestV1;
  result: BaselineVetBatchResultV1;
  envelope: unknown;
  roots: readonly BaselineVetTrustRootV1[];
  expected: {
    now: string;
    signer: {
      identity: string;
      class: "test-ephemeral" | "organization";
      keyId: string;
    };
  };
  seenEvidenceDigests?: readonly string[];
  seenReceiptBindings?: readonly Readonly<{
    requestSha256: string;
    receiptSha256: string;
  }>[];
}

export interface VerifiedScannerBaselineBatchInput {
  sourceRoot: string;
  catalog: BaselineCatalog;
  batches: readonly Readonly<{
    request: BaselineVetRequestV1;
    result: BaselineVetBatchResultV1;
    envelope: unknown;
  }>[];
  roots: readonly BaselineVetTrustRootV1[];
  expected: VerifiedScannerBaselineInput["expected"];
  seenEvidenceDigests?: readonly string[];
  seenReceiptBindings?: VerifiedScannerBaselineInput["seenReceiptBindings"];
}

export const SCANNER_BASELINE_COMPONENT_BATCH_LIMIT = 100;

function requestAnalyzers(skillContent: boolean): readonly ScannerBaselineAnalyzer[] {
  return skillContent
    ? SCANNER_ANALYZER_ORDER
    : SCANNER_ANALYZER_ORDER.filter((name) => name !== "cisco");
}

function createRequest(
  sourceRoot: string,
  catalog: BaselineCatalog,
  components: BaselineCatalog["components"],
): BaselineVetRequestV1 {
  const source = hashSourceTree(sourceRoot);
  return createBaselineVetRequestV1({
    protocol: "BaselineVetRequestV1",
    profile: "aih-baseline-v1",
    source: {
      id: catalog.id,
      owner: catalog.owner,
      repository: catalog.repo,
      pinnedCommit: catalog.pinnedSha,
      treeSha256: source.treeSha256,
    },
    components: components.map((component) => ({
      id: component.id,
      content: component.skillContent === true ? "skill" : "general",
      paths: component.paths,
      treeSha256: hashComponentTree(sourceRoot, component.paths).treeSha256,
      analyzers: requestAnalyzers(component.skillContent === true),
    })),
  });
}

/** Author deterministic, bounded Scanner requests from Core's exact catalog. */
export function createCoreBaselineVetRequests(
  sourceRoot: string,
  catalog: BaselineCatalog,
): readonly BaselineVetRequestV1[] {
  const requests: BaselineVetRequestV1[] = [];
  for (let offset = 0; offset < catalog.components.length; ) {
    const next = offset + SCANNER_BASELINE_COMPONENT_BATCH_LIMIT;
    requests.push(createRequest(sourceRoot, catalog, catalog.components.slice(offset, next)));
    offset = next;
  }
  return Object.freeze(requests);
}

/** Convenience boundary for catalogs that fit one Scanner request. */
export function createCoreBaselineVetRequest(
  sourceRoot: string,
  catalog: BaselineCatalog,
): BaselineVetRequestV1 {
  const requests = createCoreBaselineVetRequests(sourceRoot, catalog);
  if (requests.length !== 1) {
    throw new Error(
      `Core catalog ${catalog.id} requires ${requests.length} bounded Scanner requests`,
    );
  }
  return requests[0] as BaselineVetRequestV1;
}

function assertExactRequest(
  sourceRoot: string,
  catalog: BaselineCatalog,
  request: BaselineVetRequestV1,
  batchIndex = 0,
): void {
  const expected = createCoreBaselineVetRequests(sourceRoot, catalog)[batchIndex];
  if (expected === undefined) {
    throw new Error(`Scanner baseline request has no Core catalog batch ${batchIndex + 1}`);
  }
  if (request.requestSha256 !== expected.requestSha256) {
    throw new Error(
      `Scanner baseline request batch ${batchIndex + 1} does not match Core catalog ${catalog.id} at ${catalog.pinnedSha}`,
    );
  }
}

function scannerAnalyzerVersions(
  result: BaselineVetBatchResultV1,
): Readonly<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const observation of result.receipt.observations) {
    const scannerName = observation.analyzer as ScannerBaselineAnalyzer;
    const coreName = SCANNER_TO_CORE_BASELINE_ANALYZER[scannerName];
    const expected = SCANNER_BASELINE_ANALYZER_VERSIONS[coreName];
    if (observation.analyzerVersion !== expected) {
      throw new Error(
        `Scanner baseline analyzer ${scannerName} identity ${observation.analyzerVersion} does not match pinned ${expected}`,
      );
    }
    versions[coreName] = observation.analyzerVersion;
  }
  return Object.freeze(versions);
}

function normalizeScannerSarifForSourceComparison(
  detector: TrustDetectorName,
  raw: Buffer,
): string {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Scanner baseline SARIF annex is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Scanner baseline SARIF annex is not an object");
  }
  const runs = (value as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) throw new Error("Scanner baseline SARIF annex has no runs array");
  for (const run of runs) {
    if (typeof run !== "object" || run === null || Array.isArray(run)) continue;
    if (detector === "cisco") {
      const invocations = (run as { invocations?: unknown }).invocations;
      if (Array.isArray(invocations)) {
        for (const invocation of invocations) {
          if (typeof invocation !== "object" || invocation === null || Array.isArray(invocation))
            continue;
          const stableInvocation = invocation as Record<string, unknown>;
          delete stableInvocation.startTimeUtc;
          delete stableInvocation.endTimeUtc;
        }
      }
    }
    const results = (run as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      if (typeof result !== "object" || result === null || Array.isArray(result)) continue;
      if (detector === "skillspector") {
        const properties = (result as { properties?: unknown }).properties;
        if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
          const holder = properties as { findingId?: unknown };
          if (
            typeof holder.findingId === "string" &&
            /^finding-[0-9a-f]{32}$/.test(holder.findingId)
          ) {
            delete holder.findingId;
          }
        }
      }
      const locations = (result as { locations?: unknown }).locations;
      if (!Array.isArray(locations)) continue;
      for (const location of locations) {
        if (typeof location !== "object" || location === null || Array.isArray(location)) continue;
        const physical = (location as { physicalLocation?: unknown }).physicalLocation;
        if (typeof physical !== "object" || physical === null || Array.isArray(physical)) continue;
        const artifact = (physical as { artifactLocation?: unknown }).artifactLocation;
        if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) continue;
        const holder = artifact as { uri?: unknown };
        if (typeof holder.uri !== "string") continue;
        holder.uri = holder.uri
          .replace(/^file:\/\/\/aih\/source\/?/, "")
          .replace(/^\/aih\/source\/?/, "")
          .replace(/^aih\/source\/?/, "");
      }
    }
  }
  return JSON.stringify(value);
}

function scannerSarif(
  result: BaselineVetBatchResultV1,
): Readonly<Partial<Record<TrustDetectorName, string>>> {
  const artifacts = new Map(
    result.annexArtifacts.map((artifact) => [artifact.path, artifact.bytes]),
  );
  const sarif: Partial<Record<TrustDetectorName, string>> = {};
  for (const observation of result.receipt.observations) {
    if (!EXTERNAL_SCANNER_ANALYZERS.includes(observation.analyzer as never)) continue;
    const bytes = artifacts.get(observation.annex.path);
    if (bytes === undefined)
      throw new Error(`Scanner baseline annex is missing: ${observation.analyzer}`);
    const detector = observation.analyzer as TrustDetectorName;
    sarif[detector] = normalizeScannerSarifForSourceComparison(detector, bytes);
  }
  return Object.freeze(sarif);
}

/**
 * Verify Scanner custody/signature/replay facts, then let Core interpret the
 * already-produced annexes into its repository-owned vendor evidence.
 * No analyzer command, Docker process, uv process, or network action is run.
 */
export async function consumeVerifiedScannerBaseline(
  input: VerifiedScannerBaselineInput,
): Promise<BaselineSourceEvidence> {
  return consumeVerifiedScannerBaselineBatches({
    sourceRoot: input.sourceRoot,
    catalog: input.catalog,
    batches: [{ request: input.request, result: input.result, envelope: input.envelope }],
    roots: input.roots,
    expected: input.expected,
    seenEvidenceDigests: input.seenEvidenceDigests,
    seenReceiptBindings: input.seenReceiptBindings,
  });
}

/** Verify every bounded Scanner batch before interpreting their annex union. */
export async function consumeVerifiedScannerBaselineBatches(
  input: VerifiedScannerBaselineBatchInput,
): Promise<BaselineSourceEvidence> {
  const expectedRequests = createCoreBaselineVetRequests(input.sourceRoot, input.catalog);
  if (input.batches.length !== expectedRequests.length) {
    throw new Error(
      `Scanner baseline batch count ${input.batches.length} does not match Core catalog ${expectedRequests.length}`,
    );
  }
  const versions: Record<string, string> = {};
  const precomputedDetectorSarif: Partial<Record<TrustDetectorName, string>> = {};
  for (const [index, batch] of input.batches.entries()) {
    assertExactRequest(input.sourceRoot, input.catalog, batch.request, index);
    verifyBaselineVetAttestationV1({
      envelope: batch.envelope,
      request: batch.request,
      result: batch.result,
      roots: input.roots,
      expected: input.expected,
      seenEvidenceDigests: input.seenEvidenceDigests ?? [],
      seenReceiptBindings: input.seenReceiptBindings ?? [],
    });
    for (const [name, version] of Object.entries(scannerAnalyzerVersions(batch.result))) {
      const prior = versions[name];
      if (prior !== undefined && prior !== version) {
        throw new Error(`Scanner baseline batches disagree on analyzer identity ${name}`);
      }
      versions[name] = version;
    }
    for (const [name, sarif] of Object.entries(scannerSarif(batch.result))) {
      const detector = name as TrustDetectorName;
      const prior = precomputedDetectorSarif[detector];
      if (prior !== undefined && prior !== sarif) {
        throw new Error(`Scanner baseline batches disagree on ${detector} annex bytes`);
      }
      precomputedDetectorSarif[detector] = sarif;
    }
  }
  const detectors = EXTERNAL_SCANNER_ANALYZERS.filter(
    (name) => precomputedDetectorSarif[name] !== undefined,
  );
  const forbiddenRunner = async (): Promise<never> => {
    throw new Error("Core Scanner evidence consumer must not execute analyzer commands");
  };
  return vetBaselineCatalog(input.sourceRoot, input.catalog, {
    scanTree: (root, options) =>
      scanTrustTreeWithAnalyzers(root, {
        ...options,
        env: {},
        platform: "linux",
        run: forbiddenRunner,
        detectors,
        precomputedDetectorSarif,
        sandboxSmokeShape: {
          skillDirs: [],
          installScripts: false,
          mcpConfig: false,
          packageManifests: [],
        },
      }),
    requiredAnalyzers: requiredBaselineAnalyzersForComponent,
    requiredDetectorsForComponent: requiredBaselineDetectorsForComponent,
    analyzerVersions: versions,
    sourceWideScan: true,
    full: true,
  });
}
