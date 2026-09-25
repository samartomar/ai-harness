import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScanPackageRefusalError } from "../../src/scan-package/load-scan-package.js";
import { runCiscoSourceShardThroughScanV1 } from "../../src/trust/cisco-shard-delegation.js";
import {
  buildCiscoSourceShardManifest,
  TrustScanCancelledError,
} from "../../src/trust/detectors.js";
import { fakeCiscoJobSarif, type HandJobSubjectsForTests } from "./fakes/fake-cisco-job-sarif.js";

// ---------------------------------------------------------------------------
// Core builds the Cisco source manifest; the installed @aihq/scan runs a shard's
// jobs (C2a §3.7). Core binds the run to the profile's published analyzer lock
// and accepts only complete, ordered, digest-bound SARIF for exactly its jobs.
// ---------------------------------------------------------------------------

// The Cisco host-profile lock Core accepts (ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1).
const LOCK = "1e98c5679994dc56f82c1d88a77528d4c4b076160aff85b4d97ce239360bc210";
const roots: string[] = [];

/**
 * Each fixture job's subject (subject-files-v1), computed by hand with plain
 * node:crypto: sha256 of `<job>/SKILL.md\0<sha256 of its bytes>\n`.
 * SKILL.md holds `---\nname: <name>\n---\n# <name>\n`.
 */
