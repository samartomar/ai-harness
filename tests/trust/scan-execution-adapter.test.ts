import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Check } from "../../src/internals/verify.js";
import type { ScanExecutionAdapterV1 } from "../../src/org-policy/governance-input-v1.js";
import { CISCO_SKILL_SCANNER_ANALYZER } from "../../src/trust/detectors.js";
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

/** Every detector probe fails, so Core's own path is visibly unavailable. */
function recordingRunner() {
  const argvs: string[][] = [];
  const run = fakeRunner((argv) => {
    argvs.push([...argv]);
    return { code: 1, stdout: "", stderr: "probe refused by this test" };
  });
  return { argvs, run };
}

function capability(detectorId: string) {
  return { protocol: "DetectorCapabilityV1", detectorId, analyzerVersion: "0.0.0-test" };
}

function stubAdapter(
  detectorIds: readonly string[],
  runDetectorV1: ScanExecutionAdapterV1["runDetectorV1"],
): ScanExecutionAdapterV1 & { readonly requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    listDetectorCapabilitiesV1: () => detectorIds.map(capability),
    runDetectorV1: (request) => {
      requests.push(request);
      return runDetectorV1(request);
    },
  };
}

function detectorCheck(checks: readonly Check[], detector: string): Check | undefined {
  return checks.find((check) => check.name === `trust detector ${detector}`);
}

async function scan(options: { readonly scanExecution?: ScanExecutionAdapterV1 } = {}) {
  write("skills/clean/SKILL.md", "# Clean\n\nNothing alarming here.\n");
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

  it("delegates a named detector and spawns nothing for it", async () => {
    const adapter = stubAdapter(["detector.cisco"], () =>
      Promise.resolve({ outcome: "succeeded", sarif: CISCO_SARIF }),
    );
    const { argvs, result } = await scan({ scanExecution: adapter });

    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]).toMatchObject({
      detectorId: "detector.cisco",
      subject: { kind: "source-tree", sourceRoot: expect.any(String) },
    });
    expect(
      (adapter.requests[0] as { subject: { selectedClosurePaths: string[] } }).subject
        .selectedClosurePaths,
    ).toContain("skills/clean/SKILL.md");

    // The delegated detector ran, and Core says who ran it rather than
    // describing a mechanism it did not use.
    expect(result.analyzersRun).toContain(CISCO_SKILL_SCANNER_ANALYZER);
    expect(detectorCheck(result.checks, "cisco")?.verdict).toBe("pass");
    expect(detectorCheck(result.checks, "cisco")?.detail).toBe(
      `${CISCO_SKILL_SCANNER_ANALYZER} static scan completed through the injected scan execution adapter; Core did not execute it. No findings != safe. Analyzers run: aih-native, ${CISCO_SKILL_SCANNER_ANALYZER}`,
    );
    expect(detectorCheck(result.checks, "cisco")?.detail).not.toContain("uv lock");

    // Nothing was spawned for it, while the other detectors kept their path.
    expect(argvs.filter((argv) => argv.join(" ").includes("skill-scanner"))).toEqual([]);
    expect(argvs.some((argv) => argv.join(" ").includes("semgrep"))).toBe(true);
    expect(detectorCheck(result.checks, "semgrep")?.detail).toContain(
      "DEGRADED-COVERAGE: deep scan SKIPPED — semgrep not available",
    );
  });

  it("accepts a bare detector id in the capability list", async () => {
    const adapter = stubAdapter(["cisco"], () =>
      Promise.resolve({ outcome: "succeeded", sarif: CISCO_SARIF }),
    );
    const { result } = await scan({ scanExecution: adapter });
    expect(adapter.requests).toHaveLength(1);
    expect(result.analyzersRun).toContain(CISCO_SKILL_SCANNER_ANALYZER);
  });

  it("carries a refusal's own text into the degraded-coverage reason", async () => {
    const adapter = stubAdapter(["detector.cisco"], () =>
      Promise.resolve({
        outcome: "refused",
        reason: "unsupported-platform",
        detail: "hardened execution is linux/amd64 only; this host is win32",
      }),
    );
    const { argvs, result } = await scan({ scanExecution: adapter });

    expect(detectorCheck(result.checks, "cisco")?.detail).toBe(
      "DEGRADED-COVERAGE: deep scan SKIPPED — cisco not available (hardened execution is linux/amd64 only; this host is win32); coverage is GREEN-tier only. Analyzers run: aih-native.",
    );
    expect(result.analyzersRun).not.toContain(CISCO_SKILL_SCANNER_ANALYZER);
    expect(argvs.filter((argv) => argv.join(" ").includes("skill-scanner"))).toEqual([]);
  });

  it("reports a failure stage rather than losing it", async () => {
    const adapter = stubAdapter(["detector.cisco"], () =>
      Promise.resolve({
        outcome: "failed",
        failure: { stage: "execution", detail: "container exited 137" },
      }),
    );
    const { result } = await scan({ scanExecution: adapter });
    expect(detectorCheck(result.checks, "cisco")?.detail).toContain("container exited 137");
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

  it("refuses success without SARIF and any shape it cannot read", async () => {
    const empty = await scan({
      scanExecution: stubAdapter(["detector.cisco"], () =>
        Promise.resolve({ outcome: "succeeded" }),
      ),
    });
    expect(detectorCheck(empty.result.checks, "cisco")?.detail).toContain(
      "scan execution adapter reported success without SARIF",
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
        Promise.resolve({ outcome: "succeeded", sarif: "not a sarif log" }),
      ),
    });
    expect(detectorCheck(notSarif.result.checks, "cisco")?.detail).toContain(
      "detector did not emit valid SARIF",
    );
  });

  it("bounds and de-controls whatever text the adapter returns", async () => {
    const adapter = stubAdapter(["detector.cisco"], () =>
      Promise.resolve({ outcome: "refused", detail: `a b${"x".repeat(1_000)}` }),
    );
    const { result } = await scan({ scanExecution: adapter });
    const detail = detectorCheck(result.checks, "cisco")?.detail ?? "";
    expect(detail).not.toContain(" ");
    expect(detail).toContain("a b");
    expect(detail).toContain("...");
    expect(detail.length).toBeLessThan(500);
  });
});
