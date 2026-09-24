import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Check } from "../../src/internals/verify.js";
import type { ScanExecutionAdapterV1 } from "../../src/org-policy/governance-input-v1.js";
import { CISCO_SKILL_SCANNER_ANALYZER, runTrustDetectors } from "../../src/trust/detectors.js";
import { scanTrustTreeWithAnalyzers } from "../../src/trust/scan.js";

// ---------------------------------------------------------------------------
// A consumer may own detector execution and inject it, exactly as the
// governance path injects Scan's verification functions. Core delegates only
// the detectors an adapter's capability list NAMES: every other detector keeps
// today's in-Core execution, and with no adapter nothing changes at all.
//
// Delegation is not a pass. A refusal, a failure, a throw and an unrecognized
// result all land on the existing degraded-coverage path with their own reason.
// ---------------------------------------------------------------------------

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-scan-execution-adapter-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

const CISCO_SARIF = JSON.stringify({
  version: "2.1.0",
  $schema: "https://json.schemastore.org/sarif-2.1.0.json",
  runs: [{ tool: { driver: { name: "skill-scanner" } }, results: [] }],
});

/** One rule the existing cisco map normalizes, so the SARIF reaches findings. */
const CISCO_FINDING_SARIF = JSON.stringify({
  version: "2.1.0",
  $schema: "https://json.schemastore.org/sarif-2.1.0.json",
  runs: [
    {
      tool: { driver: { name: "skill-scanner" } },
      results: [
        {
          ruleId: "PROMPT_INJECTION_IGNORE_INSTRUCTIONS",
          level: "warning",
          message: { text: "instruction-override shape in skill content" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "SKILL.md" },
                region: { startLine: 1 },
              },
            },
          ],
        },
      ],
    },
  ],
});

/** Every detector probe fails, so Core's own path is visibly unavailable. */
function recordingRunner() {
  const argvs: string[][] = [];
  const run = fakeRunner((argv) => {
    argvs.push([...argv]);
    return { code: 1, stdout: "", stderr: "probe refused by this test" };
  });
  return { argvs, run };
}

/**
 * Contract C2: every uv-backed detector declares `host-process-uv-v1` on every OS,
 * and Core names that profile in each request (no profile falls back).
 */
const HOST_PROFILE = {
  id: "host-process-uv-v1",
  isolation: "none",
  network: "unenforced",
  supportedPlatforms: ["linux", "darwin", "windows"].flatMap((os) =>
    ["amd64", "arm64"].map((architecture) => ({ os, architecture })),
  ),
};

/**
 * Shaped after Scan's own `DetectorCapabilityV1`
 * (`aih-scan@a405b9d0 src/capability/detector-capability-v1.ts:122-140`).
 * `detector.cisco` declares `skill-directory` there; the others `source-tree`.
 */
function capability(detectorId: string, subjectKinds: readonly string[] = ["source-tree"]) {
  return {
    protocol: "DetectorCapabilityV1",
    detectorId,
    analyzerIdentity: null,
    analyzerVersion: "0.0.0-test",
    executionProfile: HOST_PROFILE,
    executionProfiles: [HOST_PROFILE],
    subjectKinds,
    outputs: ["sarif-2.1.0"],
  };
}

/**
 * Shaped after Scan's own succeeded `RunDetectorV1Result`
 * (`aih-scan@a405b9d0 src/runner/run-detector-v1.ts:167-187`): the analyzer
 * bytes live in the `baseline-analyzer-observation-v1` evidence member, under
 * an annex digest taken over exactly those bytes.
 */
function succeededWithSarif(sarif: string) {
  const bytes = Buffer.from(sarif, "utf8");
  return {
    outcome: "succeeded",
    capability: capability("detector.cisco", ["skill-directory"]),
    executionProfile: HOST_PROFILE,
    prerequisites: [],
    seams: { runner: "scan-owned-default", prerequisiteProbe: "scan-owned-default" },
    evidence: {
      kind: "baseline-analyzer-observation-v1",
      observation: {
        protocol: "BaselineAnalyzerObservationV1",
        analyzer: "cisco",
        analyzerVersion: "2.0.14",
        mediaType: "application/sarif+json",
        annex: {
          path: "annex/cisco-raw.json",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: bytes.byteLength,
        },
        bytes,
      },
    },
    findings: { protocol: "ScanFindingsV1", findings: [], gaps: [] },
    coverage: {
      kind: "selected-closure",
      sha256: "0".repeat(64),
      complete: true,
      coveredPaths: ["SKILL.md"],
      excludedPaths: [],
      uncoveredPaths: [],
    },
    sourceSeal: { before: {}, after: {} },
  };
}

