import { listDetectorCapabilitiesV1 } from "@aihq/scan";
import { describe, expect, it } from "vitest";
import { SCANNER_BASELINE_ANALYZER_VERSIONS } from "../../src/baseline-evidence/scanner-profile.js";
import {
  ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1,
  acceptedScanAnalyzerIdentityV1,
  declaredScanAnalyzerIdentityRefusalV1,
  executedScanAnalyzerIdentityRefusalV1,
  observedScanAnalyzerVersionV1,
} from "../../src/trust/scan-analyzer-identity.js";

const SEMGREP_LOCK = "5fae6a8598f7d5cf4921c0cb5bd1790accd756a2073abfb5c5f104ae64c5b594";
/** One Cisco lock for every profile since U1g (aih-scan tools/baseline-analyzers/cisco-skill-scanner). */
const CISCO_LOCK = "1e98c5679994dc56f82c1d88a77528d4c4b076160aff85b4d97ce239360bc210";
const MCP_LOCK = "b679f3afa51977495cc378cbf7e42ebbe9ef68eda38056d72613e9970bd99c16";
const SNYK_LOCK = "c71ffe188e38e2730c3525e710d54a0ab81e0ed914d2d132692d0ef79911d85f";
const SKILLSPECTOR_IDENTITY =
  "c7958a3268d9498644b22edb75d0f051bbc8cbfc@sha256:efe47bd7e073064426541381c8cb284162086950748424d1b4633788a2275bc6";

function capability(analyzerVersion: unknown, profile: Record<string, unknown>) {
  return { detectorId: "detector.semgrep", analyzerVersion, executionProfiles: [profile] };
}

function hostUv(lock?: unknown) {
  return {
    id: "host-process-uv-v1",
    ...(lock === undefined ? {} : { analyzerLock: { path: "uv.lock", sha256: lock } }),
  };
}

function ran(profile: Record<string, unknown>, analyzerVersion: unknown, image?: unknown) {
  return {
    outcome: "succeeded",
    executionProfile: profile,
    evidence: {
      kind: "baseline-analyzer-observation-v1",
      observation: { analyzerVersion, ...(image === undefined ? {} : { image }) },
    },
  };
}

const PINNED_DIGEST = "sha256:efe47bd7e073064426541381c8cb284162086950748424d1b4633788a2275bc6";
const PINNED_IMAGE = { digest: PINNED_DIGEST, reference: PINNED_DIGEST, acceptance: "scan-pinned" };

describe("Core's accepted Scan analyzer identities", () => {
  it("pins the identities the U1 analyzer upgrade ships, per detector and execution profile", () => {
    expect(
      ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1.map(
        (entry) =>
          `${entry.detectorId} ${entry.executionProfileId} ${entry.analyzerVersion} ${entry.lockSha256}`,
      ),
    ).toEqual([
      "detector.aih-trust-lint in-process-trust-lint-v1 1.0.0 null",
      "detector.aih-binding-gate in-process-binding-gate-v1 1.0.0 null",
      `detector.skillspector docker-host-local-skillspector-v1 ${SKILLSPECTOR_IDENTITY} null`,
      `detector.semgrep host-process-uv-v1 1.178.0 ${SEMGREP_LOCK}`,
      `detector.semgrep linux-namespace-uv-v1 1.178.0 ${SEMGREP_LOCK}`,
      `detector.cisco linux-namespace-uv-v1 2.1.0 ${CISCO_LOCK}`,
      `detector.cisco host-process-uv-v1 2.1.0 ${CISCO_LOCK}`,
      `detector.cisco-mcp-scanner host-process-uv-v1 4.8.4 ${MCP_LOCK}`,
      `detector.snyk-agent-scan host-process-uv-v1 0.6.4 ${SNYK_LOCK}`,
    ]);
  });

  it("accepts one Cisco lock under both profiles, the one the Scanner receipts name", () => {
    const host = acceptedScanAnalyzerIdentityV1("detector.cisco", "host-process-uv-v1");
    const namespace = acceptedScanAnalyzerIdentityV1("detector.cisco", "linux-namespace-uv-v1");
    expect(host).toEqual({ ...namespace, executionProfileId: "host-process-uv-v1" });
    expect(SCANNER_BASELINE_ANALYZER_VERSIONS["cisco@uvx"]).toBe(
      host === undefined ? "" : observedScanAnalyzerVersionV1(host),
    );
    expect(host === undefined ? "" : observedScanAnalyzerVersionV1(host)).toBe(
      "2.1.0+uvlock.1e98c5679994",
    );
    expect(Object.keys(host ?? {})).not.toContain("knownGap");
  });

  it("matches what the installed @aihq/scan candidate declares, for every accepted identity", () => {
    const capabilities = listDetectorCapabilitiesV1() as unknown as Record<string, unknown>[];
    for (const entry of ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1) {
      const capability = capabilities.find((c) => c.detectorId === entry.detectorId);
      expect(
        declaredScanAnalyzerIdentityRefusalV1(
          capability,
          entry.detectorId,
          entry.executionProfileId,
        ),
        `${entry.detectorId} under ${entry.executionProfileId}`,
      ).toBeUndefined();
    }
  });

  it("names no identity for a detector and profile it does not pin", () => {
    expect(
      acceptedScanAnalyzerIdentityV1("detector.snyk-agent-scan", "linux-namespace-uv-v1"),
    ).toBe(undefined);
    expect(acceptedScanAnalyzerIdentityV1("detector.aih-native", "in-process-native-v1")).toBe(
      undefined,
    );
  });
});

