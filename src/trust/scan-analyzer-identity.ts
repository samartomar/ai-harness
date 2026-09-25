import { SKILLSPECTOR_IMAGE_DIGEST, SKILLSPECTOR_SOURCE_REVISION } from "./images.js";
import {
  CISCO_MCP_SCANNER_VERSION,
  CISCO_SKILL_SCANNER_VERSION,
  SEMGREP_VERSION,
  SNYK_AGENT_SCAN_VERSION,
} from "./scanner-runtime-identity.js";

/**
 * One analyzer identity Core accepts from the installed `@aihq/scan`: the
 * analyzer version a detector's capability declares and, for a uv profile, the
 * sha256 of the uv.lock that profile installs (`executionProfiles[].analyzerLock`).
 */
export interface AcceptedScanAnalyzerIdentityV1 {
  readonly detectorId: string;
  readonly executionProfileId: string;
  readonly analyzerVersion: string;
  /** `null`: the profile installs no uv environment and must declare no lock. */
  readonly lockSha256: string | null;
  /** A known difference from Core's committed evidence, kept visible rather than accepted silently. */
  readonly knownGap?: string;
}

/**
 * Core's custody of the analyzers Scan runs for it: the exact identity Core
 * accepts per detector and execution profile. Scan is a carrier, not the
 * authority: a capability that declares another version or lock, or a run
 * whose evidence names one, is refused as `trust.detector-unavailable`, and a
 * baseline vet names its analyzers from this table, never from Scan's
 * declaration. These are the identities the Scan B2 candidate
 * (`@aihq/scan` 0.5.0, sep/scan-b2 f378c61) ships; a new analyzer or lock needs
 * a Core change that pins it.
 */
export const ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1: readonly AcceptedScanAnalyzerIdentityV1[] =
  Object.freeze([
    Object.freeze({
      detectorId: "detector.aih-trust-lint",
      executionProfileId: "in-process-trust-lint-v1",
      analyzerVersion: "1.0.0",
      lockSha256: null,
    }),
    Object.freeze({
      detectorId: "detector.aih-binding-gate",
      executionProfileId: "in-process-binding-gate-v1",
      analyzerVersion: "1.0.0",
      lockSha256: null,
    }),
    Object.freeze({
      detectorId: "detector.skillspector",
      executionProfileId: "docker-host-local-skillspector-v1",
      analyzerVersion: `${SKILLSPECTOR_SOURCE_REVISION}@${SKILLSPECTOR_IMAGE_DIGEST}`,
      lockSha256: null,
    }),
    Object.freeze({
      detectorId: "detector.semgrep",
      executionProfileId: "host-process-uv-v1",
      analyzerVersion: SEMGREP_VERSION,
      lockSha256: "77f2bf3e7525ceedb0a0ffba9cddb238be809efe965e6de6f135593772571d08",
    }),
    Object.freeze({
      detectorId: "detector.semgrep",
      executionProfileId: "linux-namespace-uv-v1",
      analyzerVersion: SEMGREP_VERSION,
      lockSha256: "77f2bf3e7525ceedb0a0ffba9cddb238be809efe965e6de6f135593772571d08",
    }),
    Object.freeze({
      detectorId: "detector.cisco",
      executionProfileId: "linux-namespace-uv-v1",
      analyzerVersion: CISCO_SKILL_SCANNER_VERSION,
      lockSha256: "aaba1f3260494b09dfc62fd6c309558b901b8ad9411587d534a4f09721d3b4a1",
    }),
    // KNOWN GAP, accepted explicitly: Scan's host profile installs its own Cisco
    // lock (tools/baseline-analyzers/cisco-skill-scanner-host: litellm 1.92.2
    // so the environment installs on Windows), not the namespace lock the
    // protected Scanner receipts pin ("cisco@uvx": 2.0.14+uvlock.aaba1f326049).
    // A fresh host-profile vet therefore names 2.0.14+uvlock.108c4f78340d, which
    // committed receipts do not match; reconciling the two is an owner decision.
    Object.freeze({
      detectorId: "detector.cisco",
      executionProfileId: "host-process-uv-v1",
      analyzerVersion: CISCO_SKILL_SCANNER_VERSION,
      lockSha256: "108c4f78340db9488bd73a03967055b19cdd3e8ece16ed31289e03f89e27d58f",
      knownGap:
        "the host-process Cisco lock is not the namespace lock the protected Scanner receipts pin",
    }),
    Object.freeze({
      detectorId: "detector.cisco-mcp-scanner",
      executionProfileId: "host-process-uv-v1",
      analyzerVersion: CISCO_MCP_SCANNER_VERSION,
      lockSha256: "92846b24c170bcf8ab380d5743bcce4504d249268712f2443f181a9b6789694a",
    }),
    Object.freeze({
      detectorId: "detector.snyk-agent-scan",
      executionProfileId: "host-process-uv-v1",
      analyzerVersion: SNYK_AGENT_SCAN_VERSION,
      lockSha256: "49064889ec53d91a5981cb5959d764c9bdf10843a54b5e5d339cfc046ad16169",
    }),
  ]);