function stubAdapter(
  detectorIds: readonly string[],
  runDetectorV1: ScanExecutionAdapterV1["runDetectorV1"],
  subjectKinds?: readonly string[],
): ScanExecutionAdapterV1 & { readonly requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    listDetectorCapabilitiesV1: () =>
      detectorIds.map((id) =>
        subjectKinds === undefined ? capability(id) : capability(id, subjectKinds),
      ),
    runDetectorV1: (request) => {
      requests.push(request);
      return runDetectorV1(request);
    },
  };
}

function detectorCheck(checks: readonly Check[], detector: string): Check | undefined {
  return checks.find((check) => check.name === `trust detector ${detector}`);
}

async function scan(
  options: {
    readonly scanExecution?: ScanExecutionAdapterV1;
    /** Makes the scanned root a skill directory in its own right. */
    readonly topLevelSkill?: boolean;
  } = {},
) {
  write("skills/clean/SKILL.md", "# Clean\n\nNothing alarming here.\n");
  if (options.topLevelSkill === true) write("SKILL.md", "# Root skill\n\nDeclared at the root.\n");
  const { argvs, run } = recordingRunner();
  const result = await scanTrustTreeWithAnalyzers(dir, {
    env: {},
    platform: "linux",
    posture: "vibe",
    run,
    ...(options.scanExecution === undefined ? {} : { scanExecution: options.scanExecution }),
  });
  return { argvs, result };
}

