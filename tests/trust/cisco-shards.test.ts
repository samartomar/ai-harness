import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCiscoSourceShardThroughScanV1 } from "../../src/trust/cisco-shard-delegation.js";
import {
  buildCiscoShardManifest,
  buildCiscoShardResult,
  buildCiscoShardResultAsync,
  type CiscoShardJobInput,
  joinCiscoShardResults,
} from "../../src/trust/cisco-shards.js";
import { buildCiscoSourceShardManifest, joinedCiscoShardSarif } from "../../src/trust/detectors.js";

const SOURCE_SHA = "a".repeat(40);
const SOURCE_TREE = "b".repeat(64);
const INPUT_HASHES = ["1", "2", "3", "4", "5"].map((value) => value.repeat(64));
// The Cisco host-profile lock Core accepts (ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1).
const LOCK_SHA256 = "108c4f78340db9488bd73a03967055b19cdd3e8ece16ed31289e03f89e27d58f";
const roots: string[] = [];

interface FakeShardRequest {
  readonly sourceRoot: string;
  readonly jobs: readonly { id: string; path: string; inputSha256: string }[];
  readonly expected: { analyzerVersion: string; lockSha256: string };
  readonly executionProfileId: string;
}

/** A stand-in for the installed @aihq/scan Cisco shard runner (see cisco-shard-delegation.test.ts). */
function fakeCiscoShardScan(respond: (request: FakeShardRequest) => unknown): {
  importer: () => Promise<unknown>;
  requests: FakeShardRequest[];
} {
  const requests: FakeShardRequest[] = [];
  const module = {
    listDetectorCapabilitiesV1: () => [
      {
        detectorId: "detector.cisco",
        analyzerVersion: "2.0.14",
        executionProfiles: [
          { id: "host-process-uv-v1", analyzerLock: { path: "uv.lock", sha256: LOCK_SHA256 } },
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function jobs(): CiscoShardJobInput[] {
  return INPUT_HASHES.map((inputSha256, index) => ({
    path: `skills/skill-${index}`,
    inputSha256,
  }));
}

function manifest(shardCount = 3) {
  return buildCiscoShardManifest({
    source: {
      id: "ecc",
      pinnedSha: SOURCE_SHA,
      treeSha256: SOURCE_TREE,
    },
    analyzer: {
      name: "cisco",
      version: "2.0.14",
      lockSha256: LOCK_SHA256,
    },
    policy: {
      version: "native.test",
      profile: "ecc-full",
    },
    jobs: jobs(),
    shardCount,
  });
}

function resultsFor(plan = manifest()) {
  return plan.shards.map((shard) =>
    buildCiscoShardResult(plan, shard.id, (job) => ({
      version: "2.1.0",
      runs: [{ results: [{ ruleId: "fixture", message: { text: job.path } }] }],
    })),
  );
}

describe("Cisco exact-source shard evidence", () => {
  it("assigns every exact input once with deterministic round-robin shards", () => {
    const first = manifest();
    const second = manifest();

    expect(second).toEqual(first);
    expect(first.shards.map((shard) => shard.jobs.map((job) => job.path))).toEqual([
      ["skills/skill-0", "skills/skill-3"],
      ["skills/skill-1", "skills/skill-4"],
      ["skills/skill-2"],
    ]);
    expect(new Set(first.shards.flatMap((shard) => shard.jobs.map((job) => job.id))).size).toBe(5);
  });

  it("joins byte-identically regardless of worker completion order", () => {
    const plan = manifest();
    const results = resultsFor(plan);

    expect(JSON.stringify(joinCiscoShardResults(plan, [...results].reverse()))).toBe(
      JSON.stringify(joinCiscoShardResults(plan, results)),
    );
  });

  it("fails closed for a missing shard", () => {
    const plan = manifest();
    expect(() => joinCiscoShardResults(plan, resultsFor(plan).slice(0, -1))).toThrow(
      /missing Cisco shard result/i,
    );
  });

  it("fails closed for duplicate and unexpected shard results", () => {
    const plan = manifest();
    const results = resultsFor(plan);
    const first = results[0];
    if (first === undefined) throw new Error("fixture result missing");

    expect(() => joinCiscoShardResults(plan, [...results, first])).toThrow(
      /duplicate Cisco shard result/i,
    );
    expect(() =>
      joinCiscoShardResults(plan, [...results.slice(1), { ...first, shardId: "999-of-999" }]),
    ).toThrow(/unexpected Cisco shard result/i);
  });

  it("fails closed when source, analyzer, job, or evidence identity drifts", () => {
    const plan = manifest();
    const results = resultsFor(plan);
    const first = results[0];
    if (first === undefined) throw new Error("fixture result missing");
    const firstOutput = first.outputs[0];
    if (firstOutput === undefined) throw new Error("fixture output missing");

    expect(() =>
      joinCiscoShardResults(plan, [
        { ...first, manifestSha256: "d".repeat(64) },
        ...results.slice(1),
      ]),
    ).toThrow(/manifest identity/i);
    expect(() =>
      joinCiscoShardResults(plan, [
        {
          ...first,
          outputs: [{ ...firstOutput, inputSha256: "e".repeat(64) }, ...first.outputs.slice(1)],
        },
        ...results.slice(1),
      ]),
    ).toThrow(/input identity/i);
    expect(() =>
      joinCiscoShardResults(plan, [
        {
          ...first,
          outputs: [{ ...firstOutput, evidenceSha256: "f".repeat(64) }, ...first.outputs.slice(1)],
        },
        ...results.slice(1),
      ]),
    ).toThrow(/evidence digest/i);
    expect(() =>
      joinCiscoShardResults(plan, [
        { ...first, analyzer: { ...first.analyzer, version: "drifted" } },
        ...results.slice(1),
      ]),
    ).toThrow(/analyzer identity/i);
    expect(() =>
      joinCiscoShardResults({ ...plan, policy: { ...plan.policy, profile: "drifted" } }, results),
    ).toThrow(/manifest identity does not match/i);
    expect(() =>
      joinCiscoShardResults(plan, [
        {
          ...first,
          outputs: [{ ...firstOutput, jobId: "unexpected" }, ...first.outputs.slice(1)],
        },
        ...results.slice(1),
      ]),
    ).toThrow(/unexpected Cisco job output/i);
    expect(() =>
      joinCiscoShardResults(plan, [
        { ...first, outputs: [firstOutput, firstOutput, ...first.outputs.slice(1)] },
        ...results.slice(1),
      ]),
    ).toThrow(/duplicate Cisco job output/i);
  });

  it("validates shard plans, evidence values, worker concurrency, and worker failures", async () => {
    const plan = manifest();
    const firstShard = plan.shards[0];
    if (firstShard === undefined) throw new Error("fixture shard missing");

    expect(() => manifest(0)).toThrow(/positive integer/);
    expect(() =>
      buildCiscoShardManifest({
        source: { ...plan.source, pinnedSha: "not-a-pin" },
        analyzer: plan.analyzer,
        policy: plan.policy,
        jobs: jobs(),
        shardCount: 1,
      }),
    ).toThrow(/40-character Git SHA/);
    expect(() =>
      buildCiscoShardManifest({
        source: plan.source,
        analyzer: plan.analyzer,
        policy: plan.policy,
        jobs: [{ path: "../escape", inputSha256: INPUT_HASHES[0] as string }],
        shardCount: 1,
      }),
    ).toThrow(/safe POSIX/);
    expect(() => buildCiscoShardResult(plan, firstShard.id, () => 1n)).toThrow(
      /unsupported bigint/,
    );
    expect(() =>
      buildCiscoShardResult(
        { ...plan, policy: { ...plan.policy, profile: "drifted" } },
        firstShard.id,
        () => ({}),
      ),
    ).toThrow(/manifest identity/);
    await expect(
      buildCiscoShardResultAsync(plan, firstShard.id, async () => ({}), 0),
    ).rejects.toThrow(/concurrency/);
    await expect(
      buildCiscoShardResultAsync(plan, firstShard.id, async () => {
        throw new Error("worker failed");
      }),
    ).rejects.toThrow(/worker failed/);
  });

  it("runs disjoint source shards through Scan and joins their SARIF in source order", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-cisco-shards-"));
    roots.push(root);
    for (const name of ["alpha", "beta", "gamma"]) {
      const skillDir = join(root, "skills", name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
    }
    const plan = buildCiscoSourceShardManifest(root, {
      source: { id: "ecc", pinnedSha: SOURCE_SHA },
      analyzer: { version: "2.0.14", lockSha256: LOCK_SHA256 },
      policy: { version: "native.test", profile: "ecc-full" },
      shardCount: 2,
    });
    // Scan returns each job's SARIF with URIs relative to the declared source root (C2).
    const scan = fakeCiscoShardScan((request) => ({
      outcome: "succeeded",
      executionProfile: {
        id: request.executionProfileId,
        analyzerLock: { path: "uv.lock", sha256: LOCK_SHA256 },
      },
      analyzer: { version: request.expected.analyzerVersion, lockSha256: LOCK_SHA256 },
      outputs: request.jobs.map((job) => {
        const heading = readFileSync(join(request.sourceRoot, job.path, "SKILL.md"), "utf8");
        const sarif = new TextEncoder().encode(
          JSON.stringify({
            version: "2.1.0",
            runs: [
              {
                results: [
                  {
                    ruleId: "fixture",
                    message: { text: heading.trim() },
                    locations: [
                      {
                        physicalLocation: {
                          artifactLocation: { uri: `${job.path}/SKILL.md` },
                          region: { startLine: 1 },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        );
        return {
          jobId: job.id,
          path: job.path,
          inputSha256: job.inputSha256,
          sarif,
          sha256: createHash("sha256").update(sarif).digest("hex"),
        };
      }),
    }));
    const workerResults = await Promise.all(
      [...plan.shards].reverse().map((shard) =>
        runCiscoSourceShardThroughScanV1(root, plan, shard.id, {
          executionProfileId: "host-process-uv-v1",
          concurrency: 2,
          importer: scan.importer,
        }),
      ),
    );
    const joined = joinCiscoShardResults(plan, workerResults);
    const sarif = JSON.parse(joinedCiscoShardSarif(joined)) as {
      runs: Array<{
        results: Array<{
          message: { text: string };
          locations: Array<{
            physicalLocation: { artifactLocation: { uri: string } };
          }>;
        }>;
      }>;
    };

    expect(scan.requests.map((request) => request.jobs.map((job) => job.path))).toEqual([
      ["skills/beta"],
      ["skills/alpha", "skills/gamma"],
    ]);
    expect(joined.outputs.map((output) => output.path)).toEqual([
      "skills/alpha",
      "skills/beta",
      "skills/gamma",
    ]);
    expect(
      sarif.runs.map(
        (runEntry) => runEntry.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri,
      ),
    ).toEqual(["skills/alpha/SKILL.md", "skills/beta/SKILL.md", "skills/gamma/SKILL.md"]);
  });

  it("refuses to run a shard after its exact source input drifts", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-cisco-shards-drift-"));
    roots.push(root);
    const skillDir = join(root, "skills", "alpha");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# alpha\n", "utf8");
    const plan = buildCiscoSourceShardManifest(root, {
      source: { id: "ecc", pinnedSha: SOURCE_SHA },
      analyzer: { version: "2.0.14", lockSha256: LOCK_SHA256 },
      policy: { version: "native.test", profile: "ecc-full" },
      shardCount: 1,
    });
    writeFileSync(join(skillDir, "SKILL.md"), "# changed\n", "utf8");
    const shard = plan.shards[0];
    if (shard === undefined) throw new Error("fixture shard missing");
    const scan = fakeCiscoShardScan(() => {
      throw new Error("Scan must not run a drifted shard");
    });

    await expect(
      runCiscoSourceShardThroughScanV1(root, plan, shard.id, {
        executionProfileId: "host-process-uv-v1",
        concurrency: 1,
        importer: scan.importer,
      }),
    ).rejects.toThrow(/source tree.*exact manifest identity/i);
    expect(scan.requests).toEqual([]);
  });
});
