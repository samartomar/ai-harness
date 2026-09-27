import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultComponentScanner } from "../../src/baseline-evidence/vet.js";
import type { Check } from "../../src/internals/verify.js";
import {
  buildCiscoShardResult,
  type CiscoShardJob,
  joinCiscoShardResults,
} from "../../src/trust/cisco-shards.js";
import {
  buildCiscoSourceShardManifest,
  type CiscoShardJoinProjectionResultV1,
  type PrecomputedDetectorSarifV1,
  ProjectionCleanupRejectionV1,
  projectionCleanupFailureOfV1,
  runTrustDetectors,
  type TrustDetectorResult,
  withCiscoShardJoinProjectionV1,
} from "../../src/trust/detectors.js";
import { buildTrustFileInventory } from "../../src/trust/inventory.js";

// ---------------------------------------------------------------------------
// An I/O error while Core reads a projection's identity, resolves it, or
// copies its jobs fails the Cisco detector with a typed refusal naming the
// path and the error code: never a rejected scan, never a completed one. A
// projection Core cannot prepare is never scanned, and a projection Core
// cannot remove leaves the result standing with a typed cleanup diagnostic.
// Errors are injected through a node:fs mock scoped to this file, and each
// keeps failing once it starts, as a permission change would; every other
// call passes through. Job digests are computed by hand with plain node:crypto.
// ---------------------------------------------------------------------------

const PROJECTION = ".aih-cisco-shard-projection-";
/** Either projection a component scan can leave behind: Core's shard projection or vet's own. */
const ANY_PROJECTION = /\.aih-(cisco-shard-projection|baseline-component)-/;
const inject = vi.hoisted(() => ({
  /** Fail every bigint lstat of a projection directory from the Nth on (0: none). */
  identityCall: 0,
  identityCalls: 0,
  /** Fail every realpath of a projection directory. */
  realpath: false,
  realpathCalls: 0,
  /** Fail every lstat of a source job file (set after the join is built: the copy filter). */
  copy: false,
  /** Fail every rm of a projection directory, Core's or vet's. */
  rm: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const eacces = (syscall: string, path: unknown) =>
    Object.assign(new Error(`EACCES: permission denied, ${syscall} '${String(path)}'`), {
      code: "EACCES",
      syscall,
      path: String(path),
    });
  const lstatSync = ((path: string, options?: { bigint?: boolean }) => {
    if (options?.bigint === true && String(path).includes(PROJECTION)) {
      inject.identityCalls += 1;
      if (inject.identityCall > 0 && inject.identityCalls >= inject.identityCall)
        throw eacces("lstat", path);
    } else if (
      inject.copy &&
      options === undefined &&
      String(path).includes("aih-shard-identity-") &&
      String(path).endsWith("SKILL.md")
    ) {
      throw eacces("lstat", path);
    }
    return actual.lstatSync(path, options as never);
  }) as typeof actual.lstatSync;
  const native = ((path: string, options?: never) => {
    if (String(path).includes(PROJECTION)) {
      inject.realpathCalls += 1;
      if (inject.realpath) throw eacces("realpath", path);
    }
    return actual.realpathSync.native(path, options);
  }) as typeof actual.realpathSync.native;
  const realpathSync = Object.assign(
    ((path: string, options?: never) =>
      actual.realpathSync(path, options)) as typeof actual.realpathSync,
    { native },
  );
  const rmSync = ((path: string, options?: never) => {
    if (inject.rm && ANY_PROJECTION.test(String(path))) throw eacces("rm", path);
    return actual.rmSync(path, options);
  }) as typeof actual.rmSync;
  return {
    ...actual,
    default: { ...actual, lstatSync, realpathSync, rmSync },
    lstatSync,
    realpathSync,
    rmSync,
  };
});

const CISCO_LOCK = "1e98c5679994dc56f82c1d88a77528d4c4b076160aff85b4d97ce239360bc210";
/** subject-files-v1 of `skills/alpha/SKILL.md` holding "# alpha\n", by hand. */
const ALPHA = "439283bdb63ecb24c6a5af487d4a88163b4a7de486efa7d844cb1fb6e0db379a";

let source: string;
/** Projections a test left behind on purpose (a failed cleanup), removed afterwards. */
const leftBehind: string[] = [];

beforeEach(() => {
  Object.assign(inject, {
    identityCall: 0,
    identityCalls: 0,
    realpath: false,
    realpathCalls: 0,
    copy: false,
    rm: false,
  });
  source = mkdtempSync(join(tmpdir(), "aih-shard-identity-"));
  mkdirSync(join(source, "skills", "alpha"), { recursive: true });
  writeFileSync(join(source, "skills", "alpha", "SKILL.md"), "# alpha\n", "utf8");
});

afterEach(() => {
  inject.rm = false;
  for (const path of leftBehind.splice(0)) rmSync(path, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

function jobSarif(job: CiscoShardJob): Record<string, unknown> {
  if (job.path !== "skills/alpha") throw new Error(`no vector for ${job.path}`);
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "cisco-ai-skill-scanner" } },
        invocations: [
          {
            executionSuccessful: true,
            properties: {
              aihScanCompletionV1: {
                detectorId: "detector.cisco",
                subjectTreeSha256: ALPHA,
                analyzedFileCount: 1,
                analyzer: { version: "2.1.0", lockSha256: CISCO_LOCK },
              },
            },
          },
        ],
        results: [],
      },
    ],
  };
}

