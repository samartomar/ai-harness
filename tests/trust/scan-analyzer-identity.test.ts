import { describe, expect, it } from "vitest";
import { SCANNER_BASELINE_ANALYZER_VERSIONS } from "../../src/baseline-evidence/scanner-profile.js";
import {
  ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1,
  acceptedScanAnalyzerIdentityV1,
  declaredScanAnalyzerIdentityRefusalV1,
  executedScanAnalyzerIdentityRefusalV1,
  observedScanAnalyzerVersionV1,
} from "../../src/trust/scan-analyzer-identity.js";

const SEMGREP_LOCK = "77f2bf3e7525ceedb0a0ffba9cddb238be809efe965e6de6f135593772571d08";
const CISCO_NAMESPACE_LOCK = "aaba1f3260494b09dfc62fd6c309558b901b8ad9411587d534a4f09721d3b4a1";
const CISCO_HOST_LOCK = "108c4f78340db9488bd73a03967055b19cdd3e8ece16ed31289e03f89e27d58f";
const SKILLSPECTOR_IDENTITY =
  "2d198ab910add401cad658d1087e7c7ba24fd640@sha256:c5d4a1816419f129ae85ff96b3e366d4a062c1859997e26b7ab87341a43d4800";

function capability(analyzerVersion: unknown, profile: Record<string, unknown>) {
  return { detectorId: "detector.semgrep", analyzerVersion, executionProfiles: [profile] };
}

function hostUv(lock?: unknown) {
  return {
    id: "host-process-uv-v1",
    ...(lock === undefined ? {} : { analyzerLock: { path: "uv.lock", sha256: lock } }),
  };
}

function ran(profile: Record<string, unknown>, analyzerVersion: unknown) {
  return {
    outcome: "succeeded",
    executionProfile: profile,
    evidence: { kind: "baseline-analyzer-observation-v1", observation: { analyzerVersion } },
  };
}

describe("Core's accepted Scan analyzer identities", () => {
  it("pins the identities the Scan B2 candidate ships, per detector and execution profile", () => {
    expect(
      ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1.map(
        (entry) =>
          `${entry.detectorId} ${entry.executionProfileId} ${entry.analyzerVersion} ${entry.lockSha256}`,
      ),
    ).toEqual([
      "detector.aih-trust-lint in-process-trust-lint-v1 1.0.0 null",
      "detector.aih-binding-gate in-process-binding-gate-v1 1.0.0 null",
      `detector.skillspector docker-host-local-skillspector-v1 ${SKILLSPECTOR_IDENTITY} null`,
      `detector.semgrep host-process-uv-v1 1.173.0 ${SEMGREP_LOCK}`,
      `detector.semgrep linux-namespace-uv-v1 1.173.0 ${SEMGREP_LOCK}`,
      `detector.cisco linux-namespace-uv-v1 2.0.14 ${CISCO_NAMESPACE_LOCK}`,
      `detector.cisco host-process-uv-v1 2.0.14 ${CISCO_HOST_LOCK}`,
      "detector.cisco-mcp-scanner host-process-uv-v1 4.8.2 92846b24c170bcf8ab380d5743bcce4504d249268712f2443f181a9b6789694a",
      "detector.snyk-agent-scan host-process-uv-v1 0.5.17 49064889ec53d91a5981cb5959d764c9bdf10843a54b5e5d339cfc046ad16169",
    ]);
  });

  it("keeps the known host-process Cisco lock gap explicit: it is not the lock the receipts pin", () => {
    const host = acceptedScanAnalyzerIdentityV1("detector.cisco", "host-process-uv-v1");
    const namespace = acceptedScanAnalyzerIdentityV1("detector.cisco", "linux-namespace-uv-v1");
    expect(SCANNER_BASELINE_ANALYZER_VERSIONS["cisco@uvx"]).toBe(
      namespace === undefined ? "" : observedScanAnalyzerVersionV1(namespace),
    );
    expect(host === undefined ? "" : observedScanAnalyzerVersionV1(host)).toBe(
      "2.0.14+uvlock.108c4f78340d",
    );
    expect(host?.knownGap).toContain("receipts");
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
        capability("1.173.0", hostUv(SEMGREP_LOCK)),
        "detector.semgrep",
        "host-process-uv-v1",
      ),
    ).toBeUndefined();
  });

  it.each([
    [
      "an absent lock",
      capability("1.173.0", hostUv()),
      "declares analyzer 1.173.0 with no uv.lock",
    ],
    [
      "a different lock",
      capability("1.173.0", hostUv("0".repeat(64))),
      `declares analyzer 1.173.0 with uv.lock ${"0".repeat(64)}`,
    ],
    [
      "a malformed lock",
      capability("1.173.0", { id: "host-process-uv-v1", analyzerLock: "77f2" }),
      "declares analyzer 1.173.0 with a malformed uv.lock",
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
    expect(refusal).toContain(`Core accepts 1.173.0 with uv.lock ${SEMGREP_LOCK}`);
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
          analyzerVersion: "0.5.17",
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
        ran(hostUv(SEMGREP_LOCK), "1.173.0+uvlock.77f2bf3e7525"),
        "detector.semgrep",
        "host-process-uv-v1",
      ),
    ).toBeUndefined();
  });

  it.each([
    ["an absent profile lock", ran(hostUv(), "1.173.0+uvlock.77f2bf3e7525"), "with no uv.lock"],
    [
      "a different profile lock",
      ran(hostUv("1".repeat(64)), "1.173.0+uvlock.77f2bf3e7525"),
      `with uv.lock ${"1".repeat(64)}`,
    ],
    [
      "an observation naming another lock",
      ran(hostUv(SEMGREP_LOCK), "1.173.0+uvlock.000000000000"),
      "ran analyzer 1.173.0+uvlock.000000000000",
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
      `Core accepts 1.173.0+uvlock.77f2bf3e7525 with uv.lock ${SEMGREP_LOCK}`,
    );
  });

  it("accepts SkillSpector under the pinned image or an image digest Core's policy accepted", () => {
    const profile = { id: "docker-host-local-skillspector-v1" };
    const approved = `sha256:${"b".repeat(64)}`;
    expect(
      executedScanAnalyzerIdentityRefusalV1(
        ran(profile, SKILLSPECTOR_IDENTITY),
        "detector.skillspector",
        profile.id,
      ),
    ).toBeUndefined();
    expect(
      executedScanAnalyzerIdentityRefusalV1(
        ran(profile, `2d198ab910add401cad658d1087e7c7ba24fd640@${approved}`),
        "detector.skillspector",
        profile.id,
        { acceptedImageDigests: [approved] },
      ),
    ).toBeUndefined();
    expect(
      executedScanAnalyzerIdentityRefusalV1(
        ran(profile, `2d198ab910add401cad658d1087e7c7ba24fd640@${approved}`),
        "detector.skillspector",
        profile.id,
      ),
    ).toContain(`ran analyzer 2d198ab910add401cad658d1087e7c7ba24fd640@${approved}`);
  });
});
