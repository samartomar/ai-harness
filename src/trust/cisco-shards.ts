import { createHash } from "node:crypto";

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

export function joinCiscoShardResults(
  manifest: CiscoShardManifest,
  values: readonly CiscoShardResult[],
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

  const outputs = new Map<string, CiscoShardOutput>();
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
      outputs.set(output.jobId, output);
    }
    for (const job of shard.jobs) {
      if (!outputs.has(job.id)) throw new Error(`missing Cisco job output: ${job.path}`);
    }
  }
  return {
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
}
