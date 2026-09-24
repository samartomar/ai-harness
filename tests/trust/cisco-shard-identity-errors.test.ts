import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import {
  buildCiscoShardResult,
  type CiscoShardJob,
  joinCiscoShardResults,
} from "../../src/trust/cisco-shards.js";
import {
  buildCiscoSourceShardManifest,
  type PrecomputedDetectorSarifV1,
  runTrustDetectors,
  withCiscoShardJoinProjectionV1,
} from "../../src/trust/detectors.js";
import { buildTrustFileInventory } from "../../src/trust/inventory.js";

// ---------------------------------------------------------------------------
// An I/O error while Core reads a projection's identity, resolves it, or
// copies its jobs fails the Cisco detector with a typed refusal naming the
// path and the error code: never a rejected scan, never a completed one.
// Errors are injected through a node:fs mock scoped to this file; every other
// call passes through. Job digests are computed by hand with plain node:crypto.
// ---------------------------------------------------------------------------

const PROJECTION = ".aih-cisco-shard-projection-";
const inject = vi.hoisted(() => ({
  /** Fail the Nth bigint lstat of a projection directory (0: none). */
  identityCall: 0,
  identityCalls: 0,
  /** Fail the first realpath of a projection directory. */
  realpath: false,
  /** Fail the lstat of a source job file (set after the join is built: the copy filter). */
  copy: false,
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
      if (inject.identityCalls === inject.identityCall) throw eacces("lstat", path);
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
    if (inject.realpath && String(path).includes(PROJECTION)) {
      inject.realpath = false;
      throw eacces("realpath", path);
    }
    return actual.realpathSync.native(path, options);
  }) as typeof actual.realpathSync.native;
  const realpathSync = Object.assign(
    ((path: string, options?: never) =>
      actual.realpathSync(path, options)) as typeof actual.realpathSync,
    { native },
  );
  return { ...actual, default: { ...actual, lstatSync, realpathSync }, lstatSync, realpathSync };
});

const CISCO_LOCK = "108c4f78340db9488bd73a03967055b19cdd3e8ece16ed31289e03f89e27d58f";
/** subject-files-v1 of `skills/alpha/SKILL.md` holding "# alpha\n", by hand. */
const ALPHA = "439283bdb63ecb24c6a5af487d4a88163b4a7de486efa7d844cb1fb6e0db379a";

let source: string;

beforeEach(() => {
  Object.assign(inject, { identityCall: 0, identityCalls: 0, realpath: false, copy: false });
  source = mkdtempSync(join(tmpdir(), "aih-shard-identity-"));
  mkdirSync(join(source, "skills", "alpha"), { recursive: true });
  writeFileSync(join(source, "skills", "alpha", "SKILL.md"), "# alpha\n", "utf8");
});

afterEach(() => {
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
                analyzer: { version: "2.0.14", lockSha256: CISCO_LOCK },
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
    analyzer: { version: "2.0.14", lockSha256: CISCO_LOCK },
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

function projectAndScan(before: () => void = () => {}) {
  const joined = verifiedJoin();
  before();
  return withCiscoShardJoinProjectionV1(joined, ["skills/alpha"], (projection) =>
    scanCisco(projection.root, projection.cisco),
  );
}

function expectRefused(result: Awaited<ReturnType<typeof scanCisco>>, reason: RegExp): void {
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
    const result = await projectAndScan();
    expect(result.executions).toEqual([
      { detector: "cisco", executedBy: "precomputed-sarif", outcome: "completed" },
    ]);
    // Creation, then acceptance before and after the rehash.
    expect(inject.identityCalls).toBe(3);
  });

  it("refuses when the projection's identity cannot be read at creation", async () => {
    inject.identityCall = 1;
    expectRefused(
      await projectAndScan(),
      /Core could not prepare the shard join's projection: .+\.aih-cisco-shard-projection-\S+ cannot be read \(EACCES\)/,
    );
  });

  it("refuses when the projection's identity cannot be read before the rehash", async () => {
    inject.identityCall = 2;
    expectRefused(
      await projectAndScan(),
      /the identity of the projection directory Core created cannot be read before the jobs are rehashed: .+\.aih-cisco-shard-projection-\S+ cannot be read \(EACCES\)/,
    );
  });

  it("refuses when the projection's identity cannot be read after the rehash", async () => {
    inject.identityCall = 3;
    expectRefused(
      await projectAndScan(),
      /the identity of the projection directory Core created cannot be read after the jobs were rehashed: .+\.aih-cisco-shard-projection-\S+ cannot be read \(EACCES\)/,
    );
  });

  it("refuses when the projection cannot be resolved at creation", async () => {
    inject.realpath = true;
    expectRefused(
      await projectAndScan(),
      /Core could not prepare the shard join's projection: .+\.aih-cisco-shard-projection-\S+ cannot be resolved \(EACCES\)/,
    );
  });

  it("refuses when a job cannot be read while Core copies it into the projection", async () => {
    expectRefused(
      await projectAndScan(() => {
        inject.copy = true;
      }),
      /Core could not prepare the shard join's projection: .+aih-shard-identity-.+SKILL\.md cannot be read \(EACCES\)/,
    );
  });
});
