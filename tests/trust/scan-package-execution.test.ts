import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Check } from "../../src/internals/verify.js";
import type { ScanExecutionAdapterV1 } from "../../src/org-policy/governance-input-v1.js";
import { SCAN_PACKAGE_INSTALL_COMMAND } from "../../src/scan-package/load-scan-package.js";
import {
  CISCO_SKILL_SCANNER_ANALYZER,
  runTrustDetectors,
  SCAN_DELEGATED_TRUST_DETECTORS,
  type TrustDetectorName,
  trustRuntimeAdvisory,
} from "../../src/trust/detectors.js";
import { buildTrustFileInventory } from "../../src/trust/inventory.js";
import { scanTrustTreeWithAnalyzers } from "../../src/trust/scan.js";

// ---------------------------------------------------------------------------
// With no injected adapter, `aih trust scan` and `aih skill vet` load the
// INSTALLED @aihq/scan. Which detectors it runs is decided per detector and is
// data: SCAN_DELEGATED_TRUST_DETECTORS, empty until Scan's capabilities are
// genuine equivalents. Until then every Core detector keeps Core's execution
// and is recorded as `core-legacy`, and Scan's in-process `detector.aih-native`
// is recorded beside them as an identity observation (never a finding). A
// missing or incompatible Scan is stated explicitly, with the install command.
//
// The rule a delegated detector will follow (no fallback to Core, Scan's own
// refusal verbatim, the profile Scan ran under) is exercised here by naming a
// delegated set explicitly.
// ---------------------------------------------------------------------------

const loader = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("../../src/scan-package/load-scan-package.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/scan-package/load-scan-package.js")>()),
  loadScanExecutionAdapterV1: loader.load,
}));

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-scan-package-execution-"));
  loader.load.mockReset();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

const UNAVAILABLE = {
  ok: false,
  refusal: {
    reason: "scan-package-unavailable",
    detail: `@aihq/scan is not installed next to @aihq/core; this operation needs its public API. Install it with: ${SCAN_PACKAGE_INSTALL_COMMAND} (in a project: npm install @aihq/core @aihq/scan).`,
  },
} as const;

const HOST_ARCH = process.arch === "x64" ? "amd64" : process.arch;
const OTHER_ARCH = HOST_ARCH === "amd64" ? "arm64" : "amd64";

function capability(detectorId: string, profile = "linux-namespace-uv-v1") {
  return {
    protocol: "DetectorCapabilityV1",
    detectorId,
    analyzerIdentity: null,
    analyzerVersion: "0.0.0-test",
    subjectKinds: ["source-tree"],
    executionProfile: { id: profile },
    executionProfiles: [
      { id: profile, supportedPlatforms: [{ os: "linux", architecture: HOST_ARCH }] },
    ],
    outputs: ["sarif-2.1.0"],
  };
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const EMPTY_SARIF = JSON.stringify({
  version: "2.1.0",
  runs: [{ tool: { driver: { name: "stub" } }, results: [] }],
});

function succeeded(detectorId: string, profile: string) {
  const bytes = Buffer.from(EMPTY_SARIF, "utf8");
  return {
    outcome: "succeeded",
    capability: capability(detectorId, profile),
    executionProfile: { id: profile, isolation: "linux-namespace", network: "none" },
    producer: { name: "@aihq/scan", version: "0.4.0" },
    evidence: {
      kind: "baseline-analyzer-observation-v1",
      observation: {
        mediaType: "application/sarif+json",
        annex: { path: "annex/raw.json", sha256: sha256(bytes), byteLength: bytes.byteLength },
        bytes,
      },
    },
  };
}

const NATIVE_BYTES = Buffer.from('{"protocol":"BaselineNativeObservationV1","files":[]}', "utf8");

/** Shaped after Scan's succeeded `detector.aih-native` result (identity only, no findings). */
function nativeObservation(bytes = NATIVE_BYTES, annexSha256 = sha256(NATIVE_BYTES)) {
  return {
    outcome: "succeeded",
    capability: capability("detector.aih-native", "in-process-native-v1"),
    executionProfile: { id: "in-process-native-v1", isolation: "none", network: "none" },
    producer: { name: "@aihq/scan", version: "0.4.0" },
    evidence: {
      kind: "baseline-analyzer-observation-v1",
      observation: {
        analyzer: "aih-native",
        analyzerVersion: "native.014fbd614a5a",
        mediaType: "application/vnd.aih.baseline-native+json",
        annex: { path: "annex/aih-native.json", sha256: annexSha256, byteLength: bytes.byteLength },
        bytes,
      },
    },
  };
}

function installedScan(
  detectorIds: readonly string[],
  run: ScanExecutionAdapterV1["runDetectorV1"],
): ScanExecutionAdapterV1 & { readonly requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    listDetectorCapabilitiesV1: () =>
      detectorIds.map((id) =>
        capability(id, id === "detector.aih-native" ? "in-process-native-v1" : undefined),
      ),
    runDetectorV1: (request) => {
      requests.push(request);
      return run(request);
    },
  };
}