/**
 * The profile Scan's baseline-vet batch runs each SARIF analyzer under, by
 * detector id, so the only one whose pinned analyzer a Scanner publication's
 * annex may name: aih-scan `BASELINE_BATCH_EXECUTION_PROFILES_V1`
 * (sep/scan-vet-evidence 3bd0ffb, src/baseline/runtime-v1.ts:2099-2106), which
 * the batch's default execution names for every analyzer it runs
 * (runtime-v1.ts:2121). SkillSpector's hardened Docker profile installs no lock;
 * its identity is the image.
 */
export const SCANNER_BASELINE_VET_EXECUTION_PROFILES_V1: Readonly<Record<string, string>> =
  Object.freeze({
    "detector.semgrep": "linux-namespace-uv-v1",
    "detector.skillspector": "docker-hardened-skillspector-v1",
    "detector.cisco": "linux-namespace-uv-v1",
  });

/** The identity Core accepts for a detector under a profile, or undefined when it pins none. */
export function acceptedScanAnalyzerIdentityV1(
  detectorId: string,
  executionProfileId: string,
): AcceptedScanAnalyzerIdentityV1 | undefined {
  return ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1.find(
    (entry) => entry.detectorId === detectorId && entry.executionProfileId === executionProfileId,
  );
}

/**
 * The analyzer version a run's observation states for this identity: a uv
 * analyzer names its version and the first 12 hex digits of its lock digest.
 */
