import { createHash } from "node:crypto";
import type { ScanExecutionAdapterV1 } from "../../../src/org-policy/governance-input-v1.js";
import {
  acceptedScanAnalyzerIdentityV1,
  observedScanAnalyzerVersionV1,
} from "../../../src/trust/scan-analyzer-identity.js";
import { SCAN_COMPLETION_PROPERTY_V1 } from "../../../src/trust/scan-sarif.js";
import {
  scanDetectorSubjectFilesV1,
  scanSubjectDigestV1,
  sealedScanSubjectFilesV1,
} from "../../../src/trust/scan-subject-files.js";

/**
 * TEST FAKE. An in-memory stand-in for the installed `@aihq/scan` public
 * `listDetectorCapabilitiesV1` / `runDetectorV1`, answering from data the test
 * supplies. It is not Scan and runs nothing. It returns what contract C2 says
 * Scan returns for a findings-producing run: a `baseline-analyzer-observation-v1`
 * observation whose bytes are SARIF 2.1.0 with source-relative URIs, bound by the
 * annex digest, under the execution profile the request named. Its analyzer
 * identities are the ones Core accepts (`ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1`)
 * unless a test overrides them; a profile Core pins none for gets a fake lock.
 * Like Scan (C2a §1.6), it completes the SARIF a test supplies: every run gets
 * a tool driver and a successful invocation when it has none, and completion
 * evidence v1 for the subject the request names, unless the answer is `raw`.
 *
 * Shapes follow Scan's own `DetectorCapabilityV1` and `RunDetectorV1Result`
 * (`aih-scan src/capability/detector-capability-v1.ts`, `src/runner/run-detector-v1.ts`).
 */

export type FakeScanAnswerV1 =
  | {
      readonly kind: "sarif";
      readonly sarif: string;
      readonly executionProfileId?: string;
      /** The analyzer version the observation states, instead of the accepted one. */
      readonly observedAnalyzerVersion?: string;
      /** Return the SARIF bytes exactly as given: no driver, invocation or completion evidence added. */
      readonly raw?: boolean;
    }
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
  /** `accepted`: the lock Core pins for the detector under this profile. */
  readonly analyzerLock?: { readonly path: string; readonly sha256: string } | "accepted";
  readonly isolation: "container" | "linux-namespace" | "none";
  readonly network: "none" | "acquisition-only" | "unenforced";
  readonly supportedPlatforms: readonly { readonly os: string; readonly architecture: string }[];
}

/** The uv.lock digest a fake uv profile publishes when Core pins no lock for it. */
export const FAKE_UV_LOCK_SHA256 = "f".repeat(64);

const HOST_UV: FakeProfile = {
  id: "host-process-uv-v1",
  analyzerLock: "accepted",
  isolation: "none",
  network: "unenforced",
  supportedPlatforms: EVERY_PLATFORM,
};
const NAMESPACE_UV: FakeProfile = {
  id: "linux-namespace-uv-v1",
  analyzerLock: "accepted",
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

function profileDocument(detectorId: string, profile: FakeProfile) {
  const { analyzerLock, ...rest } = profile;
  const accepted = acceptedScanAnalyzerIdentityV1(detectorId, profile.id)?.lockSha256;
  const lock =
    analyzerLock === "accepted"
      ? { path: "uv.lock", sha256: accepted ?? FAKE_UV_LOCK_SHA256 }
      : analyzerLock;
  return {
    ...rest,
    ...(lock === undefined ? {} : { analyzerLock: lock }),
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
    analyzerVersion:
      acceptedScanAnalyzerIdentityV1(detectorId, first.id)?.analyzerVersion ?? "fake",
    executionProfile: profileDocument(detectorId, first),
    executionProfiles: declared.map((profile) => profileDocument(detectorId, profile)),
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

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Completion evidence v1 for this request, as Scan writes it: the subject
 * files of `subject.sourceRoot` under the detector's rule, and the analyzer.
 * Undefined when the subject cannot be read (Core then refuses the run).
 */
export function fakeScanCompletionEvidence(
  detectorId: string,
  request: Record<string, unknown>,
  analyzer: { readonly version: string; readonly lockSha256: string | null },
): Record<string, unknown> | undefined {
  const subject = asObject(request.subject);
  const sourceRoot = subject?.sourceRoot;
  const selected = subject?.selectedClosurePaths;
  if (typeof sourceRoot !== "string" || !Array.isArray(selected)) return undefined;
  const mcpConfigPaths = asObject(request.detectorOptions)?.mcpConfigPaths;
  try {
    const digest = scanSubjectDigestV1(
      scanDetectorSubjectFilesV1(detectorId, sourceRoot, {
        selectedClosurePaths: selected as string[],
        ...(Array.isArray(mcpConfigPaths) ? { mcpConfigPaths: mcpConfigPaths as string[] } : {}),
        sealed: () => sealedScanSubjectFilesV1(sourceRoot),
      }),
    );
    return { detectorId, ...digest, analyzer: { ...analyzer } };
  } catch {
    return undefined;
  }
}

/**
 * The SARIF text with every run completed as Scan completes it: a tool driver
 * and a successful first invocation when the run has none, and `evidence` in
 * `invocations[0].properties` unless the run already states some. Text that is
 * not a SARIF log with runs comes back unchanged.
 */
export function withFakeScanCompletion(
  text: string,
  detectorId: string,
  evidence: Record<string, unknown> | undefined,
): string {
  let log: unknown;
  try {
    log = JSON.parse(text);
  } catch {
    return text;
  }
  const runs = asObject(log)?.runs;
  if (!Array.isArray(runs)) return text;
  for (const run of runs) {
    const record = asObject(run);
    if (record === undefined) continue;
    record.tool ??= { driver: { name: `${detectorId.replace(/^detector\./, "")} (test fake)` } };
    record.invocations ??= [{ executionSuccessful: true }];
    const first = Array.isArray(record.invocations) ? asObject(record.invocations[0]) : undefined;
    if (first === undefined || evidence === undefined) continue;
    const properties = asObject(first.properties) ?? {};
    if (!Object.hasOwn(properties, SCAN_COMPLETION_PROPERTY_V1))
      first.properties = { ...properties, [SCAN_COMPLETION_PROPERTY_V1]: evidence };
  }
  return JSON.stringify(log);
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
      const given = answer.kind === "sarif-for" ? answer.sarif(record) : answer.sarif;
      const ran = (answer.kind === "sarif" ? answer.executionProfileId : undefined) ?? profile.id;
      const accepted = acceptedScanAnalyzerIdentityV1(detectorId, ran);
      const analyzerVersion =
        (answer.kind === "sarif" ? answer.observedAnalyzerVersion : undefined) ??
        (accepted === undefined ? "fake" : observedScanAnalyzerVersionV1(accepted));
      const lock = asObject((profile as Record<string, unknown>).analyzerLock)?.sha256;
      const text =
        answer.kind === "sarif" && answer.raw === true
          ? given
          : withFakeScanCompletion(
              given,
              detectorId,
              fakeScanCompletionEvidence(detectorId, record, {
                version: analyzerVersion,
                lockSha256: typeof lock === "string" ? lock : null,
              }),
            );
      const bytes = Buffer.from(text, "utf8");
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
            analyzerVersion,
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
