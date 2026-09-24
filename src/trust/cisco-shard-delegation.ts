import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { hashComponentTree } from "../baseline-evidence/hash.js";
import {
  loadScanCiscoShardRunnerV1,
  type ScanPackageImporterV1,
  ScanPackageRefusalError,
} from "../scan-package/load-scan-package.js";
import { startTrackedScanCall } from "../scan-package/settlement.js";
import {
  buildCiscoShardResult,
  type CiscoShardManifest,
  type CiscoShardResult,
} from "./cisco-shards.js";
import { TrustScanCancelledError, type UvExecutionProfileIdV1 } from "./detectors.js";
import {
  acceptedScanAnalyzerIdentityV1,
  declaredScanAnalyzerIdentityRefusalV1,
} from "./scan-analyzer-identity.js";
import { checkedScanSarifLogV1 } from "./scan-sarif.js";

// Core builds the Cisco source-wide manifest and joins the shard results; the
// installed @aihq/scan executes one shard's jobs (`runCiscoShardV1`, C2a §3.7).
// Core verifies every job's input identity before and after the call, checks
// the analyzer identity against the one Core accepts (and Scan must declare and
// run), and accepts only
// complete, ordered, digest-bound per-job SARIF. Anything else throws: a vet
// never records a partial shard.

const SCAN_CISCO_DETECTOR_ID = "detector.cisco";

