import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import { runTrustDetectors, type TrustDetectorName } from "../../src/trust/detectors.js";
import { SKILLSPECTOR_IMAGE_DIGEST, SKILLSPECTOR_SOURCE_REVISION } from "../../src/trust/images.js";
import { buildTrustFileInventory } from "../../src/trust/inventory.js";

// ---------------------------------------------------------------------------
// Scanner-publication (baseline-vet) annexes, C2a §1.6 [Scan: S2j], decision
// D24: the batch analyzes a snapshot that never holds a top-level `.git`, so
// for Semgrep, SkillSpector and Cisco alike F is every file outside it, and
// the analyzer is the one Scan's batch runs (BASELINE_BATCH_EXECUTION_PROFILES_V1).
// Checked against the S2j hand vector: digests are literals computed by hand
// with plain node:crypto, never Core's subject code.
// ---------------------------------------------------------------------------

const VECTOR_FILES = {
  ".git/HEAD": "ref: refs/heads/main\n",
  "SKILL.md": "---\nname: vector\ndescription: baseline completion vector\n---\n# Vector\n",
  "src/a.js": "console.log(1);\n",
} as const;
/** F = { SKILL.md, src/a.js }: the baseline subject. */
const BASELINE = {
  subjectTreeSha256: "6d8a18d0f8e75ac27da59b7ab2d95d40e6c7a9d514ee448212ee3d26ae9b8c3e",
  analyzedFileCount: 2,
} as const;
/** F with `.git/HEAD` too: the delegated Semgrep/SkillSpector subject over the same tree. */
const WITH_GIT = {
  subjectTreeSha256: "97c4ab9cc9b887bd70d66a8be8c5d6c51bd3e9df93c87d5d13f9d3a0b4651796",
  analyzedFileCount: 3,
} as const;

const SEMGREP_NAMESPACE = {
  version: "1.173.0+uvlock.77f2bf3e7525",
  lockSha256: "77f2bf3e7525ceedb0a0ffba9cddb238be809efe965e6de6f135593772571d08",
} as const;
const CISCO_NAMESPACE = {
  version: "2.0.14+uvlock.aaba1f326049",
  lockSha256: "aaba1f3260494b09dfc62fd6c309558b901b8ad9411587d534a4f09721d3b4a1",
} as const;
const CISCO_HOST = {
  version: "2.0.14+uvlock.108c4f78340d",
  lockSha256: "108c4f78340db9488bd73a03967055b19cdd3e8ece16ed31289e03f89e27d58f",
} as const;
const SKILLSPECTOR_HARDENED = {
  version: `${SKILLSPECTOR_SOURCE_REVISION}@${SKILLSPECTOR_IMAGE_DIGEST}`,
  lockSha256: null,
} as const;
const SNYK_HOST = {
  version: "0.5.17+uvlock.49064889ec53",
  lockSha256: "49064889ec53d91a5981cb5959d764c9bdf10843a54b5e5d339cfc046ad16169",
} as const;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-baseline-annex-vector-"));
  for (const [path, body] of Object.entries(VECTOR_FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, "utf8");
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** One SARIF log whose single run's first invocation states `completion` (or none). */
function annex(completion?: Record<string, unknown>): string {
  return JSON.stringify({
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "fixture" } },
        invocations: [
          completion === undefined
            ? { executionSuccessful: true }
            : { executionSuccessful: true, properties: { aihScanCompletionV1: completion } },
        ],
        results: [],
      },
    ],
  });
}

function evidence(
  detectorId: string,
  subject: { readonly subjectTreeSha256: string; readonly analyzedFileCount: number },
  analyzer: { readonly version: string; readonly lockSha256: string | null },
) {
  return { detectorId, ...subject, analyzer };
}

async function scan(
  detector: TrustDetectorName,
  sarif: string,
  origin: "scanner-baseline-vet" | "inline" = "scanner-baseline-vet",
) {
  return runTrustDetectors(root, {
    env: {},
    platform: "linux",
    posture: "enterprise",
    inventory: buildTrustFileInventory(root),
    detectors: [detector],
    requiredDetectors: [detector],
    precomputedSarif: { [detector]: sarif },
    ...(origin === "inline" ? {} : { precomputedSarifOrigin: origin }),
  });
}

function detail(checks: readonly Check[], detector: string): string {
  return checks.find((check) => check.name === `trust detector ${detector}`)?.detail ?? "";
}

