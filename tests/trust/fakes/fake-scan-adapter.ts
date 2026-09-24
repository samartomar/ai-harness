import { createHash } from "node:crypto";
import type { ScanExecutionAdapterV1 } from "../../../src/org-policy/governance-input-v1.js";

/**
 * TEST FAKE. An in-memory stand-in for the installed `@aihq/scan` public
 * `listDetectorCapabilitiesV1` / `runDetectorV1`, answering from data the test
 * supplies. It is not Scan and runs nothing. It returns what contract C2 says
 * Scan returns for a findings-producing run: a `baseline-analyzer-observation-v1`
 * observation whose bytes are SARIF 2.1.0 with source-relative URIs, bound by the
 * annex digest, under the execution profile the request named.
 *
 * Shapes follow Scan's own `DetectorCapabilityV1` and `RunDetectorV1Result`
 * (`aih-scan src/capability/detector-capability-v1.ts`, `src/runner/run-detector-v1.ts`).
 */

export type FakeScanAnswerV1 =
  | { readonly kind: "sarif"; readonly sarif: string; readonly executionProfileId?: string }
  /** SARIF computed from the request, e.g. for Core's selected paths. */
  | { readonly kind: "sarif-for"; readonly sarif: (request: Record<string, unknown>) => string }
  | { readonly kind: "refused"; readonly reason: string; readonly detail: string }
  | { readonly kind: "failed"; readonly stage: string; readonly detail: string }
  /** Holds the run open until the request's signal aborts, as a long analyzer run would. */
  | { readonly kind: "block-until-aborted" };

const EVERY_PLATFORM = [
  { os: "darwin", architecture: "amd64" },
  { os: "darwin", architecture: "arm64" },
  { os: "linux", architecture: "amd64" },
  { os: "linux", architecture: "arm64" },
  { os: "windows", architecture: "amd64" },
  { os: "windows", architecture: "arm64" },
] as const;
const LINUX_ONLY = [
  { os: "linux", architecture: "amd64" },
  { os: "linux", architecture: "arm64" },
] as const;

interface FakeProfile {
  readonly id: string;
  readonly analyzerLock?: { readonly path: string; readonly sha256: string };
  readonly isolation: "container" | "linux-namespace" | "none";
  readonly network: "none" | "acquisition-only" | "unenforced";
  readonly supportedPlatforms: readonly { readonly os: string; readonly architecture: string }[];
}

/** The uv.lock digest every fake uv profile publishes (C2a §3.7 `analyzerLock`). */
export const FAKE_UV_LOCK_SHA256 = "f".repeat(64);

const HOST_UV: FakeProfile = {
  id: "host-process-uv-v1",
  analyzerLock: { path: "uv.lock", sha256: FAKE_UV_LOCK_SHA256 },
  isolation: "none",
  network: "unenforced",
  supportedPlatforms: EVERY_PLATFORM,
};
const NAMESPACE_UV: FakeProfile = {
  id: "linux-namespace-uv-v1",
  analyzerLock: { path: "uv.lock", sha256: FAKE_UV_LOCK_SHA256 },
  isolation: "linux-namespace",
  network: "acquisition-only",
  supportedPlatforms: LINUX_ONLY,
};
const HOST_DOCKER: FakeProfile = {
  id: "docker-host-local-skillspector-v1",
  isolation: "container",
  network: "none",
  supportedPlatforms: EVERY_PLATFORM,
};
const TRUST_LINT: FakeProfile = {
  id: "in-process-trust-lint-v1",
  isolation: "none",
  network: "none",
  supportedPlatforms: EVERY_PLATFORM,
};
const BINDING_GATE: FakeProfile = {
  id: "in-process-binding-gate-v1",
  isolation: "none",
  network: "none",
  supportedPlatforms: EVERY_PLATFORM,
};

/** The profiles each detector declares in this fake, default first (as in C2). */
export const FAKE_SCAN_PROFILES: Readonly<Record<string, readonly FakeProfile[]>> = {
  "detector.aih-trust-lint": [TRUST_LINT],
  "detector.aih-binding-gate": [BINDING_GATE],
  "detector.skillspector": [HOST_DOCKER],
  "detector.cisco": [HOST_UV, NAMESPACE_UV],
  "detector.cisco-mcp-scanner": [HOST_UV, NAMESPACE_UV],
  "detector.semgrep": [HOST_UV, NAMESPACE_UV],
  "detector.snyk-agent-scan": [HOST_UV, NAMESPACE_UV],
};

function profileDocument(profile: FakeProfile) {
  return {
    ...profile,
    sha256: createHash("sha256").update(profile.id).digest("hex"),
    evidence: "BaselineAnalyzerObservationV1",
    prerequisites: [],
  };
}

