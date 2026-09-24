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

// ---------------------------------------------------------------------------
// Core builds the Cisco source manifest; the installed @aihq/scan runs a shard's
// jobs (C2a §3.7). Core binds the run to the profile's published analyzer lock
// and accepts only complete, ordered, digest-bound SARIF for exactly its jobs.
// ---------------------------------------------------------------------------

// The Cisco host-profile lock Core accepts (ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1).
const LOCK = "108c4f78340db9488bd73a03967055b19cdd3e8ece16ed31289e03f89e27d58f";
const roots: string[] = [];

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
    analyzer: { version: `2.0.14+uvlock.${lockSha256.slice(0, 12)}`, lockSha256 },
    policy: { version: "native.test", profile: "fixture:source-wide-inventory" },
    shardCount: 1,
  });
}

function sarifBytes(path: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "skill-scanner" } }, results: [], properties: { path } }],
    }),
  );
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
        analyzerVersion: "2.0.14",
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

function succeeded(request: FakeShardRequest, change?: (outputs: unknown[]) => unknown[]) {
  const outputs = request.jobs.map((job) => {
    const sarif = sarifBytes(job.path);
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
      expected: { analyzerVersion: "2.0.14", lockSha256: LOCK },
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
      `detector.cisco under host-process-uv-v1 declares analyzer 2.0.14 with uv.lock ${"b".repeat(64)}; Core accepts 2.0.14 with uv.lock ${LOCK}`,
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
    ).rejects.toThrow("Cisco shard ran analyzer version 2.0.15 instead of the manifest's 2.0.14");
  });

  it("rejects a source that changed while Scan ran", async () => {
    const root = sourceRoot();
    const manifest = manifestFor(root);
    const scan = fakeScan((request) => {
      writeFileSync(join(root, "skills", "alpha", "SKILL.md"), "changed\n");
      return succeeded(request);
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