const requestedIds = (adapter: { readonly requests: unknown[] }) =>
  adapter.requests.map((request) => (request as { detectorId: string }).detectorId);

function detectorCheck(checks: readonly Check[], detector: string): Check | undefined {
  return checks.find((check) => check.name === `trust detector ${detector}`);
}

function recordingRunner() {
  const argvs: string[][] = [];
  const run = fakeRunner((argv) => {
    argvs.push([...argv]);
    return { code: 1, stdout: "", stderr: "probe refused by this test" };
  });
  return { argvs, run };
}

async function scan() {
  write("SKILL.md", "# Root skill\n\nNothing alarming here.\n");
  const { argvs, run } = recordingRunner();
  const result = await scanTrustTreeWithAnalyzers(dir, {
    env: {},
    platform: "linux",
    posture: "vibe",
    run,
  });
  return { argvs, result };
}

/** The Step 2 rule, exercised by naming the delegated set explicitly. */
async function delegatedRun(
  delegated: readonly TrustDetectorName[],
  options: {
    posture?: "vibe" | "enterprise";
    required?: TrustDetectorName[];
    platform?: "linux" | "windows" | "darwin";
  } = {},
) {
  write("SKILL.md", "# Root skill\n\nNothing alarming here.\n");
  const { argvs, run } = recordingRunner();
  const result = await runTrustDetectors(dir, {
    env: {},
    platform: options.platform ?? "linux",
    posture: options.posture ?? "vibe",
    run,
    inventory: buildTrustFileInventory(dir),
    delegatedDetectors: new Set(delegated),
    ...(options.required === undefined ? {} : { requiredDetectors: options.required }),
  });
  return { argvs, result };
}

const spawnedFor = (argvs: readonly string[][], needle: string) =>
  argvs.filter((argv) => argv.join(" ").includes(needle));