describe("a Scanner-publication annex is checked against the baseline subject", () => {
  it.each([
    ["semgrep", "detector.semgrep", SEMGREP_NAMESPACE],
    ["skillspector", "detector.skillspector", SKILLSPECTOR_HARDENED],
    ["cisco", "detector.cisco", CISCO_NAMESPACE],
  ] as const)(
    "completes %s evidence for F without the top-level .git",
    async (name, id, analyzer) => {
      const result = await scan(name, annex(evidence(id, BASELINE, analyzer)));
      expect(result.executions).toEqual([
        { detector: name, executedBy: "precomputed-sarif", outcome: "completed" },
      ]);
    },
  );

  it.each([
    ["semgrep", "detector.semgrep", SEMGREP_NAMESPACE],
    ["skillspector", "detector.skillspector", SKILLSPECTOR_HARDENED],
    ["cisco", "detector.cisco", CISCO_NAMESPACE],
  ] as const)(
    "fails %s evidence whose subject includes the top-level .git",
    async (name, id, analyzer) => {
      const result = await scan(name, annex(evidence(id, WITH_GIT, analyzer)));
      expect(result.executions).toEqual([
        { detector: name, executedBy: "precomputed-sarif", outcome: "failed" },
      ]);
      expect(detail(result.checks, name)).toContain(
        `precomputed SARIF for ${id} is refused: completion evidence for 3 files with subject tree ${WITH_GIT.subjectTreeSha256}; the subject Core submitted has 2 files with subject tree ${BASELINE.subjectTreeSha256}`,
      );
    },
  );

  it("keeps an evidence-less annex typed completion-evidence-absent (D17)", async () => {
    const result = await scan("semgrep", annex());
    expect(result.executions).toEqual([
      {
        detector: "semgrep",
        executedBy: "precomputed-sarif",
        outcome: "unavailable",
        reason: "completion-evidence-absent",
      },
    ]);
  });

  it("refuses a Cisco annex naming the host-profile lock: the batch runs linux-namespace-uv-v1", async () => {
    const result = await scan("cisco", annex(evidence("detector.cisco", BASELINE, CISCO_HOST)));
    expect(result.executions).toEqual([
      { detector: "cisco", executedBy: "precomputed-sarif", outcome: "failed" },
    ]);
    expect(detail(result.checks, "cisco")).toContain(
      `precomputed SARIF for detector.cisco is refused: completion evidence names the analyzer Core pins for detector.cisco under host-process-uv-v1 (${CISCO_HOST.version} with uv.lock ${CISCO_HOST.lockSha256}); Core requires the one it pins under linux-namespace-uv-v1 (${CISCO_NAMESPACE.version} with uv.lock ${CISCO_NAMESPACE.lockSha256})`,
    );
  });

  it("refuses a SkillSpector annex naming an image digest Core does not accept", async () => {
    const other = `sha256:${"0".repeat(64)}`;
    const result = await scan(
      "skillspector",
      annex(
        evidence("detector.skillspector", BASELINE, {
          version: `${SKILLSPECTOR_SOURCE_REVISION}@${other}`,
          lockSha256: null,
        }),
      ),
    );
    expect(result.executions).toEqual([
      { detector: "skillspector", executedBy: "precomputed-sarif", outcome: "failed" },
    ]);
    expect(detail(result.checks, "skillspector")).toContain(
      `precomputed SARIF for detector.skillspector is refused: completion evidence for analyzer "${SKILLSPECTOR_SOURCE_REVISION}@${other}"`,
    );
  });

  it("refuses an annex for a detector a baseline vet never runs", async () => {
    const result = await scan(
      "snyk-agent-scan",
      annex(evidence("detector.snyk-agent-scan", BASELINE, SNYK_HOST)),
    );
    expect(result.executions).toEqual([
      { detector: "snyk-agent-scan", executedBy: "precomputed-sarif", outcome: "failed" },
    ]);
    expect(detail(result.checks, "snyk-agent-scan")).toContain(
      "precomputed SARIF for detector.snyk-agent-scan is refused: a baseline vet publishes no detector.snyk-agent-scan annex; it runs only detector.semgrep, detector.skillspector and detector.cisco",
    );
  });
});

describe("inline precomputed SARIF keeps the per-detector rule", () => {
  it("still requires Semgrep evidence for the whole tree, top-level .git included", async () => {
    const baseline = await scan(
      "semgrep",
      annex(evidence("detector.semgrep", BASELINE, SEMGREP_NAMESPACE)),
      "inline",
    );
    expect(baseline.executions[0]?.outcome).toBe("failed");
    const whole = await scan(
      "semgrep",
      annex(evidence("detector.semgrep", WITH_GIT, SEMGREP_NAMESPACE)),
      "inline",
    );
    expect(whole.executions[0]?.outcome).toBe("completed");
  });
});