describe("the capability declaration must name the accepted identity", () => {
  it("accepts the pinned version and lock", () => {
    expect(
      declaredScanAnalyzerIdentityRefusalV1(
        capability("1.178.0", hostUv(SEMGREP_LOCK)),
        "detector.semgrep",
        "host-process-uv-v1",
      ),
    ).toBeUndefined();
  });

  it.each([
    [
      "an absent lock",
      capability("1.178.0", hostUv()),
      "declares analyzer 1.178.0 with no uv.lock",
    ],
    [
      "a different lock",
      capability("1.178.0", hostUv("0".repeat(64))),
      `declares analyzer 1.178.0 with uv.lock ${"0".repeat(64)}`,
    ],
    [
      "a malformed lock",
      capability("1.178.0", { id: "host-process-uv-v1", analyzerLock: "77f2" }),
      "declares analyzer 1.178.0 with a malformed uv.lock",
    ],
    [
      "a different version",
      capability("1.174.0", hostUv(SEMGREP_LOCK)),
      `declares analyzer 1.174.0 with uv.lock ${SEMGREP_LOCK}`,
    ],
    [
      "no version",
      capability(undefined, hostUv(SEMGREP_LOCK)),
      `declares analyzer (unstated) with uv.lock ${SEMGREP_LOCK}`,
    ],
  ])("refuses %s, naming the expected and the observed identity", (_label, declared, observed) => {
    const refusal = declaredScanAnalyzerIdentityRefusalV1(
      declared,
      "detector.semgrep",
      "host-process-uv-v1",
    );
    expect(refusal).toContain(`detector.semgrep under host-process-uv-v1 ${observed}`);
    expect(refusal).toContain(`Core accepts 1.178.0 with uv.lock ${SEMGREP_LOCK}`);
  });

  it("refuses a lock declared for a profile Core pins without one", () => {
    expect(
      declaredScanAnalyzerIdentityRefusalV1(
        {
          detectorId: "detector.aih-trust-lint",
          analyzerVersion: "1.0.0",
          executionProfiles: [
            { id: "in-process-trust-lint-v1", analyzerLock: { sha256: "a".repeat(64) } },
          ],
        },
        "detector.aih-trust-lint",
        "in-process-trust-lint-v1",
      ),
    ).toContain(
      `declares analyzer 1.0.0 with uv.lock ${"a".repeat(64)}; Core accepts 1.0.0 with no uv.lock`,
    );
  });

  it("refuses a detector and profile Core pins no identity for", () => {
    expect(
      declaredScanAnalyzerIdentityRefusalV1(
        {
          detectorId: "detector.snyk-agent-scan",
          analyzerVersion: "0.6.4",
          executionProfiles: [],
        },
        "detector.snyk-agent-scan",
        "linux-namespace-uv-v1",
      ),
    ).toBe(
      "Core accepts no analyzer identity for detector.snyk-agent-scan under linux-namespace-uv-v1",
    );
  });
});

