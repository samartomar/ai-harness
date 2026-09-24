import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Check } from "../../src/internals/verify.js";
import {
  SCAN_PACKAGE_INSTALL_COMMAND,
  ScanPackageRefusalError,
} from "../../src/scan-package/load-scan-package.js";
import {
  type ScanRoutedDetectorV1,
  type TrustDetectorName,
  TrustScanCancelledError,
} from "../../src/trust/detectors.js";
import { scanTrustTreeWithAnalyzers } from "../../src/trust/scan.js";
import { TRUST_LINT_FINGERPRINT_KEY } from "../../src/trust/trust-lint-sarif.js";
import {
  createFakeScanAdapterForTests,
  FAKE_SCAN_PROFILES,
  type FakeScanAnswerV1,
} from "./fakes/fake-scan-adapter.js";
import {
  loadGolden,
  loadParityCases,
  materializeParityCase,
  trustLintSarifFromGolden,
} from "./fakes/trust-parity-golden.js";

// ---------------------------------------------------------------------------
// The rules the delegated path follows, independent of any one golden: a
// missing or incompatible Scan refuses the trust operation; Scan's SARIF is
// checked at the boundary and fails closed; every detector runs under a profile
// Core names (host by default on every OS, never a silent fallback); and a
// cancellation reaches Scan through the request and stops the scan.
// ---------------------------------------------------------------------------

const loader = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("../../src/scan-package/load-scan-package.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/scan-package/load-scan-package.js")>()),
  loadScanExecutionAdapterV1: loader.load,
}));

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ALL_DETECTORS: ReadonlySet<ScanRoutedDetectorV1> = new Set([
  "aih-trust-lint",
  "skillspector",
  "cisco",
  "mcp-scanner",
  "semgrep",
  "snyk-agent-scan",
]);

const roots: string[] = [];

beforeEach(() => {
  loader.load.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function caseRoot(id: string): string {
  const entry = loadParityCases().find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`corpus lost ${id}`);
  const root = materializeParityCase(entry);
  roots.push(root);
  return root;
}

function goldenTrustLint(id: string): FakeScanAnswerV1 {
  const native = Object.values(loadGolden(id).native.byEnvironment)[0];
  if (native === undefined) throw new Error(`no native golden for ${id}`);
  return { kind: "sarif", sarif: trustLintSarifFromGolden(native.checks) };
}

function sarif(results: readonly unknown[]): string {
  return JSON.stringify({ version: "2.1.0", runs: [{ results }] });
}

function result(ruleId: string, uri: string, startLine = 1, extra: object = {}) {
  return {
    ruleId,
    message: { text: `${ruleId} fixture message` },
    locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine } } }],
    ...extra,
  };
}

function recordingRunner() {
  const argvs: string[][] = [];
  const run = fakeRunner((argv) => {
    argvs.push([...argv]);
    return { code: 127, stdout: "", stderr: "no process may run here", spawnError: true };
  });
  return { argvs, run };
}

function detectorCheck(checks: readonly Check[], detector: string): Check | undefined {
  return checks.find((check) => check.name === `trust detector ${detector}`);
}