function verifiedJoin() {
  const manifest = buildCiscoSourceShardManifest(source, {
    source: { id: "fixture", pinnedSha: "a".repeat(40) },
    analyzer: { version: "2.1.0", lockSha256: CISCO_LOCK },
    policy: { version: "native.test", profile: "fixture" },
    shardCount: 1,
  });
  const results = manifest.shards.map((shard) =>
    buildCiscoShardResult(manifest, shard.id, jobSarif),
  );
  return joinCiscoShardResults(manifest, results, source);
}

async function scanCisco(root: string, cisco: PrecomputedDetectorSarifV1) {
  return runTrustDetectors(root, {
    env: {},
    platform: "linux",
    posture: "enterprise",
    inventory: buildTrustFileInventory(root),
    detectors: ["cisco"],
    requiredDetectors: ["cisco"],
    precomputedSarif: { cisco },
  });
}

const scan = vi.fn((root: string, cisco: PrecomputedDetectorSarifV1) => scanCisco(root, cisco));

beforeEach(() => {
  scan.mockClear();
});

function projectAndScan(
  before: () => void = () => {},
): Promise<CiscoShardJoinProjectionResultV1<TrustDetectorResult>> {
  const joined = verifiedJoin();
  before();
  return withCiscoShardJoinProjectionV1(joined, ["skills/alpha"], (projection) =>
    scan(projection.root, projection.cisco),
  );
}

/** The scan's own result, when Core prepared the projection and scanned it. */
function scanned(
  outcome: CiscoShardJoinProjectionResultV1<TrustDetectorResult>,
): TrustDetectorResult {
  if (outcome.kind !== "scanned") throw new Error(`expected a scan, got ${outcome.kind}`);
  return outcome.result;
}

/** The failed Cisco detector Core returned without scanning a projection it could not prepare. */
function refusedUnscanned(
  outcome: CiscoShardJoinProjectionResultV1<TrustDetectorResult>,
): TrustDetectorResult {
  if (outcome.kind !== "refused") throw new Error(`expected a refusal, got ${outcome.kind}`);
  expect(scan).not.toHaveBeenCalled();
  return outcome.detector;
}

function expectRefused(result: TrustDetectorResult, reason: RegExp): void {
  expect(result.executions).toEqual([
    { detector: "cisco", executedBy: "precomputed-sarif", outcome: "failed" },
  ]);
  const detail =
    result.checks.find((check: Check) => check.name === "trust detector cisco")?.detail ?? "";
  expect(detail).toContain("precomputed SARIF for detector.cisco is refused: ");
  expect(detail).toMatch(reason);
}