export interface ScanCiscoShardRunOptionsV1 {
  /** The uv profile Scan runs the jobs under; the manifest's lock must be that profile's lock. */
  readonly executionProfileId: UvExecutionProfileIdV1;
  /** Parallel jobs, 1..64 (`resolveCiscoScanConcurrency`). */
  readonly concurrency: number;
  readonly signal?: AbortSignal;
  /** Test seam: resolves the package namespace. Production imports the installed peer. */
  readonly importer?: ScanPackageImporterV1;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Scan's text reaches an error message, so bound it and keep control characters out. */
function shown(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  const visible = text.replace(/[\p{C}]/gu, " ").trim();
  return visible.length > 300 ? `${visible.slice(0, 297)}...` : visible;
}

// A function, so the check after the await is not narrowed away by the one before it.
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function verifyShardSource(root: string, manifest: CiscoShardManifest): void {
  const sourceTree = hashComponentTree(
    root,
    manifest.jobs.map((job) => job.path),
  );
  if (sourceTree.treeSha256 !== manifest.source.treeSha256) {
    throw new Error("Cisco shard source tree does not match the exact manifest identity");
  }
  for (const job of manifest.jobs) {
    if (hashComponentTree(root, [job.path]).treeSha256 !== job.inputSha256) {
      throw new Error(`Cisco shard input identity changed: ${job.path}`);
    }
  }
}

/** The succeeded result's per-job SARIF, parsed, keyed by job id; anything else throws. */
function shardEvidence(
  result: unknown,
  jobs: readonly { readonly id: string; readonly path: string; readonly inputSha256: string }[],
  expected: {
    readonly executionProfileId: string;
    readonly analyzerVersion: string;
    readonly lockSha256: string;
  },
): Map<string, unknown> {
  const record = asRecord(result);
  if (record?.outcome === "refused")
    throw new Error(
      `Cisco shard refused by the installed @aihq/scan: ${shown(record.reason)}: ${shown(record.detail)}`,
    );
  if (record?.outcome === "failed") {
    const failure = asRecord(record.failure);
    throw new Error(
      `Cisco shard failed in the installed @aihq/scan: ${shown(failure?.stage)}: ${shown(failure?.detail)}`,
    );
  }
  if (record?.outcome !== "succeeded")
    throw new Error("Cisco shard runner returned an unrecognized result");
  const profileId = asRecord(record.executionProfile)?.id;
  if (profileId !== expected.executionProfileId)
    throw new Error(
      `Cisco shard ran under execution profile ${shown(profileId)} instead of requested ${expected.executionProfileId}`,
    );
  const analyzer = asRecord(record.analyzer);
  if (analyzer?.version !== expected.analyzerVersion)
    throw new Error(
      `Cisco shard ran analyzer version ${shown(analyzer?.version)} instead of the manifest's ${expected.analyzerVersion}`,
    );
  if (analyzer.lockSha256 !== expected.lockSha256)
    throw new Error("Cisco shard ran under an analyzer lock other than the manifest's");
  const ranLock = asRecord(asRecord(record.executionProfile)?.analyzerLock)?.sha256;
  if (ranLock !== expected.lockSha256)
    throw new Error(
      `Cisco shard ran under an execution profile with uv.lock ${shown(ranLock ?? "none")}; Core accepts ${expected.lockSha256}`,
    );
  const outputs = Array.isArray(record.outputs) ? record.outputs : undefined;
  if (outputs === undefined || outputs.length !== jobs.length)
    throw new Error("Cisco shard runner did not return exactly one output per job");
  const evidence = new Map<string, unknown>();
  for (const [index, job] of jobs.entries()) {
    const output = asRecord(outputs[index]);
    if (
      output?.jobId !== job.id ||
      output.path !== job.path ||
      output.inputSha256 !== job.inputSha256
    )
      throw new Error(`Cisco shard output ${index} does not name job ${job.id} (${job.path})`);
    const bytes = output.sarif;
    if (
      !(bytes instanceof Uint8Array) ||
      output.sha256 !== createHash("sha256").update(bytes).digest("hex")
    )
      throw new Error(`Cisco shard output for ${job.path} is not bound to its own digest`);
    let sarif: unknown;
    try {
      sarif = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error(`Cisco shard output for ${job.path} is not UTF-8 JSON`);
    }
    const checked = checkedScanSarifLogV1(sarif);
    if ("refusal" in checked)
      throw new Error(
        `Cisco shard output for ${job.path} is refused: Scan returned ${checked.refusal}`,
      );
    evidence.set(job.id, sarif);
  }
  return evidence;
}

/**
 * Executes one shard of an exact Cisco source manifest through the installed
 * `@aihq/scan` and returns Core's shard result. A missing or incompatible Scan
 * throws `ScanPackageRefusalError`; a cancelled run throws
 * `TrustScanCancelledError`; any other failure throws with Scan's own words.
 */
export async function runCiscoSourceShardThroughScanV1(
  root: string,
  manifest: CiscoShardManifest,
  shardId: string,
  options: ScanCiscoShardRunOptionsV1,
): Promise<CiscoShardResult> {
  const safeRoot = realpathSync(root);
  const shard = manifest.shards.find((candidate) => candidate.id === shardId);
  if (shard === undefined) throw new Error(`unexpected Cisco shard id: ${shardId}`);
  verifyShardSource(safeRoot, manifest);
  const loaded = await loadScanCiscoShardRunnerV1(options.importer);
  if (!loaded.ok) throw new ScanPackageRefusalError(loaded.refusal);
  const { listDetectorCapabilitiesV1, runCiscoShardV1 } = loaded.exports;
  // Core's table, not Scan's declaration, names the lock: the manifest must be
  // bound to it, and Scan must declare exactly it for the profile.
  const accepted = acceptedScanAnalyzerIdentityV1(
    SCAN_CISCO_DETECTOR_ID,
    options.executionProfileId,
  );
  if (accepted?.lockSha256 == null)
    throw new Error(`Core accepts no Cisco analyzer lock under ${options.executionProfileId}`);
  if (manifest.analyzer.lockSha256 !== accepted.lockSha256)
    throw new Error(
      `Cisco shard manifest names analyzer lock ${shown(manifest.analyzer.lockSha256)}; Core accepts ${accepted.lockSha256} under ${options.executionProfileId}`,
    );
  const capability = listDetectorCapabilitiesV1()
    .map(asRecord)
    .find((entry) => entry?.detectorId === SCAN_CISCO_DETECTOR_ID);
  const declared =
    capability === undefined
      ? `the installed @aihq/scan declares no ${SCAN_CISCO_DETECTOR_ID} capability`
      : declaredScanAnalyzerIdentityRefusalV1(
          capability,
          SCAN_CISCO_DETECTOR_ID,
          options.executionProfileId,
        );
  if (declared !== undefined)
    throw new ScanPackageRefusalError({
      reason: "scan-package-incompatible",
      detail: `${declared}; Core cannot bind a Cisco shard to an analyzer lock.`,
    });
  const jobs = shard.jobs.map((job) => ({
    id: job.id,
    path: job.path,
    inputSha256: job.inputSha256,
  }));
  if (aborted(options.signal))
    throw new TrustScanCancelledError(`before Cisco shard ${shardId} started`);
  const analyzerVersion = manifest.analyzer.version.split("+", 1)[0] ?? manifest.analyzer.version;
  const result = await startTrackedScanCall(options.signal, `Cisco shard ${shardId}`, () =>
    runCiscoShardV1({
      sourceRoot: safeRoot,
      jobs,
      expected: { analyzerVersion, lockSha256: manifest.analyzer.lockSha256 },
      executionProfileId: options.executionProfileId,
      concurrency: options.concurrency,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
  );
  if (aborted(options.signal))
    throw new TrustScanCancelledError(`Cisco shard ${shardId} was running`);
  const evidence = shardEvidence(result, jobs, {
    executionProfileId: options.executionProfileId,
    analyzerVersion,
    lockSha256: manifest.analyzer.lockSha256,
  });
  verifyShardSource(safeRoot, manifest);
  return buildCiscoShardResult(manifest, shardId, (job) => evidence.get(job.id));
}