describe("scan execution adapter", () => {
  it("changes nothing when no adapter is configured", async () => {
    const withoutOption = await scan();
    const withNamelessAdapter = await scan({
      scanExecution: stubAdapter([], () => {
        throw new Error("this adapter names no detector and must never be called");
      }),
    });

    // Detector selection and every availability reason are the same run.
    expect(withNamelessAdapter.result.analyzersRun).toEqual(withoutOption.result.analyzersRun);
    expect(withNamelessAdapter.result.checks).toEqual(withoutOption.result.checks);
    expect(withNamelessAdapter.argvs).toEqual(withoutOption.argvs);

    // And that baseline is today's own text, detector by detector.
    expect(withoutOption.result.analyzersRun).toEqual(["aih-native"]);
    for (const detector of ["skillspector", "cisco", "semgrep", "snyk-agent-scan"]) {
      expect(detectorCheck(withoutOption.result.checks, detector)?.detail).toContain(
        `DEGRADED-COVERAGE: deep scan SKIPPED — ${detector} not available`,
      );
    }
    expect(detectorCheck(withoutOption.result.checks, "snyk-agent-scan")?.detail).toContain(
      "SNYK_TOKEN is not set",
    );
  });

  it("delegates a named detector, spawns nothing for it, and normalizes its findings", async () => {
    const adapter = stubAdapter(
      ["detector.cisco"],
      () => Promise.resolve(succeededWithSarif(CISCO_FINDING_SARIF)),
      ["skill-directory"],
    );
    const { argvs, result } = await scan({ scanExecution: adapter, topLevelSkill: true });

    // The request is a valid Scan RunDetectorV1Request, and its subject kind is
    // the one Core can state truthfully: this root really is a skill directory.
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]).toMatchObject({
      detectorId: "detector.cisco",
      subject: { kind: "skill-directory", sourceRoot: expect.any(String) },
    });
    const selected = (adapter.requests[0] as { subject: { selectedClosurePaths: string[] } })
      .subject.selectedClosurePaths;
    expect(selected).toContain("SKILL.md");
    expect(selected).toContain("skills/clean/SKILL.md");

    // The delegated detector ran, and Core says who ran it rather than
    // describing a mechanism it did not use.
    expect(result.analyzersRun).toContain(CISCO_SKILL_SCANNER_ANALYZER);
    expect(detectorCheck(result.checks, "cisco")?.verdict).toBe("pass");
    expect(detectorCheck(result.checks, "cisco")?.detail).toBe(
      `${CISCO_SKILL_SCANNER_ANALYZER} static scan completed through the injected scan execution adapter; Core did not execute it. No findings != safe. Analyzers run: aih-native, ${CISCO_SKILL_SCANNER_ANALYZER}`,
    );
    expect(detectorCheck(result.checks, "cisco")?.detail).not.toContain("uv lock");

    // The analyzer bytes reached the existing normalization unchanged.
    expect(
      result.rawOccurrences?.filter((row) => row.analyzer === CISCO_SKILL_SCANNER_ANALYZER),
    ).toHaveLength(1);
    expect(
      result.rawOccurrences?.find((row) => row.analyzer === CISCO_SKILL_SCANNER_ANALYZER),
    ).toMatchObject({ ruleId: "PROMPT_INJECTION_IGNORE_INSTRUCTIONS" });
    const finding = result.normalizedFindings?.find(
      (row) => row.location?.uri === "SKILL.md" && row.code === "trust.detector-finding",
    );
    expect(finding?.detail).toContain(
      "Cisco AI Defense skill-scanner: instruction-override shape in skill content",
    );
    expect(finding?.rawOccurrenceFingerprints).toHaveLength(1);

    // Nothing was spawned for it, while the other detectors kept their path.
    expect(argvs.filter((argv) => argv.join(" ").includes("skill-scanner"))).toEqual([]);
    expect(argvs.some((argv) => argv.join(" ").includes("semgrep"))).toBe(true);
    expect(detectorCheck(result.checks, "semgrep")?.detail).toContain(
      "DEGRADED-COVERAGE: deep scan SKIPPED — semgrep not available",
    );
  });

  it("accepts a bare detector id in the capability list", async () => {
    const adapter = stubAdapter(["cisco"], () => Promise.resolve(succeededWithSarif(CISCO_SARIF)));
    const { result } = await scan({ scanExecution: adapter });
    expect(adapter.requests).toHaveLength(1);
    expect(result.analyzersRun).toContain(CISCO_SKILL_SCANNER_ANALYZER);
  });

  it("never relabels the scanned tree to satisfy a detector's subject kind", async () => {
    // Scan's detector.cisco takes only a skill-directory. This root is not one,
    // so Core states source-tree and lets the adapter refuse on its own terms.
    const adapter = stubAdapter(
      ["detector.cisco"],
      () =>
        Promise.resolve({
          outcome: "refused",
          reason: "unsupported-subject-kind",
          detail: "detector.cisco accepts skill-directory subjects only",
          host: { os: "linux", architecture: "x64" },
        }),
      ["skill-directory"],
    );
    const { result } = await scan({ scanExecution: adapter });
    expect(adapter.requests[0]).toMatchObject({ subject: { kind: "source-tree" } });
    expect(detectorCheck(result.checks, "cisco")?.detail).toContain(
      "unsupported-subject-kind: detector.cisco accepts skill-directory subjects only",
    );
  });

  it("carries a refusal's reason and detail into the degraded-coverage text", async () => {
    // Shaped exactly like Scan's refused RunDetectorV1Result.
    const adapter = stubAdapter(["detector.cisco"], () =>
      Promise.resolve({
        outcome: "refused",
        reason: "unsupported-platform",
        detail:
          "detector.cisco runs on linux/amd64 only; this host is win32/x64. Run it on a linux amd64 machine or in a linux container.",
        capability: capability("detector.cisco", ["skill-directory"]),
        host: { os: "win32", architecture: "x64" },
      }),
    );
    const { argvs, result } = await scan({ scanExecution: adapter });

    expect(detectorCheck(result.checks, "cisco")?.detail).toBe(
      "DEGRADED-COVERAGE: deep scan SKIPPED — cisco not available (unsupported-platform: detector.cisco runs on linux/amd64 only; this host is win32/x64. Run it on a linux amd64 machine or in a linux container.); coverage is GREEN-tier only. Analyzers run: aih-native.",
    );
    expect(result.analyzersRun).not.toContain(CISCO_SKILL_SCANNER_ANALYZER);
    expect(argvs.filter((argv) => argv.join(" ").includes("skill-scanner"))).toEqual([]);
  });

  it("reports a failure stage rather than losing it", async () => {
    const adapter = stubAdapter(["detector.cisco"], () =>
      Promise.resolve({
        outcome: "failed",
        failure: { stage: "execution", detail: "container exited 137" },
        capability: capability("detector.cisco", ["skill-directory"]),
        coverage: { kind: "selected-closure", complete: false },
      }),
    );
    const { result } = await scan({ scanExecution: adapter });
    expect(detectorCheck(result.checks, "cisco")?.detail).toContain(
      "execution: container exited 137",
    );
  });

  it("refuses analyzer bytes the observation's own annex does not name", async () => {
    const tampered = succeededWithSarif(CISCO_SARIF);
    const adapter = stubAdapter(["detector.cisco"], () =>
      Promise.resolve({
        ...tampered,
        evidence: {
          ...tampered.evidence,
          observation: {
            ...tampered.evidence.observation,
            bytes: Buffer.from(`${CISCO_SARIF} `, "utf8"),
          },
        },
      }),
    );
    const { result } = await scan({ scanExecution: adapter });
    expect(detectorCheck(result.checks, "cisco")?.detail).toContain(
      "analyzer bytes that its own annex does not name",
    );
  });

  it("refuses an evidence member that carries no SARIF for this scan", async () => {
    const native = succeededWithSarif(CISCO_SARIF);
    const nativeMedia = await scan({
      scanExecution: stubAdapter(["detector.cisco"], () =>
        Promise.resolve({
          ...native,
          evidence: {
            ...native.evidence,
            observation: {
              ...native.evidence.observation,
              mediaType: "application/vnd.aih.baseline-native+json",
            },
          },
        }),
      ),
    });
    expect(detectorCheck(nativeMedia.result.checks, "cisco")?.detail).toContain(
      "application/vnd.aih.baseline-native+json, and this scan normalizes application/sarif+json",
    );

    const capture = await scan({
      scanExecution: stubAdapter(["detector.cisco"], () =>
        Promise.resolve({ ...native, evidence: { kind: "scan-candidate-v2", capture: {} } }),
      ),
    });
    expect(detectorCheck(capture.result.checks, "cisco")?.detail).toContain(
      "scan-candidate-v2 evidence, which carries no SARIF for this scan",
    );
  });

  it("treats a throwing adapter as unavailable, never as a crash or a pass", async () => {
    const thrown = await scan({
      scanExecution: stubAdapter(["detector.cisco"], () => {
        throw new Error("detector broker is offline");
      }),
    });
    expect(detectorCheck(thrown.result.checks, "cisco")?.detail).toContain(
      "scan execution adapter failed: detector broker is offline",
    );

    const rejected = await scan({
      scanExecution: stubAdapter(["detector.cisco"], () =>
        Promise.reject(new Error("detector broker refused the request")),
      ),
    });
    expect(detectorCheck(rejected.result.checks, "cisco")?.detail).toContain(
      "scan execution adapter failed: detector broker refused the request",
    );

    // A capability list Core cannot read names nothing, so nothing is delegated.
    const listing = await scan({
      scanExecution: {
        listDetectorCapabilitiesV1: () => {
          throw new Error("capability listing failed");
        },
        runDetectorV1: () => {
          throw new Error("this detector must never be delegated");
        },
      },
    });
    expect(detectorCheck(listing.result.checks, "cisco")?.detail).toContain(
      "probe refused by this test",
    );
  });

  it("refuses success without analyzer bytes and any shape it cannot read", async () => {
    const empty = await scan({
      scanExecution: stubAdapter(["detector.cisco"], () =>
        Promise.resolve({ outcome: "succeeded" }),
      ),
    });
    expect(detectorCheck(empty.result.checks, "cisco")?.detail).toContain(
      "no analyzer observation, which carries no SARIF for this scan",
    );

    const unknown = await scan({
      scanExecution: stubAdapter(["detector.cisco"], () => Promise.resolve({ outcome: "ok" })),
    });
    expect(detectorCheck(unknown.result.checks, "cisco")?.detail).toContain(
      "scan execution adapter returned an unrecognized result",
    );

    const nothing = await scan({
      scanExecution: stubAdapter(["detector.cisco"], () => Promise.resolve(undefined)),
    });
    expect(detectorCheck(nothing.result.checks, "cisco")?.detail).toContain(
      "scan execution adapter returned no result",
    );

    const notSarif = await scan({
      scanExecution: stubAdapter(["detector.cisco"], () =>
        Promise.resolve(succeededWithSarif("not a sarif log")),
      ),
    });
    expect(detectorCheck(notSarif.result.checks, "cisco")?.detail).toContain(
      "detector did not emit valid SARIF",
    );
  });

  it("delegates only what Core actually enumerated", async () => {
    // Scan requires the selected closure as a field; with no inventory Core has
    // nothing truthful to declare, so it refuses rather than inventing one.
    const adapter = stubAdapter(["detector.cisco"], () =>
      Promise.resolve(succeededWithSarif(CISCO_SARIF)),
    );
    write("skills/clean/SKILL.md", "# Clean" + String.fromCharCode(10));
    const result = await runTrustDetectors(dir, {
      env: {},
      platform: "linux",
      posture: "vibe",
      run: recordingRunner().run,
      scanExecution: adapter,
    });
    expect(adapter.requests).toEqual([]);
    expect(detectorCheck(result.checks, "cisco")?.detail).toContain(
      "no file inventory is available to declare as this detector's selected closure",
    );
  });

  it("bounds and de-controls whatever text the adapter returns", async () => {
    const control = String.fromCharCode(0);
    const adapter = stubAdapter(["detector.cisco"], () =>
      Promise.resolve({ outcome: "refused", detail: `a${control}b${"x".repeat(1_000)}` }),
    );
    const { result } = await scan({ scanExecution: adapter });
    const detail = detectorCheck(result.checks, "cisco")?.detail ?? "";
    expect(detail).not.toContain(control);
    expect(detail).toContain("a b");
    expect(detail).toContain("...");
    expect(detail.length).toBeLessThan(500);
  });
});