async function delegatedScan(
  root: string,
  detectors: readonly TrustDetectorName[],
  options: {
    readonly scanExecution?: ReturnType<typeof createFakeScanAdapterForTests>;
    readonly platform?: "linux" | "windows" | "darwin";
    readonly uvExecutionProfileId?: "host-process-uv-v1" | "linux-namespace-uv-v1";
    readonly signal?: AbortSignal;
  } = {},
) {
  const { argvs, run } = recordingRunner();
  const scan = await scanTrustTreeWithAnalyzers(root, {
    posture: "vibe",
    env: {},
    platform: options.platform ?? "linux",
    run,
    detectors,
    ...(options.scanExecution === undefined
      ? { delegatedDetectors: ALL_DETECTORS }
      : { scanExecution: options.scanExecution }),
    ...(options.uvExecutionProfileId === undefined
      ? {}
      : { uvExecutionProfileId: options.uvExecutionProfileId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { argvs, scan };
}

describe("installed @aihq/scan: missing or incompatible refuses the trust scan", () => {
  it("refuses with scan-package-unavailable and the install command, running nothing", async () => {
    loader.load.mockResolvedValue({
      ok: false,
      refusal: {
        reason: "scan-package-unavailable",
        detail: `@aihq/scan is not installed next to @aihq/core; this operation needs its public API. Install it with: ${SCAN_PACKAGE_INSTALL_COMMAND} (in a project: npm install @aihq/core @aihq/scan).`,
      },
    });
    const root = caseRoot("prompt-injection");
    const { argvs, run } = recordingRunner();
    const scanning = scanTrustTreeWithAnalyzers(root, {
      posture: "vibe",
      env: {},
      platform: "linux",
      run,
      delegatedDetectors: ALL_DETECTORS,
    });
    await expect(scanning).rejects.toBeInstanceOf(ScanPackageRefusalError);
    await expect(scanning).rejects.toMatchObject({
      code: "AIH_SCAN_PACKAGE",
      refusal: { reason: "scan-package-unavailable" },
      message: expect.stringContaining(SCAN_PACKAGE_INSTALL_COMMAND),
    });
    expect(argvs).toEqual([]);
  });

  it("refuses with scan-package-incompatible, never treating it as absent", async () => {
    loader.load.mockResolvedValue({
      ok: false,
      refusal: {
        reason: "scan-package-incompatible",
        detail: "the installed @aihq/scan does not export runDetectorV1 as a function",
      },
    });
    const root = caseRoot("clean");
    await expect(
      scanTrustTreeWithAnalyzers(root, { posture: "vibe", delegatedDetectors: ALL_DETECTORS }),
    ).rejects.toMatchObject({ refusal: { reason: "scan-package-incompatible" } });
  });

  it("refuses an installed Scan that cannot produce the native findings", async () => {
    const scan = createFakeScanAdapterForTests({
      "detector.semgrep": { kind: "sarif", sarif: sarif([]) },
    });
    loader.load.mockResolvedValue({ ok: true, adapter: scan });
    const root = caseRoot("clean");
    await expect(
      scanTrustTreeWithAnalyzers(root, { posture: "vibe", delegatedDetectors: ALL_DETECTORS }),
    ).rejects.toMatchObject({
      refusal: {
        reason: "scan-package-incompatible",
        detail: expect.stringContaining("declares no detector.aih-trust-lint capability"),
      },
    });
    expect(scan.requests).toEqual([]);
  });

  it("runs every detector through a compatible installed Scan and names it", async () => {
    const root = caseRoot("mcp-configs");
    const scan = createFakeScanAdapterForTests({
      "detector.aih-trust-lint": goldenTrustLint("mcp-configs"),
      "detector.semgrep": { kind: "sarif", sarif: sarif([]) },
      // No detector.cisco-mcp-scanner: the delegated MCP detector is refused, not run by Core.
    });
    loader.load.mockResolvedValue({ ok: true, adapter: scan });
    const { argvs, scan: result } = await delegatedScan(root, ["semgrep", "mcp-scanner"]);
    expect(argvs.every((argv) => argv.join(" ") === "docker --version")).toBe(true);
    expect(result.detectorExecutions).toEqual([
      {
        detector: "aih-trust-lint",
        executedBy: "scan",
        scanSource: "installed-package",
        executionProfileId: "in-process-native-v1",
        outcome: "completed",
      },
      {
        detector: "semgrep",
        executedBy: "scan",
        scanSource: "installed-package",
        executionProfileId: "host-process-uv-v1",
        outcome: "completed",
      },
      {
        detector: "mcp-scanner",
        executedBy: "none",
        outcome: "unavailable",
        refusal: "scan-package-incompatible",
      },
    ]);
    expect(detectorCheck(result.checks, "semgrep")?.detail).toContain(
      "through the installed @aihq/scan under execution profile host-process-uv-v1",
    );
    expect(detectorCheck(result.checks, "mcp-scanner")?.detail).toContain(
      "scan-package-incompatible: the installed @aihq/scan declares no detector.cisco-mcp-scanner capability",
    );
  });
});

describe("Scan's native findings fail closed at every posture", () => {
  const cases: ReadonlyArray<readonly [string, FakeScanAnswerV1, string]> = [
    [
      "a refusal",
      { kind: "refused", reason: "subject-requirement-unmet", detail: "no files were declared" },
      "subject-requirement-unmet: no files were declared",
    ],
    [
      "an unknown rule id",
      { kind: "sarif", sarif: sarif([result("trust.not-a-core-code", "SKILL.md")]) },
      "unknown rule id trust.not-a-core-code",
    ],
    [
      "a location outside the source root",
      {
        kind: "sarif",
        sarif: sarif([
          result("trust.prompt-injection", "/aih/source/SKILL.md", 7, {
            fingerprints: { [TRUST_LINT_FINGERPRINT_KEY]: "trust-prompt-injection:SKILL.md:x" },
          }),
        ]),
      },
      "not relative to the declared source root",
    ],
    [
      "a missing fingerprint",
      { kind: "sarif", sarif: sarif([result("trust.prompt-injection", "SKILL.md", 7)]) },
      `has no ${TRUST_LINT_FINGERPRINT_KEY} fingerprint`,
    ],
  ];

  it.each(cases)("fails on %s", async (_label, answer, reason) => {
    const root = caseRoot("prompt-injection");
    const scan = createFakeScanAdapterForTests({ "detector.aih-trust-lint": answer });
    const result = await scanTrustTreeWithAnalyzers(root, { posture: "vibe", scanExecution: scan });
    const check = detectorCheck(result.checks, "aih-trust-lint");
    expect(check).toMatchObject({ verdict: "fail", code: "trust.detector-unavailable" });
    expect(check?.detail).toContain(reason);
    // Nothing from the refused report reached the result as a finding.
    expect(result.checks.some((entry) => entry.code === "trust.prompt-injection")).toBe(false);
  });
});

describe("Scan's detector SARIF is checked at the boundary", () => {
  it("refuses a Semgrep rule that is not one of Core's rules", async () => {
    const root = caseRoot("prompt-injection");
    const scan = createFakeScanAdapterForTests({
      "detector.aih-trust-lint": goldenTrustLint("prompt-injection"),
      "detector.semgrep": {
        kind: "sarif",
        sarif: sarif([result("aih.work.semgrep.something-else", "SKILL.md", 7)]),
      },
    });
    const { scan: outcome } = await delegatedScan(root, ["semgrep"], { scanExecution: scan });
    expect(detectorCheck(outcome.checks, "semgrep")).toMatchObject({
      verdict: "skip",
      code: "trust.detector-unavailable",
      detail: expect.stringContaining(
        "which is not one of Core's Semgrep rules (semgrep.malicious-code, semgrep.prompt-injection)",
      ),
    });
    expect(outcome.detectorExecutions).toContainEqual(
      expect.objectContaining({ detector: "semgrep", outcome: "failed" }),
    );
  });

  it.each([
    ["an absolute sandbox path", "/aih/source/SKILL.md"],
    ["a Windows path", "C:\\scan\\SKILL.md"],
    ["a file URL", "file:///tmp/snapshot/SKILL.md"],
    ["a parent escape", "../outside.md"],
  ])("refuses SARIF naming %s", async (_label, uri) => {
    const root = caseRoot("prompt-injection");
    const scan = createFakeScanAdapterForTests({
      "detector.aih-trust-lint": goldenTrustLint("prompt-injection"),
      "detector.skillspector": { kind: "sarif", sarif: sarif([result("P1", uri, 7)]) },
    });
    const { scan: outcome } = await delegatedScan(root, ["skillspector"], { scanExecution: scan });
    expect(detectorCheck(outcome.checks, "skillspector")?.detail).toContain(
      "which is not relative to the declared source root",
    );
    expect(outcome.rawOccurrences?.some((row) => row.analyzer.startsWith("skillspector"))).toBe(
      false,
    );
  });

  it("accepts '.', the source root itself, exactly as Core's own mapping does", async () => {
    // Snyk Agent Scan's JSON-to-SARIF conversion names "." for a finding with no
    // file inside the tree; Core's legacy mapping keeps it as the root location.
    const root = caseRoot("prompt-injection");
    const rootFinding = sarif([result("E004", ".", 1)]);
    const scan = createFakeScanAdapterForTests({
      "detector.aih-trust-lint": goldenTrustLint("prompt-injection"),
      "detector.snyk-agent-scan": { kind: "sarif", sarif: rootFinding },
    });
    const { scan: delegated } = await delegatedScan(root, ["snyk-agent-scan"], {
      scanExecution: scan,
    });
    const { run } = recordingRunner();
    const legacy = await scanTrustTreeWithAnalyzers(root, {
      posture: "vibe",
      env: {},
      platform: "linux",
      run,
      detectors: ["snyk-agent-scan"],
      precomputedDetectorSarif: { "snyk-agent-scan": rootFinding },
      scanExecution: createFakeScanAdapterForTests({
        "detector.aih-trust-lint": goldenTrustLint("prompt-injection"),
      }),
    });
    const findingsOf = (checks: readonly Check[]) =>
      checks.filter((check) => check.location?.uri === ".");
    expect(findingsOf(legacy.checks)).toHaveLength(1);
    expect(findingsOf(delegated.checks)).toEqual(findingsOf(legacy.checks));
    expect(detectorCheck(delegated.checks, "snyk-agent-scan")?.verdict).toBe("pass");
  });

  it("refuses a run Scan reports under a profile other than the one requested", async () => {
    const root = caseRoot("prompt-injection");
    const scan = createFakeScanAdapterForTests({
      "detector.aih-trust-lint": goldenTrustLint("prompt-injection"),
      "detector.cisco": {
        kind: "sarif",
        sarif: sarif([]),
        executionProfileId: "linux-namespace-uv-v1",
      },
    });
    const { scan: outcome } = await delegatedScan(root, ["cisco"], { scanExecution: scan });
    expect(detectorCheck(outcome.checks, "cisco")?.detail).toContain(
      "detector.cisco returned execution profile linux-namespace-uv-v1 instead of requested host-process-uv-v1",
    );
  });
});

describe("execution profiles are named by Core, never a fallback", () => {
  const uvDetectors = [
    ["semgrep", "detector.semgrep"],
    ["cisco", "detector.cisco"],
    ["snyk-agent-scan", "detector.snyk-agent-scan"],
    ["mcp-scanner", "detector.cisco-mcp-scanner"],
  ] as const;

  it.each(["linux", "windows", "darwin"] as const)(
    "requests host-process-uv-v1 for every uv detector on %s",
    async (platform) => {
      const root = caseRoot("mcp-configs");
      const scan = createFakeScanAdapterForTests({
        "detector.aih-trust-lint": goldenTrustLint("mcp-configs"),
        ...Object.fromEntries(
          uvDetectors.map(([, id]) => [id, { kind: "sarif", sarif: sarif([]) }]),
        ),
      });
      await delegatedScan(
        root,
        uvDetectors.map(([name]) => name),
        { scanExecution: scan, platform },
      );
      expect(
        scan.requests.map((request) => [request.detectorId, request.executionProfileId]),
      ).toEqual([
        ["detector.aih-trust-lint", "in-process-native-v1"],
        ["detector.cisco", "host-process-uv-v1"],
        ["detector.semgrep", "host-process-uv-v1"],
        ["detector.snyk-agent-scan", "host-process-uv-v1"],
        ["detector.cisco-mcp-scanner", "host-process-uv-v1"],
      ]);
    },
  );

  it("requests the Linux namespace profile only when the caller selects it", async () => {
    const root = caseRoot("prompt-injection");
    const scan = createFakeScanAdapterForTests({
      "detector.aih-trust-lint": goldenTrustLint("prompt-injection"),
      "detector.semgrep": { kind: "sarif", sarif: sarif([]) },
    });
    await delegatedScan(root, ["semgrep"], {
      scanExecution: scan,
      uvExecutionProfileId: "linux-namespace-uv-v1",
    });
    expect(scan.requests[1]).toMatchObject({
      detectorId: "detector.semgrep",
      executionProfileId: "linux-namespace-uv-v1",
    });
  });

  it("refuses the namespace profile where Scan does not declare it, asking nothing", async () => {
    const root = caseRoot("prompt-injection");
    const scan = createFakeScanAdapterForTests({
      "detector.aih-trust-lint": goldenTrustLint("prompt-injection"),
      "detector.semgrep": { kind: "sarif", sarif: sarif([]) },
    });
    const { scan: outcome } = await delegatedScan(root, ["semgrep"], {
      scanExecution: scan,
      platform: "windows",
      uvExecutionProfileId: "linux-namespace-uv-v1",
    });
    expect(scan.requests.map((request) => request.detectorId)).toEqual(["detector.aih-trust-lint"]);
    expect(detectorCheck(outcome.checks, "semgrep")?.detail).toMatch(
      /detector\.semgrep does not declare linux-namespace-uv-v1 for windows\/(amd64|arm64)/,
    );
  });

  it("runs SkillSpector only under a container profile", async () => {
    const root = caseRoot("prompt-injection");
    const [hostUv] = FAKE_SCAN_PROFILES["detector.semgrep"] ?? [];
    if (hostUv === undefined) throw new Error("fake lost its host profile");
    const scan = createFakeScanAdapterForTests(
      {
        "detector.aih-trust-lint": goldenTrustLint("prompt-injection"),
        "detector.skillspector": { kind: "sarif", sarif: sarif([]) },
      },
      { profiles: { "detector.skillspector": [hostUv] } },
    );
    const { scan: outcome } = await delegatedScan(root, ["skillspector"], { scanExecution: scan });
    expect(scan.requests.map((request) => request.detectorId)).toEqual(["detector.aih-trust-lint"]);
    expect(detectorCheck(outcome.checks, "skillspector")?.detail).toContain(
      "is not a container profile; Core runs SkillSpector only in a container",
    );
  });
});

describe("cancellation reaches Scan and stops the scan", () => {
  it("never asks Scan anything when the scan is cancelled before it starts", async () => {
    const root = caseRoot("prompt-injection");
    const scan = createFakeScanAdapterForTests({
      "detector.aih-trust-lint": goldenTrustLint("prompt-injection"),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanTrustTreeWithAnalyzers(root, {
        posture: "vibe",
        scanExecution: scan,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(TrustScanCancelledError);
    expect(scan.requests).toEqual([]);
  });

  it("passes the caller's signal to Scan and stops after Scan kills the run", async () => {
    const root = caseRoot("prompt-injection");
    const scan = createFakeScanAdapterForTests({
      "detector.aih-trust-lint": goldenTrustLint("prompt-injection"),
      "detector.semgrep": { kind: "block-until-aborted" },
      "detector.cisco": { kind: "sarif", sarif: sarif([]) },
    });
    const controller = new AbortController();
    const scanning = delegatedScan(root, ["semgrep", "cisco"], {
      scanExecution: scan,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(scan.requests).toHaveLength(3));
    // Core's detector order is cisco, then semgrep; the blocked run is the last request.
    expect(scan.requests.map((request) => request.detectorId)).toEqual([
      "detector.aih-trust-lint",
      "detector.cisco",
      "detector.semgrep",
    ]);
    expect(scan.requests[2]?.signal).toBe(controller.signal);
    controller.abort();
    await expect(scanning).rejects.toMatchObject({
      name: "TrustScanCancelledError",
      code: "AIH_TRUST_CANCELLED",
      message: "trust scan cancelled: detector.semgrep was running",
    });
    expect(scan.aborted).toEqual(["detector.semgrep"]);
  });

  it("stops before any detector when the native findings run is cancelled", async () => {
    const root = caseRoot("prompt-injection");
    const scan = createFakeScanAdapterForTests({
      "detector.aih-trust-lint": { kind: "block-until-aborted" },
      "detector.semgrep": { kind: "sarif", sarif: sarif([]) },
    });
    const controller = new AbortController();
    const scanning = delegatedScan(root, ["semgrep"], {
      scanExecution: scan,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(scan.requests).toHaveLength(1));
    expect(scan.requests[0]?.signal).toBe(controller.signal);
    controller.abort();
    await expect(scanning).rejects.toBeInstanceOf(TrustScanCancelledError);
    expect(scan.requests.map((request) => request.detectorId)).toEqual(["detector.aih-trust-lint"]);
  });
});