export function observedScanAnalyzerVersionV1(identity: AcceptedScanAnalyzerIdentityV1): string {
  return identity.lockSha256 === null
    ? identity.analyzerVersion
    : `${identity.analyzerVersion}+uvlock.${identity.lockSha256.slice(0, 12)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Scan text reaches a report, so bound it and keep control characters out. */
function shown(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return "(unstated)";
  const visible = value.replace(/[\p{C}]/gu, " ").trim();
  return visible.length > 160 ? `${visible.slice(0, 157)}...` : visible;
}

type ObservedLock = string | null | "malformed";

/** A profile's `analyzerLock.sha256`: absent is `null`; anything but 64 lowercase hex is malformed. */
function profileLock(profile: Record<string, unknown> | undefined): ObservedLock {
  if (profile?.analyzerLock === undefined) return null;
  const sha256 = asRecord(profile.analyzerLock)?.sha256;
  return typeof sha256 === "string" && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : "malformed";
}

function lockText(lock: ObservedLock): string {
  return lock === null
    ? "no uv.lock"
    : lock === "malformed"
      ? "a malformed uv.lock"
      : `uv.lock ${lock}`;
}

function unpinned(detectorId: string, executionProfileId: string): string {
  return `Core accepts no analyzer identity for ${detectorId} under ${executionProfileId}`;
}

/**
 * Why the capability Scan declares for `detectorId` does not name the identity
 * Core accepts under `executionProfileId`, or undefined when it does.
 */
export function declaredScanAnalyzerIdentityRefusalV1(
  capability: Record<string, unknown> | undefined,
  detectorId: string,
  executionProfileId: string,
): string | undefined {
  const identity = acceptedScanAnalyzerIdentityV1(detectorId, executionProfileId);
  if (identity === undefined) return unpinned(detectorId, executionProfileId);
  const profiles = Array.isArray(capability?.executionProfiles) ? capability.executionProfiles : [];
  const profile = profiles.map(asRecord).find((entry) => entry?.id === executionProfileId);
  if (profile === undefined)
    return `${detectorId} declares no execution profile ${executionProfileId}`;
  const version = capability?.analyzerVersion;
  const lock = profileLock(profile);
  if (version === identity.analyzerVersion && lock === identity.lockSha256) return undefined;
  return `${detectorId} under ${executionProfileId} declares analyzer ${shown(version)} with ${lockText(lock)}; Core accepts ${identity.analyzerVersion} with ${lockText(identity.lockSha256)}`;
}

/**
 * Why SkillSpector's stated image (`evidence.observation.image`) is not one
 * Core accepts for the run, or undefined when it is: the digest is Core's
 * pinned digest or one Core's policy accepted for this request, stated with
 * the acceptance that digest implies and a reference, and the observation's
 * analyzer version names exactly that image under the pinned source revision.
 */
function skillspectorImageRefusal(
  observation: Record<string, unknown> | undefined,
  at: string,
  acceptedImageDigests: readonly string[],
): string | undefined {
  const image = asRecord(observation?.image);
  if (image === undefined)
    return `${at} states no image identity (evidence.observation.image), so Core cannot tell which image ran`;
  const approved = [...new Set([SKILLSPECTOR_IMAGE_DIGEST, ...acceptedImageDigests])];
  const digest = image.digest;
  if (typeof digest !== "string" || !approved.includes(digest))
    return `${at} ran image "${shown(digest)}", which is not a digest Core accepts (${approved.join(", ")})`;
  if (typeof image.reference !== "string" || image.reference.trim().length === 0)
    return `${at} states an image with no reference`;
  const acceptance = digest === SKILLSPECTOR_IMAGE_DIGEST ? "scan-pinned" : "caller-accepted";
  if (image.acceptance !== acceptance)
    return `${at} states image ${digest} as "${shown(image.acceptance)}"; Core expects "${acceptance}"`;
  const version = `${SKILLSPECTOR_SOURCE_REVISION}@${digest}`;
  if (observation?.analyzerVersion !== version)
    return `${at} states analyzer ${shown(observation?.analyzerVersion)} for image ${digest}; that image is analyzer ${version}`;
  return undefined;
}

/**
 * Why a succeeded run's own evidence (the profile that ran and the analyzer
 * version its observation states) does not name the identity Core accepts, or
 * undefined when it does. SkillSpector may also name an image digest Core's
 * policy accepted for this request, under the pinned source revision, and must
 * state the image that ran; no other detector runs an image or may state one.
 */
export function executedScanAnalyzerIdentityRefusalV1(
  result: unknown,
  detectorId: string,
  executionProfileId: string,
  options: { readonly acceptedImageDigests?: readonly string[] } = {},
): string | undefined {
  const identity = acceptedScanAnalyzerIdentityV1(detectorId, executionProfileId);
  if (identity === undefined) return unpinned(detectorId, executionProfileId);
  const record = asRecord(result);
  const lock = profileLock(asRecord(record?.executionProfile));
  const observation = asRecord(asRecord(record?.evidence)?.observation);
  const observed = observation?.analyzerVersion;
  const at = `${detectorId} under ${executionProfileId}`;
  const expected = observedScanAnalyzerVersionV1(identity);
  const accepted =
    detectorId === "detector.skillspector"
      ? [
          expected,
          ...(options.acceptedImageDigests ?? []).map(
            (digest) => `${SKILLSPECTOR_SOURCE_REVISION}@${digest}`,
          ),
        ]
      : [expected];
  if (
    !(typeof observed === "string" && accepted.includes(observed) && lock === identity.lockSha256)
  )
    return `${at} ran analyzer ${shown(observed)} with ${lockText(lock)}; Core accepts ${expected} with ${lockText(identity.lockSha256)}`;
  if (detectorId === "detector.skillspector")
    return skillspectorImageRefusal(observation, at, options.acceptedImageDigests ?? []);
  if (observation?.image !== undefined) return `${at} states an image identity, but runs no image`;
  return undefined;
}