describe("installed @aihq/scan: default loading, executor naming, recorded observation", () => {
  it("delegates no Core detector to Scan yet", () => {
    expect([...SCAN_DELEGATED_TRUST_DETECTORS]).toEqual([]);
  });

  it("keeps Core's execution without Scan and states the package refusal explicitly", async () => {
    loader.load.mockResolvedValue(UNAVAILABLE);
    const { argvs, result } = await scan();

    expect(loader.load).toHaveBeenCalledTimes(1);
    // Core's own detectors still ran their own probes, and say who ran them.
    expect(spawnedFor(argvs, "uv").length).toBeGreaterThan(0);
    for (const detector of ["skillspector", "cisco", "semgrep", "snyk-agent-scan"]) {
      expect(result.detectorExecutions).toContainEqual({
        detector,
        executedBy: "core-legacy",
        outcome: "unavailable",
      });
      expect(detectorCheck(result.checks, detector)?.detail).not.toContain("scan-package");
    }
    expect(result.scanObservations).toEqual([
      {
        detectorId: "detector.aih-native",
        outcome: "unavailable",
        refusal: "scan-package-unavailable",
        detail: `scan-package-unavailable: ${UNAVAILABLE.refusal.detail}`,
      },
    ]);
    const advisory = trustRuntimeAdvisory(result.analyzersRun, {
      executions: result.detectorExecutions,
      observations: result.scanObservations,
    });
    expect(advisory.split("\n")[0]).toBe(
      "No findings != safe. Static analyzers actually run: aih-native.",
    );
    expect(advisory).toContain(
      "Detector executors: skillspector=core-legacy, cisco=core-legacy, semgrep=core-legacy, snyk-agent-scan=core-legacy.",
    );
    expect(advisory).toContain(
      `@aihq/scan observation detector.aih-native not recorded: scan-package-unavailable: @aihq/scan is not installed next to @aihq/core; this operation needs its public API. Install it with: ${SCAN_PACKAGE_INSTALL_COMMAND}`,
    );
  });

  it("records Scan's native identity observation and runs nothing else through Scan", async () => {
    const scanPackage = installedScan(
      ["detector.aih-native", "detector.cisco", "detector.semgrep", "detector.skillspector"],
      (request) =>
        Promise.resolve(
          (request as { detectorId: string }).detectorId === "detector.aih-native"
            ? nativeObservation()
            : succeeded("detector.cisco", "linux-namespace-uv-v1"),
        ),
    );
    loader.load.mockResolvedValue({ ok: true, adapter: scanPackage });
    const { result } = await scan();

    expect(requestedIds(scanPackage)).toEqual(["detector.aih-native"]);
    expect(scanPackage.requests[0]).toMatchObject({
      subject: {
        kind: "source-tree",
        sourceRoot: expect.any(String),
        selectedClosurePaths: ["SKILL.md"],
      },
    });
    expect(result.scanObservations).toEqual([
      {
        detectorId: "detector.aih-native",
        scanSource: "installed-package",
        outcome: "recorded",
        executionProfileId: "in-process-native-v1",
        producer: { name: "@aihq/scan", version: "0.4.0" },
        analyzer: "aih-native",
        analyzerVersion: "native.014fbd614a5a",
        annexSha256: sha256(NATIVE_BYTES),
      },
    ]);
    // It is an observation: Core's findings and analyzers are Core's own.
    expect(result.analyzersRun).toEqual(["aih-native"]);
    expect(result.detectorExecutions?.every((row) => row.executedBy === "core-legacy")).toBe(true);
    expect(
      trustRuntimeAdvisory(result.analyzersRun, { observations: result.scanObservations }),
    ).toContain(
      `@aihq/scan observation detector.aih-native recorded by the installed @aihq/scan (producer @aihq/scan@0.4.0) under execution profile in-process-native-v1: analyzer aih-native native.014fbd614a5a, annex sha256 ${sha256(NATIVE_BYTES)}. An identity observation, not a Core finding.`,
    );
  });

  it("refuses an observation whose bytes its own annex does not name", async () => {
    loader.load.mockResolvedValue({
      ok: true,
      adapter: installedScan(["detector.aih-native"], () =>
        Promise.resolve(nativeObservation(NATIVE_BYTES, "0".repeat(64))),
      ),
    });
    const { result } = await scan();
    expect(result.scanObservations).toEqual([
      expect.objectContaining({
        outcome: "failed",
        executionProfileId: "in-process-native-v1",
        detail:
          "scan execution adapter returned observation bytes that its own annex does not name",
      }),
    ]);
  });

  it("reports an incompatible installed Scan for the observation, not a crash", async () => {
    loader.load.mockResolvedValue({
      ok: false,
      refusal: { reason: "scan-package-incompatible", detail: "no runner" },
    });
    const { result } = await scan();
    expect(result.scanObservations).toEqual([
      {
        detectorId: "detector.aih-native",
        outcome: "unavailable",
        refusal: "scan-package-incompatible",
        detail: "scan-package-incompatible: no runner",
      },
    ]);
  });

  it("asks nothing of a Scan that does not declare the observation", async () => {
    const scanPackage = installedScan(["detector.cisco"], () => Promise.reject(new Error("no")));
    loader.load.mockResolvedValue({ ok: true, adapter: scanPackage });
    const { result } = await scan();
    expect(scanPackage.requests).toEqual([]);
    expect(result.scanObservations).toEqual([]);
  });

  it("uses precomputed SARIF without loading Scan or executing anything", async () => {
    write("SKILL.md", "# Root skill\n");
    const result = await scanTrustTreeWithAnalyzers(dir, {
      env: {},
      platform: "linux",
      posture: "vibe",
      run: fakeRunner(() => ({ code: 1, stdout: "", stderr: "no" })),
      detectors: ["cisco"],
      precomputedDetectorSarif: { cisco: EMPTY_SARIF },
    });
    expect(loader.load).not.toHaveBeenCalled();
    expect(result.detectorExecutions).toEqual([
      { detector: "cisco", executedBy: "precomputed-sarif", outcome: "completed" },
    ]);
    expect(result.scanObservations).toEqual([]);
  });
});

