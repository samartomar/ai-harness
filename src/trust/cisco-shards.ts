import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { hashComponentTree } from "../baseline-evidence/hash.js";
import { checkedScanSarifLogV1, scanCompletionRefusalV1 } from "./scan-sarif.js";
import { type ScanSubjectDigestV1, scanSubjectDigestV1 } from "./scan-subject-files.js";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

export interface CiscoShardJobInput {
  /** POSIX path to the exact skill directory within the pinned source tree. */
  path: string;
  /** Digest of the complete scanner input projection for this job. */
  inputSha256: string;
}

export interface CiscoShardJob extends CiscoShardJobInput {
  id: string;
}

export interface CiscoShardManifestInput {
  source: {
    id: string;
    pinnedSha: string;
    treeSha256: string;
  };
  analyzer: {
    name: "cisco";
    version: string;
    lockSha256: string;
  };
  policy: {
    version: string;
    profile: string;
  };
  jobs: readonly CiscoShardJobInput[];
  shardCount: number;
}

export interface CiscoShardManifest {
  schemaVersion: 1;
  qualificationId: string;
  manifestSha256: string;
  source: CiscoShardManifestInput["source"];
  analyzer: CiscoShardManifestInput["analyzer"];
  policy: CiscoShardManifestInput["policy"];
  jobs: CiscoShardJob[];
  shards: Array<{
    id: string;
    jobs: CiscoShardJob[];
  }>;
}

export interface CiscoShardOutput {
  jobId: string;
  path: string;
  inputSha256: string;
  evidenceSha256: string;
  evidence: unknown;
}

export interface CiscoShardResult {
  schemaVersion: 1;
  manifestSha256: string;
  qualificationId: string;
  shardId: string;
  analyzer: CiscoShardManifestInput["analyzer"];
  outputs: CiscoShardOutput[];
}