const JOB_SUBJECTS: HandJobSubjectsForTests = {
  "skills/alpha": "83b6d7b9b707f6d6728215af3d080fbb9453759bc308675e8089f7f05aa28335",
  "skills/beta": "3a579f0c90add6f3661f67c18c28e77e4d19c6df23c4049dbee6fb9016f7a567",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sourceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-cisco-shard-"));
  roots.push(root);
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`);
  }
  return root;
}

function manifestFor(root: string, lockSha256: string = LOCK) {
  return buildCiscoSourceShardManifest(root, {
    source: { id: "fixture", pinnedSha: "0".repeat(40) },
    analyzer: { version: `2.1.0+uvlock.${lockSha256.slice(0, 12)}`, lockSha256 },
    policy: { version: "native.test", profile: "fixture:source-wide-inventory" },
    shardCount: 1,
  });
}

/** One job's SARIF as Scan returns it: completed, with evidence for the job's files now. */
function sarifBytes(
  request: FakeShardRequest,
  path: string,
  subjects: HandJobSubjectsForTests = JOB_SUBJECTS,
): Uint8Array {
  const log = fakeCiscoJobSarif(subjects, path, [], {
    version: request.expected.analyzerVersion,
    lockSha256: request.expected.lockSha256,
  });
  const [run] = log.runs as Record<string, unknown>[];
  if (run !== undefined) run.properties = { path };
  return new TextEncoder().encode(JSON.stringify(log));
}

interface FakeShardRequest {
  readonly sourceRoot: string;
  readonly jobs: readonly { id: string; path: string; inputSha256: string }[];
  readonly expected: { analyzerVersion: string; lockSha256: string };
  readonly executionProfileId: string;
  readonly concurrency: number;
}

function fakeScan(
  respond: (request: FakeShardRequest) => unknown,
  lockSha256: string = LOCK,
): { importer: () => Promise<unknown>; requests: FakeShardRequest[] } {
  const requests: FakeShardRequest[] = [];
  const module = {
    listDetectorCapabilitiesV1: () => [
      {
        detectorId: "detector.cisco",
        analyzerVersion: "2.1.0",
        executionProfiles: [
          { id: "host-process-uv-v1", analyzerLock: { path: "uv.lock", sha256: lockSha256 } },
        ],
      },
    ],
    runCiscoShardV1: async (request: FakeShardRequest) => {
      requests.push(request);
      return respond(request);
    },
  };
  return { importer: () => Promise.resolve(module), requests };
}

function succeeded(
  request: FakeShardRequest,
  change?: (outputs: unknown[]) => unknown[],
  subjects: HandJobSubjectsForTests = JOB_SUBJECTS,
) {
  const outputs = request.jobs.map((job) => {
    const sarif = sarifBytes(request, job.path, subjects);
    return {
      jobId: job.id,
      path: job.path,
      inputSha256: job.inputSha256,
      sarif,
      sha256: createHash("sha256").update(sarif).digest("hex"),
    };
  });
  return {
    outcome: "succeeded",
    executionProfile: {
      id: request.executionProfileId,
      analyzerLock: { path: "uv.lock", sha256: request.expected.lockSha256 },
    },
    producer: { package: "@aihq/scan", version: "0.5.0" },
    analyzer: {
      version: request.expected.analyzerVersion,
      lockSha256: request.expected.lockSha256,
    },
    outputs: change === undefined ? outputs : change(outputs),
  };
}

const options = { executionProfileId: "host-process-uv-v1", concurrency: 2 } as const;

describe("runCiscoSourceShardThroughScanV1", () => {
  it("sends the shard's jobs in manifest order and returns Core's shard result", async () => {
    const root = sourceRoot();
    const manifest = manifestFor(root);
    const scan = fakeScan((request) => succeeded(request));
    const shardId = manifest.shards[0]?.id ?? "";
    const result = await runCiscoSourceShardThroughScanV1(root, manifest, shardId, {
      ...options,
      importer: scan.importer,
    });
    expect(scan.requests).toHaveLength(1);
    expect(scan.requests[0]).toMatchObject({
      jobs: manifest.jobs.map(({ id, path, inputSha256 }) => ({ id, path, inputSha256 })),
      expected: { analyzerVersion: "2.1.0", lockSha256: LOCK },
      executionProfileId: "host-process-uv-v1",
      concurrency: 2,
    });
    expect(result.manifestSha256).toBe(manifest.manifestSha256);
    expect(result.outputs.map((output) => output.path)).toEqual(["skills/alpha", "skills/beta"]);
    expect(result.outputs[0]?.evidence).toMatchObject({ version: "2.1.0" });
  });

  it("refuses before running when the profile's analyzer lock is not the one Core accepts", async () => {
    const root = sourceRoot();
    const manifest = manifestFor(root);
    const scan = fakeScan((request) => succeeded(request), "b".repeat(64));
    const error = await runCiscoSourceShardThroughScanV1(
      root,
      manifest,
      manifest.shards[0]?.id ?? "",
      { ...options, importer: scan.importer },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScanPackageRefusalError);
    expect((error as Error).message).toContain(
      `detector.cisco under host-process-uv-v1 declares analyzer 2.1.0 with uv.lock ${"b".repeat(64)}; Core accepts 2.1.0 with uv.lock ${LOCK}`,
    );
    expect(scan.requests).toHaveLength(0);
  });

  it("refuses before running a manifest bound to a lock Core does not accept", async () => {
    const root = sourceRoot();
    const other = "a".repeat(64);
    const manifest = manifestFor(root, other);
    const scan = fakeScan((request) => succeeded(request));
    await expect(
      runCiscoSourceShardThroughScanV1(root, manifest, manifest.shards[0]?.id ?? "", {
        ...options,
        importer: scan.importer,
      }),
    ).rejects.toThrow(
      `Cisco shard manifest names analyzer lock ${other}; Core accepts ${LOCK} under host-process-uv-v1`,
    );
    expect(scan.requests).toHaveLength(0);
  });

  it("rejects a shard run whose executed profile names another analyzer lock", async () => {
    const root = sourceRoot();
    const manifest = manifestFor(root);
    const scan = fakeScan((request) => ({
      ...succeeded(request),
      executionProfile: {
        id: request.executionProfileId,
        analyzerLock: { path: "uv.lock", sha256: "c".repeat(64) },
      },
    }));
    await expect(
      runCiscoSourceShardThroughScanV1(root, manifest, manifest.shards[0]?.id ?? "", {
        ...options,
        importer: scan.importer,
      }),
    ).rejects.toThrow(
      `Cisco shard ran under an execution profile with uv.lock ${"c".repeat(64)}; Core accepts ${LOCK}`,
    );
  });

  it("throws the typed refusal when @aihq/scan is not installed", async () => {
    const root = sourceRoot();
    const manifest = manifestFor(root);
    const error = await runCiscoSourceShardThroughScanV1(
      root,
      manifest,
      manifest.shards[0]?.id ?? "",
      {
        ...options,
        importer: () =>
          Promise.reject(
            Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" }),
          ),
      },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ScanPackageRefusalError);
    expect((error as ScanPackageRefusalError).refusal.reason).toBe("scan-package-unavailable");
  });

  it.each([
    ["a missing output", (outputs: unknown[]) => outputs.slice(1), "exactly one output per job"],
    ["reordered outputs", (outputs: unknown[]) => [...outputs].reverse(), "does not name job"],
    [
      "bytes that do not match their digest",
      (outputs: unknown[]) =>
        outputs.map((output) => ({ ...(output as object), sha256: "c".repeat(64) })),
      "not bound to its own digest",
    ],
    [
      "output that is not SARIF",
      (outputs: unknown[]) =>
        outputs.map((output) => {
          const sarif = new TextEncoder().encode("{}");
          return {
            ...(output as object),
            sarif,
            sha256: createHash("sha256").update(sarif).digest("hex"),
          };
        }),
      "is refused: Scan returned SARIF version missing, expected SARIF 2.1.0",
    ],
  ])("rejects %s", async (_label, change, message) => {
    const root = sourceRoot();
    const manifest = manifestFor(root);
    const scan = fakeScan((request) => succeeded(request, change));
    await expect(
      runCiscoSourceShardThroughScanV1(root, manifest, manifest.shards[0]?.id ?? "", {
        ...options,
        importer: scan.importer,
      }),
    ).rejects.toThrow(message);
  });

  it("reports Scan's refusal and failure in Scan's own words", async () => {
    const root = sourceRoot();
    const manifest = manifestFor(root);
    const shardId = manifest.shards[0]?.id ?? "";
    const refused = fakeScan(() => ({
      outcome: "refused",
      reason: "analyzer-unavailable",
      detail: "uv is not on PATH",
    }));
    await expect(
      runCiscoSourceShardThroughScanV1(root, manifest, shardId, {
        ...options,
        importer: refused.importer,
      }),
    ).rejects.toThrow("analyzer-unavailable: uv is not on PATH");
    const failed = fakeScan(() => ({
      outcome: "failed",
      failure: { stage: "analyzer-execution", detail: "exit 2" },
    }));
    await expect(
      runCiscoSourceShardThroughScanV1(root, manifest, shardId, {
        ...options,
        importer: failed.importer,
      }),
    ).rejects.toThrow("analyzer-execution: exit 2");
  });

  it.each([
    [
      "results: null",
      { version: "2.1.0", runs: [{ results: null }] },
      "whose run 0 has no results array",
    ],
    ["no results", { version: "2.1.0", runs: [{}] }, "whose run 0 has no results array"],
    [
      "a run that is not an object",
      { version: "2.1.0", runs: [7] },
      "whose run 0 is not an object",
    ],
    [
      "a result that is not an object",
      { version: "2.1.0", runs: [{ results: ["x"] }] },
      "whose run 0 result 0 is not an object",
    ],
    [
      "a URI outside the source root",
      {
        version: "2.1.0",
        runs: [
          {
            results: [
              {
                ruleId: "X",
                locations: [
                  {
                    physicalLocation: {
                      artifactLocation: { uri: "/aih/source/skills/alpha/SKILL.md" },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      "which is not relative to the declared source root",
    ],
  ])("refuses digest-bound job SARIF with %s", async (_label, log, reason) => {
    const root = sourceRoot();
    const manifest = manifestFor(root);
    const shardId = manifest.shards[0]?.id ?? "";
    const scan = fakeScan((request) =>
      succeeded(request, (outputs) =>
        outputs.map((output) => {
          const sarif = new TextEncoder().encode(JSON.stringify(log));
          return {
            ...(output as Record<string, unknown>),
            sarif,
            sha256: createHash("sha256").update(sarif).digest("hex"),
          };
        }),
      ),
    );
    await expect(
      runCiscoSourceShardThroughScanV1(root, manifest, shardId, {
        ...options,
        importer: scan.importer,
      }),
    ).rejects.toThrow(`Cisco shard output for skills/alpha is refused: Scan returned SARIF`);
    await expect(
      runCiscoSourceShardThroughScanV1(root, manifest, shardId, {
        ...options,
        importer: scan.importer,
      }),
    ).rejects.toThrow(reason);
  });

  it("rejects a shard run under an analyzer version other than the one Core asked for", async () => {
    const root = sourceRoot();
    const manifest = manifestFor(root);
    const scan = fakeScan((request) => ({
      ...succeeded(request),
      analyzer: { version: "2.0.15", lockSha256: request.expected.lockSha256 },
    }));
    await expect(
      runCiscoSourceShardThroughScanV1(root, manifest, manifest.shards[0]?.id ?? "", {
        ...options,
        importer: scan.importer,
      }),
    ).rejects.toThrow("Cisco shard ran analyzer version 2.0.15 instead of the manifest's 2.1.0");
  });

  it("refuses a job whose SARIF does not prove it analyzed the job's files", async () => {
    const root = sourceRoot();
    const manifest = manifestFor(root);
    const rebound = (bytes: Uint8Array, edit: (evidence: Record<string, unknown>) => void) => {
      const log = JSON.parse(new TextDecoder().decode(bytes));
      edit(log.runs[0].invocations[0].properties.aihScanCompletionV1);
      return new TextEncoder().encode(JSON.stringify(log));
    };
    const cases: [string, (evidence: Record<string, unknown>) => void, string][] = [
      [
        "another subject",
        (evidence) => {
          evidence.subjectTreeSha256 = "0".repeat(64);
        },
        `; the subject Core submitted has 1 files with subject tree`,
      ],
      [
        "another detector",
        (evidence) => {
          evidence.detectorId = "detector.semgrep";
        },
        `completion evidence for "detector.semgrep", not the requested detector.cisco`,
      ],
      [
        "another analyzer lock",
        (evidence) => {
          evidence.analyzer = { version: "2.1.0", lockSha256: "a".repeat(64) };
        },
        `completion evidence for analyzer "2.1.0" with uv.lock ${"a".repeat(64)}; Core accepts 2.1.0 with uv.lock ${LOCK}`,
      ],
    ];
    for (const [, edit, reason] of cases) {
      const scan = fakeScan((request) =>
        succeeded(request, (outputs) =>
          outputs.map((output) => {
            const record = output as { sarif: Uint8Array };
            const sarif = rebound(record.sarif, edit);
            return {
              ...record,
              sarif,
              sha256: createHash("sha256").update(sarif).digest("hex"),
            };
          }),
        ),
      );
      await expect(
        runCiscoSourceShardThroughScanV1(root, manifest, manifest.shards[0]?.id ?? "", {
          ...options,
          importer: scan.importer,
        }),
      ).rejects.toThrow(reason);
    }
  });

  it("rejects a source that changed while Scan ran", async () => {
    const root = sourceRoot();
    const manifest = manifestFor(root);
    const scan = fakeScan((request) => {
      writeFileSync(join(root, "skills", "alpha", "SKILL.md"), "changed\n");
      // Scan sealed the changed file, so its evidence names it (by hand, as
      // above, over "changed\n"): what refuses the run is the manifest identity.
      return succeeded(request, undefined, {
        ...JOB_SUBJECTS,
        "skills/alpha": "eb4d1470e14569537ac9863a69f705597909b39f3e4a687ac5e2f89a5a52eb0d",
      });
    });
    await expect(
      runCiscoSourceShardThroughScanV1(root, manifest, manifest.shards[0]?.id ?? "", {
        ...options,
        importer: scan.importer,
      }),
    ).rejects.toThrow("does not match the exact manifest identity");
  });

  it("passes cancellation through and reports it as cancelled", async () => {
    const root = sourceRoot();
    const manifest = manifestFor(root);
    const controller = new AbortController();
    const scan = fakeScan(() => {
      controller.abort();
      return { outcome: "failed", failure: { stage: "cancelled", detail: "aborted" } };
    });
    await expect(
      runCiscoSourceShardThroughScanV1(root, manifest, manifest.shards[0]?.id ?? "", {
        ...options,
        signal: controller.signal,
        importer: scan.importer,
      }),
    ).rejects.toBeInstanceOf(TrustScanCancelledError);
  });
});
