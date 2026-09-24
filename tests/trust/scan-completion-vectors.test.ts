import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import { runTrustDetectors, type TrustDetectorName } from "../../src/trust/detectors.js";
import { buildTrustFileInventory } from "../../src/trust/inventory.js";

// ---------------------------------------------------------------------------
// Completion evidence v1 (C2a §1.6) at Core's boundary, checked against
// INDEPENDENT vectors: the S2g contract's test vector and digests computed by
// hand (plain sha256 over the contract framing, never Core's subject code), and
// SARIF bytes written out here and handed to Core unmodified.
// ---------------------------------------------------------------------------

/** The contract's test vector: F = { SKILL.md "# alpha\n", scripts/run.sh "echo\n" }. */
const VECTOR_FILES = { "SKILL.md": "# alpha\n", "scripts/run.sh": "echo\n" } as const;
const VECTOR = {
  subjectTreeSha256: "adc6c170f014a8d238d3f18b3cd44e82cbfbe1f7fa9b4bafae6f5aab1cece047",
  analyzedFileCount: 2,
} as const;

const SEMGREP_HOST = {
  version: "1.173.0+uvlock.77f2bf3e7525",
  lockSha256: "77f2bf3e7525ceedb0a0ffba9cddb238be809efe965e6de6f135593772571d08",
} as const;
const CISCO_HOST = {
  version: "2.0.14+uvlock.108c4f78340d",
  lockSha256: "108c4f78340db9488bd73a03967055b19cdd3e8ece16ed31289e03f89e27d58f",
} as const;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-scan-completion-vectors-"));
  for (const [path, body] of Object.entries(VECTOR_FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, "utf8");
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function evidence(
  detectorId: string,
  subject: { readonly subjectTreeSha256: string; readonly analyzedFileCount: number },
  analyzer: { readonly version: string; readonly lockSha256: string | null },
) {
  return { detectorId, ...subject, analyzer };
}

/** One SARIF log, byte for byte what the test states: each run's first invocation carries `stated[i]`. */
function sarifLog(stated: readonly (Record<string, unknown> | undefined)[]): string {
  return JSON.stringify({
    version: "2.1.0",
    runs: stated.map((completion) => ({
      tool: { driver: { name: "fixture" } },
      invocations: [
        completion === undefined
          ? { executionSuccessful: true }
          : { executionSuccessful: true, properties: { aihScanCompletionV1: completion } },
      ],
      results: [],
    })),
  });
}

function detectorCheck(checks: readonly Check[], detector: string): Check | undefined {
  return checks.find((check) => check.name === `trust detector ${detector}`);
}

async function precomputed(detector: TrustDetectorName, sarif: string) {
  return runTrustDetectors(root, {
    env: {},
    platform: "linux",
    posture: "enterprise",
    inventory: buildTrustFileInventory(root),
    detectors: [detector],
    requiredDetectors: [detector],
    precomputedSarif: { [detector]: sarif },
  });
}

describe("precomputed SARIF counts complete only with completion evidence for this subject", () => {
  it("counts a precomputed run complete when every run proves the vector subject", async () => {
    const stated = evidence("detector.semgrep", VECTOR, SEMGREP_HOST);
    const result = await precomputed("semgrep", sarifLog([stated, stated]));
    expect(detectorCheck(result.checks, "semgrep")?.verdict).toBe("pass");
    expect(result.executions).toEqual([
      { detector: "semgrep", executedBy: "precomputed-sarif", outcome: "completed" },
    ]);
  });

  it("makes a pre-S2g publication (no completion evidence) typed completion-evidence-absent", async () => {
    const result = await precomputed("semgrep", sarifLog([undefined]));
    expect(detectorCheck(result.checks, "semgrep")).toMatchObject({
      verdict: "fail",
      code: "trust.detector-unavailable",
      detail: expect.stringContaining(
        "precomputed SARIF for detector.semgrep carries no completion evidence v1 (completion-evidence-absent)",
      ),
    });
    expect(result.executions).toEqual([
      {
        detector: "semgrep",
        executedBy: "precomputed-sarif",
        outcome: "unavailable",
        reason: "completion-evidence-absent",
      },
    ]);
    expect(result.analyzersRun).not.toContain("semgrep");
  });

  it.each([
    [
      "evidence missing from a later run",
      [evidence("detector.semgrep", VECTOR, SEMGREP_HOST), undefined],
      "SARIF whose run 1 carries no aihScanCompletionV1 completion evidence",
    ],
    [
      "evidence copied from another detector",
      [evidence("detector.skillspector", VECTOR, SEMGREP_HOST)],
      'completion evidence for "detector.skillspector", not the requested detector.semgrep',
    ],
    [
      "evidence for another subject",
      [
        evidence(
          "detector.semgrep",
          {
            subjectTreeSha256: "7b1ba80501ebc5f32a22229aef5a2944b2ac49d637ed4cff41e8f9ccda972198",
            analyzedFileCount: 1,
          },
          SEMGREP_HOST,
        ),
      ],
      `completion evidence for 1 files with subject tree 7b1ba80501ebc5f32a22229aef5a2944b2ac49d637ed4cff41e8f9ccda972198; the subject Core submitted has 2 files with subject tree ${VECTOR.subjectTreeSha256}`,
    ],
    [
      "evidence naming a lock Core does not accept",
      [evidence("detector.semgrep", VECTOR, { ...SEMGREP_HOST, lockSha256: "0".repeat(64) })],
      `completion evidence for analyzer "${SEMGREP_HOST.version}" with uv.lock ${"0".repeat(64)}`,
    ],
    [
      "evidence naming a version Core does not accept",
      [evidence("detector.semgrep", VECTOR, { ...SEMGREP_HOST, version: "9.9.9" })],
      'completion evidence for analyzer "9.9.9"',
    ],
  ])("refuses precomputed SARIF with %s", async (_label, stated, reason) => {
    const result = await precomputed("semgrep", sarifLog(stated));
    expect(detectorCheck(result.checks, "semgrep")).toMatchObject({
      verdict: "fail",
      code: "trust.detector-unavailable",
      detail: expect.stringContaining(
        `precomputed SARIF for detector.semgrep is refused: ${reason}`,
      ),
    });
    expect(result.executions).toEqual([
      { detector: "semgrep", executedBy: "precomputed-sarif", outcome: "failed" },
    ]);
  });

  it("counts precomputed Cisco complete on the selected SKILL.md directory union", async () => {
    const result = await precomputed(
      "cisco",
      sarifLog([evidence("detector.cisco", VECTOR, CISCO_HOST)]),
    );
    expect(result.executions).toEqual([
      { detector: "cisco", executedBy: "precomputed-sarif", outcome: "completed" },
    ]);
  });

  it("refuses per-job shard SARIF passed as plain text: only a join Core verified is exempt", async () => {
    const job = evidence(
      "detector.cisco",
      {
        subjectTreeSha256: "7b1ba80501ebc5f32a22229aef5a2944b2ac49d637ed4cff41e8f9ccda972198",
        analyzedFileCount: 1,
      },
      CISCO_HOST,
    );
    const result = await precomputed(
      "cisco",
      sarifLog([evidence("detector.cisco", VECTOR, CISCO_HOST), job]),
    );
    expect(detectorCheck(result.checks, "cisco")?.detail).toContain(
      "precomputed SARIF for detector.cisco is refused: SARIF whose runs carry different aihScanCompletionV1 completion evidence",
    );
  });

  it("refuses a look-alike of Core's verified shard join that Core did not issue", async () => {
    const result = await runTrustDetectors(root, {
      env: {},
      platform: "linux",
      posture: "enterprise",
      inventory: buildTrustFileInventory(root),
      detectors: ["cisco"],
      requiredDetectors: ["cisco"],
      precomputedSarif: {
        cisco: { kind: "verified-cisco-shard-join-v1", sarif: sarifLog([undefined]) },
      },
    });
    expect(detectorCheck(result.checks, "cisco")).toMatchObject({
      verdict: "fail",
      detail: expect.stringContaining(
        "precomputed SARIF for detector.cisco is refused: a shard join Core did not verify",
      ),
    });
  });
});