describe("identity I/O errors fail the Cisco detector with a typed refusal", () => {
  it("completes when no error is injected", async () => {
    const outcome = await projectAndScan();
    expect(scanned(outcome).executions).toEqual([
      { detector: "cisco", executedBy: "precomputed-sarif", outcome: "completed" },
    ]);
    expect(outcome.cleanupFailure).toBeUndefined();
    // Creation, then acceptance before and after the rehash.
    expect(inject.identityCalls).toBe(3);
  });

  it("returns a refusal without scanning when the projection's identity keeps failing at creation", async () => {
    inject.identityCall = 1;
    const outcome = await projectAndScan();
    expectRefused(
      refusedUnscanned(outcome),
      /Core could not prepare the shard join's projection: .+\.aih-cisco-shard-projection-\S+ cannot be read \(EACCES\)/,
    );
    // No further read of the projection once its preparation failed.
    expect(inject.identityCalls).toBe(1);
    expect(inject.realpathCalls).toBe(0);
    expect(outcome.cleanupFailure).toBeUndefined();
  });

  it("refuses when the projection's identity keeps failing from before the rehash", async () => {
    inject.identityCall = 2;
    expectRefused(
      scanned(await projectAndScan()),
      /the identity of the projection directory Core created cannot be read before the jobs are rehashed: .+\.aih-cisco-shard-projection-\S+ cannot be read \(EACCES\)/,
    );
  });

  it("refuses when the projection's identity keeps failing from after the rehash", async () => {
    inject.identityCall = 3;
    expectRefused(
      scanned(await projectAndScan()),
      /the identity of the projection directory Core created cannot be read after the jobs were rehashed: .+\.aih-cisco-shard-projection-\S+ cannot be read \(EACCES\)/,
    );
  });

  it("returns a refusal without scanning when the projection keeps failing to resolve", async () => {
    inject.realpath = true;
    const outcome = await projectAndScan();
    expectRefused(
      refusedUnscanned(outcome),
      /Core could not prepare the shard join's projection: .+\.aih-cisco-shard-projection-\S+ cannot be resolved \(EACCES\)/,
    );
    // Creation's single identity read and single resolve: nothing after them.
    expect(inject.identityCalls).toBe(1);
    expect(inject.realpathCalls).toBe(1);
  });

  it("returns a refusal without scanning when a job keeps failing to read while Core copies it", async () => {
    const outcome = await projectAndScan(() => {
      inject.copy = true;
    });
    expectRefused(
      refusedUnscanned(outcome),
      /Core could not prepare the shard join's projection: .+aih-shard-identity-.+SKILL\.md cannot be read \(EACCES\)/,
    );
    expect(inject.realpathCalls).toBe(0);
  });
});

describe("a projection Core cannot remove never replaces the result", () => {
  const cleanupFailure = (path: string) => ({
    kind: "cisco-shard-projection-cleanup-failed-v1",
    path,
    code: "EACCES",
    detail: `Core could not remove the shard join's projection: ${path} cannot be removed (EACCES)`,
  });

  it("keeps a completed scan and reports the projection it could not remove", async () => {
    let root = "";
    const joined = verifiedJoin();
    const outcome = await withCiscoShardJoinProjectionV1(joined, ["skills/alpha"], (projection) => {
      root = projection.root;
      leftBehind.push(root);
      inject.rm = true;
      return scanCisco(projection.root, projection.cisco);
    });
    expect(scanned(outcome).executions).toEqual([
      { detector: "cisco", executedBy: "precomputed-sarif", outcome: "completed" },
    ]);
    expect(outcome.cleanupFailure).toEqual(cleanupFailure(root));
  });

  it("keeps a refusal and reports the projection it could not remove", async () => {
    inject.identityCall = 1;
    inject.rm = true;
    const outcome = await projectAndScan();
    expectRefused(refusedUnscanned(outcome), /cannot be read \(EACCES\)/);
    const path = outcome.cleanupFailure?.path ?? "";
    leftBehind.push(path);
    expect(path).toContain(PROJECTION);
    expect(outcome.cleanupFailure).toEqual(cleanupFailure(path));
  });

  it("rejects with the scan's own error, which carries the cleanup failure", async () => {
    const joined = verifiedJoin();
    const own = new Error("the scan itself failed", { cause: "the scan's own cause" });
    let root = "";
    const rejection = await withCiscoShardJoinProjectionV1(
      joined,
      ["skills/alpha"],
      async (projection) => {
        root = projection.root;
        leftBehind.push(root);
        inject.rm = true;
        throw own;
      },
    ).catch((error: unknown) => error);
    expect(rejection).toBe(own);
    expect(own.cause).toBe("the scan's own cause");
    expect(projectionCleanupFailureOfV1(rejection)).toEqual(cleanupFailure(root));
    expect((rejection as { cleanupFailure?: unknown }).cleanupFailure).toEqual(
      cleanupFailure(root),
    );
  });

  it.each([
    ["a frozen error", (): unknown => Object.freeze(new Error("frozen scan failure"))],
    ["a thrown string", (): unknown => "a thrown string"],
    [
      "an error already carrying a cleanup failure",
      (): unknown =>
        Object.assign(new Error("inner projection failed"), { cleanupFailure: "inner" }),
    ],
  ] as const)(
    "keeps %s as the cause of a rejection that carries the cleanup failure",
    async (_label, make) => {
      const joined = verifiedJoin();
      const thrown: unknown = make();
      let root = "";
      const rejection = await withCiscoShardJoinProjectionV1(
        joined,
        ["skills/alpha"],
        async (projection) => {
          root = projection.root;
          leftBehind.push(root);
          inject.rm = true;
          throw thrown;
        },
      ).catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(ProjectionCleanupRejectionV1);
      expect((rejection as Error).cause).toBe(thrown);
      expect(projectionCleanupFailureOfV1(rejection)).toEqual(cleanupFailure(root));
    },
  );
});