describe("a delegated detector (the rule Step 2 flips per detector)", () => {
  it("reports an absent Scan verbatim and never runs Core's implementation", async () => {
    loader.load.mockResolvedValue(UNAVAILABLE);
    const { argvs, result } = await delegatedRun(["cisco"]);

    const check = detectorCheck(result.checks, "cisco");
    expect(check?.verdict).toBe("skip");
    expect(check?.detail).toContain(
      "cisco not available (scan-package-unavailable: @aihq/scan is not installed next to @aihq/core",
    );
    expect(check?.detail).toContain(SCAN_PACKAGE_INSTALL_COMMAND);
    expect(spawnedFor(argvs, "skill-scanner")).toEqual([]);
    expect(result.executions).toContainEqual({
      detector: "cisco",
      executedBy: "none",
      outcome: "unavailable",
      refusal: "scan-package-unavailable",
    });
    // An undelegated detector beside it keeps Core's execution.
    expect(result.executions).toContainEqual({
      detector: "semgrep",
      executedBy: "core-legacy",
      outcome: "unavailable",
    });
  });

  it("fails closed when the organization requires it at enterprise posture", async () => {
    loader.load.mockResolvedValue(UNAVAILABLE);
    const { result } = await delegatedRun(["cisco"], {
      posture: "enterprise",
      required: ["cisco"],
    });
    const check = detectorCheck(result.checks, "cisco");
    expect(check?.verdict).toBe("fail");
    expect(check?.detail).toContain("required detector cisco is unavailable at enterprise posture");
    expect(check?.detail).toContain("scan-package-unavailable");
  });

  it("runs through the installed package and records the profile Scan ran under", async () => {
    const scanPackage = installedScan(["detector.cisco"], () =>
      Promise.resolve(succeeded("detector.cisco", "linux-namespace-uv-v1")),
    );
    loader.load.mockResolvedValue({ ok: true, adapter: scanPackage });
    const { argvs, result } = await delegatedRun(["cisco"]);

    expect(requestedIds(scanPackage)).toEqual(["detector.cisco"]);
    expect(detectorCheck(result.checks, "cisco")?.detail).toBe(
      `${CISCO_SKILL_SCANNER_ANALYZER} static scan completed through the installed @aihq/scan under execution profile linux-namespace-uv-v1; Core did not execute it. No findings != safe. Analyzers run: aih-native, ${CISCO_SKILL_SCANNER_ANALYZER}`,
    );
    expect(result.executions).toContainEqual({
      detector: "cisco",
      executedBy: "scan",
      scanSource: "installed-package",
      executionProfileId: "linux-namespace-uv-v1",
      outcome: "completed",
    });
    expect(spawnedFor(argvs, "skill-scanner")).toEqual([]);
  });

  it("carries Scan's own refusal verbatim with no fallback", async () => {
    const detail =
      "detector.cisco runs on linux/amd64 only; this host is win32/x64. Run it on a linux amd64 machine or in a linux container.";
    loader.load.mockResolvedValue({
      ok: true,
      adapter: installedScan(["detector.cisco"], () =>
        Promise.resolve({
          outcome: "refused",
          reason: "unsupported-platform",
          detail,
          host: { os: "win32", architecture: "x64" },
        }),
      ),
    });
    const { argvs, result } = await delegatedRun(["cisco"]);
    expect(detectorCheck(result.checks, "cisco")?.detail).toBe(
      `DEGRADED-COVERAGE: deep scan SKIPPED — cisco not available (installed @aihq/scan: unsupported-platform: ${detail}); coverage is GREEN-tier only. Analyzers run: aih-native.`,
    );
    expect(result.executions).toContainEqual({
      detector: "cisco",
      executedBy: "scan",
      scanSource: "installed-package",
      outcome: "refused",
    });
    expect(spawnedFor(argvs, "skill-scanner")).toEqual([]);
  });

  it("records the profile a failed Scan run used", async () => {
    const scanPackage = installedScan(["detector.semgrep"], () =>
      Promise.resolve({
        outcome: "failed",
        failure: { stage: "execution", detail: "analyzer exited 2" },
        executionProfile: { id: "linux-namespace-uv-v1" },
      }),
    );
    loader.load.mockResolvedValue({
      ok: true,
      adapter: scanPackage,
    });
    const { result } = await delegatedRun(["semgrep"]);
    expect(scanPackage.requests).toContainEqual(
      expect.objectContaining({
        detectorId: "detector.semgrep",
        executionProfileId: "linux-namespace-uv-v1",
      }),
    );
    expect(detectorCheck(result.checks, "semgrep")?.detail).toContain(
      "(installed @aihq/scan: execution: analyzer exited 2)",
    );
    expect(result.executions).toContainEqual({
      detector: "semgrep",
      executedBy: "scan",
      scanSource: "installed-package",
      executionProfileId: "linux-namespace-uv-v1",
      outcome: "failed",
    });
  });

  it.each(["windows", "darwin"] as const)(
    "requests the declared host-process Semgrep profile on %s",
    async (platform) => {
      const hostCapability = {
        ...capability("detector.semgrep"),
        executionProfiles: [
          {
            id: "host-process-uv-v1",
            supportedPlatforms: [{ os: platform, architecture: HOST_ARCH }],
          },
        ],
      };
      const requests: unknown[] = [];
      const scanPackage: ScanExecutionAdapterV1 & { requests: unknown[] } = {
        requests,
        listDetectorCapabilitiesV1: () => [hostCapability],
        runDetectorV1(request) {
          requests.push(request);
          return Promise.resolve(succeeded("detector.semgrep", "host-process-uv-v1"));
        },
      };
      loader.load.mockResolvedValue({ ok: true, adapter: scanPackage });
      const { argvs, result } = await delegatedRun(["semgrep"], { platform });

      expect(scanPackage.requests).toContainEqual(
        expect.objectContaining({
          detectorId: "detector.semgrep",
          executionProfileId: "host-process-uv-v1",
        }),
      );
      expect(result.executions).toContainEqual({
        detector: "semgrep",
        executedBy: "scan",
        scanSource: "installed-package",
        executionProfileId: "host-process-uv-v1",
        outcome: "completed",
      });
      expect(spawnedFor(argvs, "semgrep")).toEqual([]);
    },
  );

  it("refuses Semgrep when Scan omits the executionProfiles declaration", async () => {
    const requests: unknown[] = [];
    const scanPackage: ScanExecutionAdapterV1 = {
      listDetectorCapabilitiesV1: () => [
        { detectorId: "detector.semgrep", subjectKinds: ["source-tree"] },
      ],
      runDetectorV1(request) {
        requests.push(request);
        return Promise.reject(new Error("undeclared profile must not be run"));
      },
    };
    loader.load.mockResolvedValue({ ok: true, adapter: scanPackage });
    const { argvs, result } = await delegatedRun(["semgrep"]);

    expect(requests).toEqual([]);
    expect(detectorCheck(result.checks, "semgrep")?.detail).toContain(
      `installed @aihq/scan: detector.semgrep does not declare linux-namespace-uv-v1 for linux/${HOST_ARCH}`,
    );
    expect(spawnedFor(argvs, "semgrep")).toEqual([]);
  });

  it("refuses a Semgrep profile declared only for another architecture", async () => {
    const requests: unknown[] = [];
    const scanPackage: ScanExecutionAdapterV1 = {
      listDetectorCapabilitiesV1: () => [
        {
          ...capability("detector.semgrep"),
          executionProfiles: [
            {
              id: "linux-namespace-uv-v1",
              supportedPlatforms: [{ os: "linux", architecture: OTHER_ARCH }],
            },
          ],
        },
      ],
      runDetectorV1(request) {
        requests.push(request);
        return Promise.reject(new Error("wrong-architecture profile must not be run"));
      },
    };
    loader.load.mockResolvedValue({ ok: true, adapter: scanPackage });
    const { argvs, result } = await delegatedRun(["semgrep"]);

    expect(requests).toEqual([]);
    expect(detectorCheck(result.checks, "semgrep")?.detail).toContain(
      `installed @aihq/scan: detector.semgrep does not declare linux-namespace-uv-v1 for linux/${HOST_ARCH}`,
    );
    expect(spawnedFor(argvs, "semgrep")).toEqual([]);
  });

  it("rejects a successful Scan run under a profile different from the requested one", async () => {
    const scanPackage = installedScan(["detector.semgrep"], () =>
      Promise.resolve(succeeded("detector.semgrep", "host-process-uv-v1")),
    );
    loader.load.mockResolvedValue({ ok: true, adapter: scanPackage });
    const { argvs, result } = await delegatedRun(["semgrep"]);

    expect(scanPackage.requests).toContainEqual(
      expect.objectContaining({ executionProfileId: "linux-namespace-uv-v1" }),
    );
    expect(detectorCheck(result.checks, "semgrep")?.detail).toContain(
      "installed @aihq/scan: detector.semgrep returned execution profile host-process-uv-v1 instead of requested linux-namespace-uv-v1",
    );
    expect(result.executions).toContainEqual({
      detector: "semgrep",
      executedBy: "scan",
      scanSource: "installed-package",
      outcome: "failed",
    });
    expect(spawnedFor(argvs, "semgrep")).toEqual([]);
  });

  it.each(["windows", "darwin"] as const)(
    "refuses %s Semgrep when Scan does not declare the host profile for that host",
    async (platform) => {
      const scanPackage = installedScan(["detector.semgrep"], () =>
        Promise.reject(new Error("unsupported profile must not be run")),
      );
      loader.load.mockResolvedValue({ ok: true, adapter: scanPackage });
      const { argvs, result } = await delegatedRun(["semgrep"], { platform });

      expect(scanPackage.requests).toEqual([]);
      expect(detectorCheck(result.checks, "semgrep")?.detail).toContain(
        `installed @aihq/scan: detector.semgrep does not declare host-process-uv-v1 for ${platform}/${HOST_ARCH}`,
      );
      expect(result.executions).toContainEqual({
        detector: "semgrep",
        executedBy: "scan",
        scanSource: "installed-package",
        outcome: "refused",
      });
      expect(spawnedFor(argvs, "semgrep")).toEqual([]);
    },
  );

  it("refuses a delegated detector the installed package does not declare", async () => {
    loader.load.mockResolvedValue({
      ok: true,
      adapter: installedScan(["detector.cisco"], () => Promise.reject(new Error("unused"))),
    });
    const { argvs, result } = await delegatedRun(["semgrep"]);
    expect(detectorCheck(result.checks, "semgrep")?.detail).toContain(
      "semgrep not available (scan-package-incompatible: the installed @aihq/scan declares no detector.semgrep capability; Core does not execute semgrep itself.",
    );
    expect(spawnedFor(argvs, "semgrep")).toEqual([]);
  });

  it("does not delegate an undelegated detector the installed package happens to name", async () => {
    const scanPackage = installedScan(["detector.cisco"], () =>
      Promise.reject(new Error("an undelegated detector must never reach Scan")),
    );
    loader.load.mockResolvedValue({ ok: true, adapter: scanPackage });
    const { result } = await delegatedRun([]);
    expect(scanPackage.requests).toEqual([]);
    expect(result.executions).toContainEqual({
      detector: "cisco",
      executedBy: "core-legacy",
      outcome: "unavailable",
    });
  });
});
