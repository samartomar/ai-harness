import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Check } from "../../src/internals/verify.js";
import { runTrustDetectors, type TrustDetectorName } from "../../src/trust/detectors.js";
import { SKILLSPECTOR_IMAGE_DIGEST, SKILLSPECTOR_SOURCE_REVISION } from "../../src/trust/images.js";
import { buildTrustFileInventory } from "../../src/trust/inventory.js";
import {
  createVerbatimFakeScanAdapterForTests,
  type FakeScanAnswerV1,
} from "./fakes/fake-scan-adapter.js";

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
  version: "1.178.0+uvlock.5fae6a8598f7",
  lockSha256: "5fae6a8598f7d5cf4921c0cb5bd1790accd756a2073abfb5c5f104ae64c5b594",
} as const;
const CISCO_HOST = {
  version: "2.1.0+uvlock.1e98c5679994",
  lockSha256: "1e98c5679994dc56f82c1d88a77528d4c4b076160aff85b4d97ce239360bc210",
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

/** Cisco under `linux-namespace-uv-v1`: since U1g the same lock as the host profile. */
const CISCO_NAMESPACE = {
  version: "2.1.0+uvlock.1e98c5679994",
  lockSha256: "1e98c5679994dc56f82c1d88a77528d4c4b076160aff85b4d97ce239360bc210",
} as const;
const SNYK_HOST = {
  version: "0.6.4+uvlock.c71ffe188e38",
  lockSha256: "c71ffe188e38e2730c3525e710d54a0ab81e0ed914d2d132692d0ef79911d85f",
} as const;

async function precomputedUnder(
  detector: TrustDetectorName,
  sarif: string,
  uvExecutionProfileId?: "host-process-uv-v1" | "linux-namespace-uv-v1",
) {
  return runTrustDetectors(root, {
    env: {},
    platform: "linux",
    posture: "enterprise",
    inventory: buildTrustFileInventory(root),
    detectors: [detector],
    requiredDetectors: [detector],
    precomputedSarif: { [detector]: sarif },
    ...(uvExecutionProfileId === undefined ? {} : { uvExecutionProfileId }),
  });
}

describe("precomputed evidence must name the analyzer of the profile Core requires", () => {
  it.each(["linux-namespace-uv-v1", "host-process-uv-v1"] as const)(
    "completes a Cisco annex under %s: both Cisco profiles pin one lock",
    async (profile) => {
      const result = await precomputedUnder(
        "cisco",
        sarifLog([evidence("detector.cisco", VECTOR, CISCO_NAMESPACE)]),
        profile,
      );
      expect(CISCO_HOST).toEqual(CISCO_NAMESPACE);
      expect(result.executions).toEqual([
        { detector: "cisco", executedBy: "precomputed-sarif", outcome: "completed" },
      ]);
    },
  );

  it.each([
    [
      "the pre-upgrade namespace lock",
      "2.0.14+uvlock.aaba1f326049",
      "aaba1f3260494b09dfc62fd6c309558b901b8ad9411587d534a4f09721d3b4a1",
    ],
    [
      "the pre-upgrade host lock",
      "2.0.14+uvlock.108c4f78340d",
      "108c4f78340db9488bd73a03967055b19cdd3e8ece16ed31289e03f89e27d58f",
    ],
  ])("fails a Cisco annex naming %s", async (_label, version, lockSha256) => {
    const result = await precomputedUnder(
      "cisco",
      sarifLog([evidence("detector.cisco", VECTOR, { version, lockSha256 })]),
      "linux-namespace-uv-v1",
    );
    expect(result.executions).toEqual([
      { detector: "cisco", executedBy: "precomputed-sarif", outcome: "failed" },
    ]);
    expect(detectorCheck(result.checks, "cisco")?.detail).toContain(
      `precomputed SARIF for detector.cisco is refused: completion evidence for analyzer "${version}" with uv.lock ${lockSha256}; Core accepts ${CISCO_NAMESPACE.version} with uv.lock ${CISCO_NAMESPACE.lockSha256}`,
    );
  });

  it("completes a Semgrep annex under the namespace profile: both Semgrep profiles pin one lock", async () => {
    const result = await precomputedUnder(
      "semgrep",
      sarifLog([evidence("detector.semgrep", VECTOR, SEMGREP_HOST)]),
      "linux-namespace-uv-v1",
    );
    expect(result.executions).toEqual([
      { detector: "semgrep", executedBy: "precomputed-sarif", outcome: "completed" },
    ]);
  });

  it("fails a Snyk annex when the namespace profile is required: Core pins Snyk under no such profile", async () => {
    const result = await precomputedUnder(
      "snyk-agent-scan",
      sarifLog([evidence("detector.snyk-agent-scan", VECTOR, SNYK_HOST)]),
      "linux-namespace-uv-v1",
    );
    expect(result.executions).toEqual([
      { detector: "snyk-agent-scan", executedBy: "precomputed-sarif", outcome: "failed" },
    ]);
    expect(detectorCheck(result.checks, "snyk-agent-scan")?.detail).toContain(
      "precomputed SARIF for detector.snyk-agent-scan is refused: Core accepts no analyzer identity for detector.snyk-agent-scan under linux-namespace-uv-v1",
    );
  });
});

/** The vector tree after `late.md` ("late\n") is added: computed by hand, as above. */
const VECTOR_PLUS_LATE = {
  subjectTreeSha256: "32e7d04ea796c2a325903dfce932e583c632f1d5f876ae1560412c5343933ab7",
  analyzedFileCount: 3,
} as const;
const SKILLSPECTOR_DOCKER = {
  version: `${SKILLSPECTOR_SOURCE_REVISION}@${SKILLSPECTOR_IMAGE_DIGEST}`,
  lockSha256: null,
} as const;

async function delegated(
  detectors: readonly TrustDetectorName[],
  answers: Readonly<Record<string, FakeScanAnswerV1>>,
  progress?: (message: string) => void,
) {
  return runTrustDetectors(root, {
    env: {},
    platform: "linux",
    posture: "enterprise",
    inventory: buildTrustFileInventory(root),
    detectors,
    requiredDetectors: detectors,
    scanExecution: createVerbatimFakeScanAdapterForTests(answers),
    ...(progress === undefined ? {} : { progress }),
  });
}

describe("each detector call is bound to the subject as it stood for that call", () => {
  const addLateFileBeforeSemgrep = (message: string) => {
    if (message === "trust scan: detector semgrep started")
      writeFileSync(join(root, "late.md"), "late\n", "utf8");
  };
  const skillspectorOnVector: FakeScanAnswerV1 = {
    kind: "sarif",
    sarif: sarifLog([evidence("detector.skillspector", VECTOR, SKILLSPECTOR_DOCKER)]),
  };

  it("accepts Semgrep's evidence for the tree as changed after SkillSpector ran", async () => {
    const result = await delegated(
      ["skillspector", "semgrep"],
      {
        "detector.skillspector": skillspectorOnVector,
        "detector.semgrep": {
          kind: "sarif",
          sarif: sarifLog([evidence("detector.semgrep", VECTOR_PLUS_LATE, SEMGREP_HOST)]),
        },
      },
      addLateFileBeforeSemgrep,
    );
    expect(result.executions.map(({ detector, outcome }) => [detector, outcome])).toEqual([
      ["skillspector", "completed"],
      ["semgrep", "completed"],
    ]);
  });

  it("refuses Semgrep evidence replayed for the tree SkillSpector saw", async () => {
    const result = await delegated(
      ["skillspector", "semgrep"],
      {
        "detector.skillspector": skillspectorOnVector,
        "detector.semgrep": {
          kind: "sarif",
          sarif: sarifLog([evidence("detector.semgrep", VECTOR, SEMGREP_HOST)]),
        },
      },
      addLateFileBeforeSemgrep,
    );
    expect(detectorCheck(result.checks, "semgrep")).toMatchObject({
      verdict: "fail",
      detail: expect.stringContaining(
        `the subject Core submitted has 3 files with subject tree ${VECTOR_PLUS_LATE.subjectTreeSha256}`,
      ),
    });
    expect(result.executions[1]).toMatchObject({ detector: "semgrep", outcome: "failed" });
  });

  it("fails a detector whose tree changed while it ran, even with evidence for the submitted tree", async () => {
    const result = await delegated(["semgrep"], {
      "detector.semgrep": {
        kind: "sarif-for",
        sarif: () => {
          writeFileSync(join(root, "late.md"), "late\n", "utf8");
          return sarifLog([evidence("detector.semgrep", VECTOR, SEMGREP_HOST)]);
        },
      },
    });
    expect(detectorCheck(result.checks, "semgrep")).toMatchObject({
      verdict: "fail",
      code: "trust.detector-unavailable",
      detail: expect.stringContaining(
        `the source changed while detector.semgrep ran: Core submitted 2 files with subject tree ${VECTOR.subjectTreeSha256}, and the tree now has 3 files with subject tree ${VECTOR_PLUS_LATE.subjectTreeSha256}`,
      ),
    });
    expect(result.executions).toEqual([
      expect.objectContaining({ detector: "semgrep", executedBy: "scan", outcome: "failed" }),
    ]);
  });
});

describe("SkillSpector's run must state the image Core accepts", () => {
  const onVector = sarifLog([evidence("detector.skillspector", VECTOR, SKILLSPECTOR_DOCKER)]);

  it("completes with the pinned image, stated as Scan states it", async () => {
    const result = await delegated(["skillspector"], {
      "detector.skillspector": {
        kind: "sarif",
        sarif: onVector,
        image: {
          digest: SKILLSPECTOR_IMAGE_DIGEST,
          reference: SKILLSPECTOR_IMAGE_DIGEST,
          acceptance: "scan-pinned",
        },
      },
    });
    expect(result.executions).toEqual([
      expect.objectContaining({ detector: "skillspector", outcome: "completed" }),
    ]);
  });

  it.each([
    ["no image", undefined, "states no image identity"],
    [
      "another image under the pinned version",
      { digest: `sha256:${"e".repeat(64)}`, reference: "x", acceptance: "caller-accepted" },
      "which is not a digest Core accepts",
    ],
  ])(
    "fails a run that states %s, though its evidence proves the subject",
    async (_l, image, reason) => {
      const result = await delegated(["skillspector"], {
        "detector.skillspector": { kind: "sarif", sarif: onVector, image },
      });
      expect(detectorCheck(result.checks, "skillspector")).toMatchObject({
        verdict: "fail",
        code: "trust.detector-unavailable",
        detail: expect.stringContaining(reason),
      });
      expect(result.executions).toEqual([
        expect.objectContaining({ detector: "skillspector", outcome: "failed" }),
      ]);
    },
  );
});

describe("a delegated run counts complete only when Scan's unmodified bytes prove the vector subject", () => {
  const OTHER = {
    subjectTreeSha256: "7b1ba80501ebc5f32a22229aef5a2944b2ac49d637ed4cff41e8f9ccda972198",
    analyzedFileCount: 1,
  } as const;
  const semgrep = (sarif: string) =>
    delegated(["semgrep"], { "detector.semgrep": { kind: "sarif", sarif } });
  const failedWith = (checks: readonly Check[], detector: string, reason: string) =>
    expect(detectorCheck(checks, detector)).toMatchObject({
      verdict: "fail",
      code: "trust.detector-unavailable",
      detail: expect.stringContaining(reason),
    });

  it("completes a multi-run log whose every run states the vector subject", async () => {
    const stated = evidence("detector.semgrep", VECTOR, SEMGREP_HOST);
    const result = await semgrep(sarifLog([stated, stated]));
    expect(result.executions).toEqual([
      expect.objectContaining({ detector: "semgrep", executedBy: "scan", outcome: "completed" }),
    ]);
  });

  it.each([
    [
      "no completion evidence",
      sarifLog([undefined]),
      "detector.semgrep returned SARIF whose run 0 carries no aihScanCompletionV1 completion evidence",
    ],
    [
      "evidence missing from a later run",
      sarifLog([evidence("detector.semgrep", VECTOR, SEMGREP_HOST), undefined]),
      "detector.semgrep returned SARIF whose run 1 carries no aihScanCompletionV1 completion evidence",
    ],
    [
      "runs stating different subjects",
      sarifLog([
        evidence("detector.semgrep", VECTOR, SEMGREP_HOST),
        evidence("detector.semgrep", OTHER, SEMGREP_HOST),
      ]),
      "detector.semgrep returned SARIF whose runs carry different aihScanCompletionV1 completion evidence",
    ],
    [
      "evidence for another subject",
      sarifLog([evidence("detector.semgrep", OTHER, SEMGREP_HOST)]),
      `; the subject Core submitted has 2 files with subject tree ${VECTOR.subjectTreeSha256}`,
    ],
    [
      "evidence for another detector",
      sarifLog([evidence("detector.skillspector", VECTOR, SEMGREP_HOST)]),
      'completion evidence for "detector.skillspector", not the requested detector.semgrep',
    ],
    [
      "evidence naming another analyzer lock",
      sarifLog([
        evidence("detector.semgrep", VECTOR, { ...SEMGREP_HOST, lockSha256: "0".repeat(64) }),
      ]),
      `completion evidence for analyzer "${SEMGREP_HOST.version}" with uv.lock ${"0".repeat(64)}; Core accepts ${SEMGREP_HOST.version} with uv.lock ${SEMGREP_HOST.lockSha256}`,
    ],
  ])("fails the required detector for %s", async (_label, sarif, reason) => {
    const result = await semgrep(sarif);
    failedWith(result.checks, "semgrep", reason);
    expect(result.analyzersRun).not.toContain("semgrep@uv:1.178.0");
    expect(result.executions).toEqual([
      expect.objectContaining({ detector: "semgrep", outcome: "failed" }),
    ]);
  });

  it("keeps a required Snyk run strict: output without a driver or invocation fails at enterprise", async () => {
    // The shape Scan S2f's snyk-agent-scan engine emits: results, and nothing proving completion.
    const result = await delegated(["snyk-agent-scan"], {
      "detector.snyk-agent-scan": {
        kind: "sarif",
        sarif: JSON.stringify({ version: "2.1.0", runs: [{ results: [] }] }),
      },
    });
    failedWith(
      result.checks,
      "snyk-agent-scan",
      "detector.snyk-agent-scan returned SARIF whose run 0 names no tool driver",
    );
  });
});