export interface JoinedCiscoShardEvidence {
  schemaVersion: 1;
  manifestSha256: string;
  qualificationId: string;
  analyzer: CiscoShardManifestInput["analyzer"];
  outputs: CiscoShardOutput[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalValue(value: unknown, seen = new Set<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Cisco shard evidence must not contain cycles");
    seen.add(value);
    const output = value.map((entry) => canonicalValue(entry, seen));
    seen.delete(value);
    return output;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (seen.has(record)) throw new Error("Cisco shard evidence must not contain cycles");
    seen.add(record);
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
      const entry = record[key];
      if (entry === undefined) continue;
      output[key] = canonicalValue(entry, seen);
    }
    seen.delete(record);
    return output;
  }
  throw new Error(`Cisco shard evidence contains unsupported ${typeof value} value`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function nonEmpty(label: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  return trimmed;
}

function sha256Identity(label: string, value: string): string {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase sha256 hex digest`);
  return value;
}

function safePath(value: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.includes("\\") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`Cisco shard job path must be a safe POSIX source-relative path: ${value}`);
  }
  return value;
}

function manifestUnsigned(
  manifest: CiscoShardManifest,
): Omit<CiscoShardManifest, "manifestSha256"> {
  const { manifestSha256: _manifestSha256, ...unsigned } = manifest;
  return unsigned;
}

function computedManifestSha256(manifest: CiscoShardManifest): string {
  return sha256(canonicalJson(manifestUnsigned(manifest)));
}

function shardId(index: number, count: number): string {
  const width = Math.max(3, String(count).length);
  return `${String(index + 1).padStart(width, "0")}-of-${String(count).padStart(width, "0")}`;
}

export function buildCiscoShardManifest(input: CiscoShardManifestInput): CiscoShardManifest {
  if (!Number.isSafeInteger(input.shardCount) || input.shardCount < 1) {
    throw new Error("Cisco shard count must be a positive integer");
  }
  if (input.jobs.length === 0) throw new Error("Cisco shard manifest requires at least one job");
  if (!GIT_SHA.test(input.source.pinnedSha)) {
    throw new Error("Cisco shard source pin must be a lowercase 40-character Git SHA");
  }
  const source = {
    id: nonEmpty("Cisco shard source id", input.source.id),
    pinnedSha: input.source.pinnedSha,
    treeSha256: sha256Identity("Cisco shard source tree", input.source.treeSha256),
  };
  const analyzer = {
    name: "cisco" as const,
    version: nonEmpty("Cisco analyzer version", input.analyzer.version),
    lockSha256: sha256Identity("Cisco analyzer lock", input.analyzer.lockSha256),
  };
  const policy = {
    version: nonEmpty("Cisco shard policy version", input.policy.version),
    profile: nonEmpty("Cisco shard profile", input.policy.profile),
  };
  const paths = new Set<string>();
  const jobs = input.jobs
    .map((job): CiscoShardJob => {
      const path = safePath(job.path);
      if (paths.has(path)) throw new Error(`duplicate Cisco shard job path: ${path}`);
      paths.add(path);
      const inputSha256 = sha256Identity("Cisco shard job input", job.inputSha256);
      return {
        id: sha256(canonicalJson({ path, inputSha256 })),
        path,
        inputSha256,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  const effectiveShardCount = Math.min(input.shardCount, jobs.length);
  const shards = Array.from({ length: effectiveShardCount }, (_, index) => ({
    id: shardId(index, effectiveShardCount),
    jobs: [] as CiscoShardJob[],
  }));
  for (const [index, job] of jobs.entries()) {
    const shard = shards[index % effectiveShardCount];
    if (shard === undefined) throw new Error("Cisco shard assignment failed");
    shard.jobs.push(job);
  }
  const qualificationId = sha256(
    canonicalJson({
      source,
      analyzer,
      policy,
      jobs,
    }),
  );
  const unsigned = {
    schemaVersion: 1 as const,
    qualificationId,
    source,
    analyzer,
    policy,
    jobs,
    shards,
  };
  const manifestSha256 = sha256(canonicalJson(unsigned));
  return { ...unsigned, manifestSha256 };
}

export function buildCiscoShardResult(
  manifest: CiscoShardManifest,
  requestedShardId: string,
  evidenceFor: (job: CiscoShardJob) => unknown,
): CiscoShardResult {
  if (computedManifestSha256(manifest) !== manifest.manifestSha256) {
    throw new Error("Cisco shard manifest identity does not match its contents");
  }
  const shard = manifest.shards.find((candidate) => candidate.id === requestedShardId);
  if (shard === undefined) throw new Error(`unexpected Cisco shard id: ${requestedShardId}`);
  const outputs = shard.jobs.map((job): CiscoShardOutput => {
    const evidence = evidenceFor(job);
    return {
      jobId: job.id,
      path: job.path,
      inputSha256: job.inputSha256,
      evidenceSha256: sha256(canonicalJson(evidence)),
      evidence,
    };
  });
  return {
    schemaVersion: 1,
    manifestSha256: manifest.manifestSha256,
    qualificationId: manifest.qualificationId,
    shardId: shard.id,
    analyzer: manifest.analyzer,
    outputs,
  };
}

export async function buildCiscoShardResultAsync(
  manifest: CiscoShardManifest,
  requestedShardId: string,
  evidenceFor: (job: CiscoShardJob) => Promise<unknown>,
  concurrency = 1,
): Promise<CiscoShardResult> {
  if (computedManifestSha256(manifest) !== manifest.manifestSha256) {
    throw new Error("Cisco shard manifest identity does not match its contents");
  }
  const shard = manifest.shards.find((candidate) => candidate.id === requestedShardId);
  if (shard === undefined) throw new Error(`unexpected Cisco shard id: ${requestedShardId}`);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new Error("Cisco shard worker concurrency must be an integer from 1 through 64");
  }
  const outputs = new Array<CiscoShardOutput>(shard.jobs.length);
  let nextIndex = 0;
  let stopped = false;
  const failures: Array<{ index: number; error: unknown }> = [];
  const workers = Array.from(
    { length: Math.min(concurrency, shard.jobs.length) },
    async (): Promise<void> => {
      while (!stopped && nextIndex < shard.jobs.length) {
        const index = nextIndex++;
        const job = shard.jobs[index];
        if (job === undefined) throw new Error(`Cisco shard job ${index} is missing`);
        try {
          const evidence = await evidenceFor(job);
          outputs[index] = {
            jobId: job.id,
            path: job.path,
            inputSha256: job.inputSha256,
            evidenceSha256: sha256(canonicalJson(evidence)),
            evidence,
          };
        } catch (error) {
          failures.push({ index, error });
          stopped = true;
        }
      }
    },
  );
  await Promise.all(workers);
  const firstFailure = failures.sort((left, right) => left.index - right.index)[0];
  if (firstFailure !== undefined) throw firstFailure.error;
  return {
    schemaVersion: 1,
    manifestSha256: manifest.manifestSha256,
    qualificationId: manifest.qualificationId,
    shardId: shard.id,
    analyzer: manifest.analyzer,
    outputs,
  };
}

function assertResultEnvelope(manifest: CiscoShardManifest, value: CiscoShardResult): void {
  if (value.schemaVersion !== 1) throw new Error("unsupported Cisco shard result schema");
  if (
    value.manifestSha256 !== manifest.manifestSha256 ||
    value.qualificationId !== manifest.qualificationId
  ) {
    throw new Error(`Cisco shard result ${value.shardId} has a mismatched manifest identity`);
  }
  if (canonicalJson(value.analyzer) !== canonicalJson(manifest.analyzer)) {
    throw new Error(`Cisco shard result ${value.shardId} has a mismatched analyzer identity`);
  }
}

/**
 * The one completion predicate for a Cisco shard job's SARIF (C2a §1.6), before
 * any join: the checked shape, and completion evidence naming "detector.cisco",
 * the job's files as Core rehashes them under `sourceRoot` (never zero), and
 * the analyzer the manifest pins. Why it fails, or undefined.
 */
export function ciscoShardJobCompletionRefusalV1(
  sarif: unknown,
  sourceRoot: string,
  jobPath: string,
  analyzer: { readonly version: string; readonly lockSha256: string },
): string | undefined {
  const verified = verifiedCiscoShardJobSubjectV1(sarif, sourceRoot, jobPath, analyzer);
  return "refusal" in verified ? verified.refusal : undefined;
}

/** The job's subject as Core rehashed it, once its SARIF proved that subject complete (above). */
function verifiedCiscoShardJobSubjectV1(
  sarif: unknown,
  sourceRoot: string,
  jobPath: string,
  analyzer: { readonly version: string; readonly lockSha256: string },
): { readonly subject: ScanSubjectDigestV1 } | { readonly refusal: string } {
  const checked = checkedScanSarifLogV1(sarif);
  if ("refusal" in checked) return { refusal: checked.refusal };
  let subject: ScanSubjectDigestV1;
  try {
    subject = ciscoShardJobSubjectV1(sourceRoot, jobPath);
  } catch (error) {
    return {
      refusal: `completion evidence Core cannot check, because it cannot rehash job ${jobPath}: ${(error as Error)?.message ?? "unknown error"}`,
    };
  }
  const refusal = scanCompletionRefusalV1(checked.log, {
    detectorId: "detector.cisco",
    subject,
    emptyAllowed: false,
    analyzer: {
      version: analyzer.version.split("+", 1)[0] ?? analyzer.version,
      lockSha256: analyzer.lockSha256,
    },
  });
  return refusal === undefined ? { subject } : { refusal };
}

/** A shard job's subject (C2a §1.6): every regular file under `<sourceRoot>/<jobPath>`, rehashed now. */
export function ciscoShardJobSubjectV1(sourceRoot: string, jobPath: string): ScanSubjectDigestV1 {
  return scanSubjectDigestV1(hashComponentTree(sourceRoot, [jobPath]).files);
}

export function joinCiscoShardResults(
  manifest: CiscoShardManifest,
  values: readonly CiscoShardResult[],
  sourceRoot: string,
): JoinedCiscoShardEvidence {
  if (computedManifestSha256(manifest) !== manifest.manifestSha256) {
    throw new Error("Cisco shard manifest identity does not match its contents");
  }
  const expectedShards = new Map(manifest.shards.map((shard) => [shard.id, shard]));
  const results = new Map<string, CiscoShardResult>();
  for (const value of values) {
    if (!expectedShards.has(value.shardId)) {
      throw new Error(`unexpected Cisco shard result: ${value.shardId}`);
    }
    if (results.has(value.shardId)) {
      throw new Error(`duplicate Cisco shard result: ${value.shardId}`);
    }
    assertResultEnvelope(manifest, value);
    results.set(value.shardId, value);
  }
  for (const shard of manifest.shards) {
    if (!results.has(shard.id)) throw new Error(`missing Cisco shard result: ${shard.id}`);
  }

  const root = realpathSync.native(sourceRoot);
  const outputs = new Map<string, CiscoShardOutput>();
  const subjects = new Map<string, ScanSubjectDigestV1>();
  for (const shard of manifest.shards) {
    const result = results.get(shard.id);
    if (result === undefined) throw new Error(`missing Cisco shard result: ${shard.id}`);
    const expectedJobs = new Map(shard.jobs.map((job) => [job.id, job]));
    for (const output of result.outputs) {
      const job = expectedJobs.get(output.jobId);
      if (job === undefined || output.path !== job.path) {
        throw new Error(`unexpected Cisco job output in ${shard.id}: ${output.jobId}`);
      }
      if (outputs.has(output.jobId)) {
        throw new Error(`duplicate Cisco job output: ${output.jobId}`);
      }
      if (output.inputSha256 !== job.inputSha256) {
        throw new Error(`Cisco job ${job.path} has a mismatched input identity`);
      }
      if (sha256(canonicalJson(output.evidence)) !== output.evidenceSha256) {
        throw new Error(`Cisco job ${job.path} has a mismatched evidence digest`);
      }
      const verified = verifiedCiscoShardJobSubjectV1(
        output.evidence,
        sourceRoot,
        job.path,
        manifest.analyzer,
      );
      if ("refusal" in verified)
        throw new Error(
          `Cisco job ${job.path} did not prove it completed: it holds ${verified.refusal}`,
        );
      outputs.set(output.jobId, output);
      subjects.set(output.jobId, verified.subject);
    }
    for (const job of shard.jobs) {
      if (!outputs.has(job.id)) throw new Error(`missing Cisco job output: ${job.path}`);
    }
  }
  const joined: JoinedCiscoShardEvidence = {
    schemaVersion: 1,
    manifestSha256: manifest.manifestSha256,
    qualificationId: manifest.qualificationId,
    analyzer: manifest.analyzer,
    outputs: manifest.jobs.map((job) => {
      const output = outputs.get(job.id);
      if (output === undefined) throw new Error(`missing Cisco job output: ${job.path}`);
      return output;
    }),
  };
  VERIFIED_JOB_EVIDENCE.set(
    joined,
    frozenJoinRecord({
      root,
      jobs: manifest.jobs.map((job) => {
        const output = outputs.get(job.id);
        const subject = subjects.get(job.id);
        if (output === undefined || subject === undefined)
          throw new Error(`missing Cisco job output: ${job.path}`);
        return { path: job.path, sarif: canonicalJson(output.evidence), subject };
      }),
    }),
  );
  return joined;
}

/** A deep-frozen copy of a verified record: it shares no object with its input. */
function frozenJoinRecord(record: VerifiedCiscoShardJoinV1): VerifiedCiscoShardJoinV1 {
  return Object.freeze({
    root: record.root,
    jobs: Object.freeze(
      record.jobs.map((job) =>
        Object.freeze({
          path: job.path,
          sarif: job.sarif,
          subject: Object.freeze({
            subjectTreeSha256: job.subject.subjectTreeSha256,
            analyzedFileCount: job.subject.analyzedFileCount,
          }),
        }),
      ),
    ),
  });
}

/**
 * What `joinCiscoShardResults` verified: the canonical source root (realpath)
 * and, per job in manifest order, the job evidence exactly as it stood and the
 * job's subject (subject-files-v1) Core rehashed and the evidence proved.
 */
export interface VerifiedCiscoShardJoinV1 {
  readonly root: string;
  readonly jobs: readonly {
    readonly path: string;
    readonly sarif: string;
    readonly subject: ScanSubjectDigestV1;
  }[];
}

/**
 * The verified record, deep-frozen when the join verified it and keyed by the
 * joined object that call returned. A join built any other way, or evidence
 * changed afterwards, is never read; the stored record is never handed out.
 */
const VERIFIED_JOB_EVIDENCE = new WeakMap<JoinedCiscoShardEvidence, VerifiedCiscoShardJoinV1>();

/**
 * A frozen copy of the verified record of a join `joinCiscoShardResults`
 * returned, or undefined for any other value. Nothing a caller does to it
 * reaches the stored record.
 */
export function verifiedCiscoShardJobSarifV1(
  joined: JoinedCiscoShardEvidence,
): VerifiedCiscoShardJoinV1 | undefined {
  const record = VERIFIED_JOB_EVIDENCE.get(joined);
  return record === undefined ? undefined : frozenJoinRecord(record);
}