describe("the execution evidence must name the accepted identity", () => {
  it("accepts the profile lock and the observation version that names it", () => {
    expect(
      executedScanAnalyzerIdentityRefusalV1(
        ran(hostUv(SEMGREP_LOCK), "1.178.0+uvlock.5fae6a8598f7"),
        "detector.semgrep",
        "host-process-uv-v1",
      ),
    ).toBeUndefined();
  });

  it.each([
    ["an absent profile lock", ran(hostUv(), "1.178.0+uvlock.5fae6a8598f7"), "with no uv.lock"],
    [
      "a different profile lock",
      ran(hostUv("1".repeat(64)), "1.178.0+uvlock.5fae6a8598f7"),
      `with uv.lock ${"1".repeat(64)}`,
    ],
    [
      "an observation naming another lock",
      ran(hostUv(SEMGREP_LOCK), "1.178.0+uvlock.000000000000"),
      "ran analyzer 1.178.0+uvlock.000000000000",
    ],
    [
      "an observation with no version",
      ran(hostUv(SEMGREP_LOCK), undefined),
      "ran analyzer (unstated)",
    ],
  ])("refuses %s, naming the expected and the observed identity", (_label, result, observed) => {
    const refusal = executedScanAnalyzerIdentityRefusalV1(
      result,
      "detector.semgrep",
      "host-process-uv-v1",
    );
    expect(refusal).toContain(observed);
    expect(refusal).toContain(
      `Core accepts 1.178.0+uvlock.5fae6a8598f7 with uv.lock ${SEMGREP_LOCK}`,
    );
  });

  it("accepts SkillSpector under the pinned image or an image digest Core's policy accepted", () => {
    const profile = { id: "docker-host-local-skillspector-v1" };
    const approved = `sha256:${"b".repeat(64)}`;
    const approvedImage = {
      digest: approved,
      reference: "skillspector:aih-c7958a3268d9",
      acceptance: "caller-accepted",
    };
    expect(
      executedScanAnalyzerIdentityRefusalV1(
        ran(profile, SKILLSPECTOR_IDENTITY, PINNED_IMAGE),
        "detector.skillspector",
        profile.id,
      ),
    ).toBeUndefined();
    expect(
      executedScanAnalyzerIdentityRefusalV1(
        ran(profile, `c7958a3268d9498644b22edb75d0f051bbc8cbfc@${approved}`, approvedImage),
        "detector.skillspector",
        profile.id,
        { acceptedImageDigests: [approved] },
      ),
    ).toBeUndefined();
    expect(
      executedScanAnalyzerIdentityRefusalV1(
        ran(profile, `c7958a3268d9498644b22edb75d0f051bbc8cbfc@${approved}`, approvedImage),
        "detector.skillspector",
        profile.id,
      ),
    ).toContain(`ran analyzer c7958a3268d9498644b22edb75d0f051bbc8cbfc@${approved}`);
  });

  const other = `sha256:${"c".repeat(64)}`;
  const unaccepted = `sha256:${"d".repeat(64)}`;
  it.each([
    ["no image", SKILLSPECTOR_IDENTITY, undefined, "states no image identity"],
    [
      "an image that is not an object",
      SKILLSPECTOR_IDENTITY,
      "sha256:x",
      "states no image identity",
    ],
    [
      "a malformed image digest",
      SKILLSPECTOR_IDENTITY,
      { ...PINNED_IMAGE, digest: "efe47bd7e073" },
      `ran image "efe47bd7e073", which is not a digest Core accepts (${PINNED_DIGEST}, ${other})`,
    ],
    [
      "an image digest Core does not accept",
      SKILLSPECTOR_IDENTITY,
      { ...PINNED_IMAGE, digest: unaccepted },
      `ran image "${unaccepted}", which is not a digest Core accepts (${PINNED_DIGEST}, ${other})`,
    ],
    [
      "an accepted image the analyzer version contradicts",
      SKILLSPECTOR_IDENTITY,
      { digest: other, reference: other, acceptance: "caller-accepted" },
      `states analyzer ${SKILLSPECTOR_IDENTITY} for image ${other}`,
    ],
    [
      "the pinned image stated as caller-accepted",
      SKILLSPECTOR_IDENTITY,
      { ...PINNED_IMAGE, acceptance: "caller-accepted" },
      `states image ${PINNED_DIGEST} as "caller-accepted"; Core expects "scan-pinned"`,
    ],
    [
      "an image with no reference",
      SKILLSPECTOR_IDENTITY,
      { digest: PINNED_DIGEST, acceptance: "scan-pinned" },
      "states an image with no reference",
    ],
  ])("refuses a SkillSpector run whose evidence states %s", (_label, version, image, reason) => {
    const refusal = executedScanAnalyzerIdentityRefusalV1(
      ran({ id: "docker-host-local-skillspector-v1" }, version, image),
      "detector.skillspector",
      "docker-host-local-skillspector-v1",
      { acceptedImageDigests: [other] },
    );
    expect(refusal).toContain(
      `detector.skillspector under docker-host-local-skillspector-v1 ${reason}`,
    );
  });

  it("refuses an image identity from a detector that runs no image", () => {
    expect(
      executedScanAnalyzerIdentityRefusalV1(
        ran(hostUv(SEMGREP_LOCK), "1.178.0+uvlock.5fae6a8598f7", PINNED_IMAGE),
        "detector.semgrep",
        "host-process-uv-v1",
      ),
    ).toBe("detector.semgrep under host-process-uv-v1 states an image identity, but runs no image");
  });
});