export function fakeCapability(detectorId: string, profiles?: readonly FakeProfile[]) {
  const declared = profiles ?? FAKE_SCAN_PROFILES[detectorId] ?? [HOST_UV];
  const [first] = declared;
  if (first === undefined) throw new Error(`fake capability ${detectorId} declares no profile`);
  return {
    protocol: "DetectorCapabilityV1",
    detectorId,
    analyzerIdentity: null,
    analyzerVersion: "fake",
    executionProfile: profileDocument(first),
    executionProfiles: declared.map(profileDocument),
    subjectKinds: ["source-tree"],
    subjectRequirements: [],
    supportedPlatforms: first.supportedPlatforms,
    prerequisites: [],
    outputs: ["sarif-2.1.0"],
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface FakeScanAdapterForTests extends ScanExecutionAdapterV1 {
  /** Every request, exactly as Core sent it. */
  readonly requests: Record<string, unknown>[];
  /** Detector ids whose run the fake ended because the request's signal aborted. */
  readonly aborted: string[];
}

/**
 * A fake Scan answering `answers[detectorId]`. A detector with no answer is not
 * declared at all, so Core never sees a capability the fake cannot honour.
 */
export function createFakeScanAdapterForTests(
  answers: Readonly<Record<string, FakeScanAnswerV1>>,
  options: { readonly profiles?: Readonly<Record<string, readonly FakeProfile[]>> } = {},
): FakeScanAdapterForTests {
  const requests: Record<string, unknown>[] = [];
  const aborted: string[] = [];
  const capabilities = Object.keys(answers).map((id) => fakeCapability(id, options.profiles?.[id]));
  return {
    requests,
    aborted,
    listDetectorCapabilitiesV1: () => capabilities,
    async runDetectorV1(request) {
      const record = request as Record<string, unknown>;
      requests.push(record);
      const detectorId = String(record.detectorId);
      const capability = capabilities.find((entry) => entry.detectorId === detectorId);
      const answer = answers[detectorId];
      if (capability === undefined || answer === undefined)
        return {
          outcome: "refused",
          reason: "unknown-detector",
          detail: `fake has no ${detectorId}`,
        };
      const profile = capability.executionProfiles.find(
        (entry) => entry.id === record.executionProfileId,
      );
      if (profile === undefined)
        return {
          outcome: "refused",
          reason: "execution-profile-unavailable",
          detail: `fake ${detectorId} has no profile ${String(record.executionProfileId)}`,
          capability,
        };
      const signal = record.signal as AbortSignal | undefined;
      const failed = (stage: string, detail: string) => ({
        outcome: "failed",
        failure: { stage, detail },
        capability,
        executionProfile: profile,
        prerequisites: [],
        seams: { runner: "scan-owned-default", prerequisiteProbe: "scan-owned-default" },
        producer: { name: "@aihq/scan", version: "0.5.0-test-fake" },
        coverage: { kind: "source-tree", complete: true },
      });
      if (signal?.aborted === true) {
        aborted.push(detectorId);
        return failed("execution", "cancelled before the analyzer started");
      }
      if (answer.kind === "block-until-aborted") {
        if (signal === undefined) return failed("execution", "fake needs a signal to block on");
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        aborted.push(detectorId);
        return failed("execution", "cancelled: the analyzer process tree was killed");
      }
      if (answer.kind === "refused")
        return { outcome: "refused", reason: answer.reason, detail: answer.detail, capability };
      if (answer.kind === "failed") return failed(answer.stage, answer.detail);
      const text = answer.kind === "sarif-for" ? answer.sarif(record) : answer.sarif;
      const bytes = Buffer.from(text, "utf8");
      const ran = (answer.kind === "sarif" ? answer.executionProfileId : undefined) ?? profile.id;
      return {
        outcome: "succeeded",
        capability,
        executionProfile: { ...profile, id: ran },
        prerequisites: [],
        seams: { runner: "scan-owned-default", prerequisiteProbe: "scan-owned-default" },
        producer: { name: "@aihq/scan", version: "0.5.0-test-fake" },
        evidence: {
          kind: "baseline-analyzer-observation-v1",
          observation: {
            protocol: "BaselineAnalyzerObservationV1",
            analyzer: detectorId.replace(/^detector\./, ""),
            analyzerVersion: "fake",
            mediaType: "application/sarif+json",
            annex: {
              path: `annex/${detectorId}.json`,
              sha256: sha256(bytes),
              byteLength: bytes.byteLength,
            },
            bytes,
          },
        },
        findings: { protocol: "ScanFindingsV1", findings: [], gaps: [] },
        coverage: { kind: "source-tree", complete: true },
        sourceSeal: { before: {}, after: {} },
      };
    },
  };
}
