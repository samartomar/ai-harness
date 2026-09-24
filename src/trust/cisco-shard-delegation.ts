import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { hashComponentTree } from "../baseline-evidence/hash.js";
import {
  loadScanCiscoShardRunnerV1,
  type ScanPackageImporterV1,
  ScanPackageRefusalError,
} from "../scan-package/load-scan-package.js";
import {
  buildCiscoShardResult,
  type CiscoShardManifest,
  type CiscoShardResult,
} from "./cisco-shards.js";
import { TrustScanCancelledError, type UvExecutionProfileIdV1 } from "./detectors.js";

// Core builds the Cisco source-wide manifest and joins the shard results; the
// installed @aihq/scan executes one shard's jobs (`runCiscoShardV1`, C2a §3.7).
// Core verifies every job's input identity before and after the call, checks
// the analyzer lock against the profile Scan publishes, and accepts only
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

/**
 * The uv.lock digest Scan publishes for a detector's execution profile
 * (`executionProfiles[].analyzerLock.sha256`), or why it cannot be named.
 */
export function scanAnalyzerLockSha256V1(
  capabilities: readonly unknown[],
  detectorId: string,
  executionProfileId: string,
): { readonly sha256: string } | { readonly refusal: string } {
  const capability = capabilities.map(asRecord).find((entry) => entry?.detectorId === detectorId);
  if (capability === undefined)
    return { refusal: `the installed @aihq/scan declares no ${detectorId} capability` };
  const profiles = Array.isArray(capability.executionProfiles) ? capability.executionProfiles : [];
  const profile = profiles.map(asRecord).find((entry) => entry?.id === executionProfileId);
  if (profile === undefined)
    return { refusal: `${detectorId} declares no execution profile ${executionProfileId}` };
  const sha256 = asRecord(profile.analyzerLock)?.sha256;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))
    return {
      refusal: `${detectorId} profile ${executionProfileId} publishes no analyzerLock sha256`,
    };
  return { sha256 };
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
  expected: { readonly executionProfileId: string; readonly lockSha256: string },
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
  if (asRecord(record.analyzer)?.lockSha256 !== expected.lockSha256)
    throw new Error("Cisco shard ran under an analyzer lock other than the manifest's");
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
    const log = asRecord(sarif);
    if (log?.version !== "2.1.0" || !Array.isArray(log.runs))
      throw new Error(`Cisco shard output for ${job.path} is not a SARIF 2.1.0 log`);
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
  const lock = scanAnalyzerLockSha256V1(
    listDetectorCapabilitiesV1(),
    SCAN_CISCO_DETECTOR_ID,
    options.executionProfileId,
  );
  if ("refusal" in lock)
    throw new ScanPackageRefusalError({
      reason: "scan-package-incompatible",
      detail: `${lock.refusal}; Core cannot bind a Cisco shard to an analyzer lock.`,
    });
  if (lock.sha256 !== manifest.analyzer.lockSha256)
    throw new Error(
      `Cisco shard analyzer lock does not match manifest identity: ${options.executionProfileId} publishes ${lock.sha256}`,
    );
  const jobs = shard.jobs.map((job) => ({
    id: job.id,
    path: job.path,
    inputSha256: job.inputSha256,
  }));
  if (aborted(options.signal))
    throw new TrustScanCancelledError(`before Cisco shard ${shardId} started`);
  const result = await runCiscoShardV1({
    sourceRoot: safeRoot,
    jobs,
    expected: {
      analyzerVersion: manifest.analyzer.version.split("+", 1)[0] ?? manifest.analyzer.version,
      lockSha256: manifest.analyzer.lockSha256,
    },
    executionProfileId: options.executionProfileId,
    concurrency: options.concurrency,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (aborted(options.signal))
    throw new TrustScanCancelledError(`Cisco shard ${shardId} was running`);
  const evidence = shardEvidence(result, jobs, {
    executionProfileId: options.executionProfileId,
    lockSha256: manifest.analyzer.lockSha256,
  });
  verifyShardSource(safeRoot, manifest);
  return buildCiscoShardResult(manifest, shardId, (job) => evidence.get(job.id));
}