describe("the pre-upgrade analyzer identities are refused", () => {
  const profile = (id: string, lock?: string) => ({
    id,
    ...(lock === undefined ? {} : { analyzerLock: { path: "uv.lock", sha256: lock } }),
  });
  it.each([
    [
      "detector.semgrep",
      "host-process-uv-v1",
      "1.173.0",
      "77f2bf3e7525ceedb0a0ffba9cddb238be809efe965e6de6f135593772571d08",
    ],
    [
      "detector.semgrep",
      "linux-namespace-uv-v1",
      "1.173.0",
      "77f2bf3e7525ceedb0a0ffba9cddb238be809efe965e6de6f135593772571d08",
    ],
    [
      "detector.cisco",
      "linux-namespace-uv-v1",
      "2.0.14",
      "aaba1f3260494b09dfc62fd6c309558b901b8ad9411587d534a4f09721d3b4a1",
    ],
    [
      "detector.cisco",
      "host-process-uv-v1",
      "2.0.14",
      "108c4f78340db9488bd73a03967055b19cdd3e8ece16ed31289e03f89e27d58f",
    ],
    [
      "detector.cisco-mcp-scanner",
      "host-process-uv-v1",
      "4.8.2",
      "92846b24c170bcf8ab380d5743bcce4504d249268712f2443f181a9b6789694a",
    ],
    [
      "detector.snyk-agent-scan",
      "host-process-uv-v1",
      "0.5.17",
      "49064889ec53d91a5981cb5959d764c9bdf10843a54b5e5d339cfc046ad16169",
    ],
  ])(
    "%s under %s: declared %s is refused, and so is a run naming it",
    (detectorId, profileId, version, lock) => {
      const declared = declaredScanAnalyzerIdentityRefusalV1(
        { detectorId, analyzerVersion: version, executionProfiles: [profile(profileId, lock)] },
        detectorId,
        profileId,
      );
      expect(declared).toContain(
        `${detectorId} under ${profileId} declares analyzer ${version} with uv.lock ${lock}; Core accepts`,
      );
      const executed = executedScanAnalyzerIdentityRefusalV1(
        ran(profile(profileId, lock), `${version}+uvlock.${lock.slice(0, 12)}`),
        detectorId,
        profileId,
      );
      expect(executed).toContain(
        `${detectorId} under ${profileId} ran analyzer ${version}+uvlock.${lock.slice(0, 12)}`,
      );
    },
  );

  it("refuses the pre-upgrade SkillSpector image and revision", () => {
    const old = "sha256:c5d4a1816419f129ae85ff96b3e366d4a062c1859997e26b7ab87341a43d4800";
    const refusal = executedScanAnalyzerIdentityRefusalV1(
      ran(
        { id: "docker-host-local-skillspector-v1" },
        `2d198ab910add401cad658d1087e7c7ba24fd640@${old}`,
        { digest: old, reference: old, acceptance: "scan-pinned" },
      ),
      "detector.skillspector",
      "docker-host-local-skillspector-v1",
    );
    expect(refusal).toContain(
      `ran analyzer 2d198ab910add401cad658d1087e7c7ba24fd640@${old} with no uv.lock; Core accepts ${SKILLSPECTOR_IDENTITY}`,
    );
  });
});
