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

const LOCK = "a".repeat(64);
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

function manifestFor(root: string) {
  return buildCiscoSourceShardManifest(root, {
    source: { id: "fixture", pinnedSha: "0".repeat(40) },
    analyzer: { version: "2.0.14+uvlock.aaaaaaaaaaaa", lockSha256: LOCK },
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
    executionProfile: { id: request.executionProfileId },
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

  it("refuses before running when the profile's analyzer lock is not the manifest's", async () => {
    const root = sourceRoot();
    const manifest = manifestFor(root);
    const scan = fakeScan((request) => succeeded(request), "b".repeat(64));
    await expect(
      runCiscoSourceShardThroughScanV1(root, manifest, manifest.shards[0]?.id ?? "", {
        ...options,
        importer: scan.importer,
      }),
    ).rejects.toThrow("analyzer lock does not match manifest identity");
    expect(scan.requests).toHaveLength(0);
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
      "not a SARIF 2.1.0 log",
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