describe("baseline vet keeps a cleanup failure in what it returns or throws", () => {
  const cisco = (path: string) => ({
    kind: "cisco-shard-projection-cleanup-failed-v1",
    path,
    code: "EACCES",
    detail: `Core could not remove the shard join's projection: ${path} cannot be removed (EACCES)`,
  });
  const own = (path: string) => ({
    kind: "baseline-component-projection-cleanup-failed-v1",
    path,
    code: "EACCES",
    detail: `Core could not remove baseline component skill:alpha's projection: ${path} cannot be removed (EACCES)`,
  });
  const component = { id: "skill:alpha", paths: ["skills/alpha"] };
  const clean = { analyzersRun: ["aih-native"], checks: [] };

  it.each([
    ["Core's shard projection", true, cisco],
    ["vet's own projection", false, own],
  ] as const)(
    "returns the scan with the failure when %s cannot be removed and there is no progress",
    async (_label, shared, expected) => {
      const joined = verifiedJoin();
      let root = "";
      const scanTree = vi.fn(async (projectionRoot: string) => {
        root = projectionRoot;
        leftBehind.push(root);
        inject.rm = true;
        return clean;
      });
      const result = await defaultComponentScanner(
        {},
        scanTree,
        () => (shared ? ["cisco"] : []),
        shared ? joined : undefined,
      )({ sourceRoot: source, component });
      expect(scanTree).toHaveBeenCalledTimes(1);
      expect(result.analyzersRun).toEqual(["aih-native"]);
      expect(result.projectionCleanupFailures).toEqual([expected(root)]);
    },
  );

  it.each([
    ["Core's shard projection", true, cisco],
    ["vet's own projection", false, own],
  ] as const)(
    "rejects with the scan's own error, carrying the failure, when %s cannot be removed",
    async (_label, shared, expected) => {
      const joined = verifiedJoin();
      const failure = new Error("the component scan failed");
      let root = "";
      const scanTree = vi.fn(async (projectionRoot: string) => {
        root = projectionRoot;
        leftBehind.push(root);
        inject.rm = true;
        throw failure;
      });
      const rejection = await defaultComponentScanner(
        {},
        scanTree,
        () => (shared ? ["cisco"] : []),
        shared ? joined : undefined,
      )({ sourceRoot: source, component }).catch((error: unknown) => error);
      expect(rejection).toBe(failure);
      expect(projectionCleanupFailureOfV1(rejection)).toEqual(expected(root));
    },
  );
});

describe("baseline vet never scans a projection Core could not prepare", () => {
  it("returns the failed Cisco detector as the component's scan, and reports a failed cleanup", async () => {
    inject.identityCall = 1;
    inject.rm = true;
    const joined = verifiedJoin();
    const progress = vi.fn();
    const scanTree = vi.fn(async () => {
      throw new Error("a projection Core could not prepare must not be scanned");
    });
    const result = await defaultComponentScanner(
      { progress },
      scanTree,
      () => ["cisco"],
      joined,
    )({ sourceRoot: source, component: { id: "skill:alpha", paths: ["skills/alpha"] } });
    expect(scanTree).not.toHaveBeenCalled();
    expect(result.analyzersRun).toEqual([]);
    expect(result.detectorExecutions).toEqual([
      { detector: "cisco", executedBy: "precomputed-sarif", outcome: "failed" },
    ]);
    expect(result.checks).toEqual([
      expect.objectContaining({
        name: "trust detector cisco",
        verdict: "fail",
        code: "trust.detector-unavailable",
        detail: expect.stringMatching(
          /precomputed SARIF for detector\.cisco is refused: Core could not prepare the shard join's projection: .+ cannot be read \(EACCES\)/,
        ),
      }),
    ]);
    const lines = progress.mock.calls.map(([message]) => message as string);
    const removal = lines.find((line) => line.includes("could not remove")) ?? "";
    const left = /: (\S+\.aih-cisco-shard-projection-\S+) cannot be removed/.exec(removal)?.[1];
    if (left !== undefined) leftBehind.push(left);
    expect(result.projectionCleanupFailures).toEqual([
      expect.objectContaining({ kind: "cisco-shard-projection-cleanup-failed-v1", path: left }),
    ]);
    expect(removal).toMatch(
      /^baseline vet: component skill:alpha: Core could not remove the shard join's projection: .+\.aih-cisco-shard-projection-\S+ cannot be removed \(EACCES\)$/,
    );
  });
});
