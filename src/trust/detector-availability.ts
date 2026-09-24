import type { Platform } from "../platform/base.js";
import {
  loadScanDetectorProbeV1,
  type ScanPackageImporterV1,
  ScanPackageRefusalError,
} from "../scan-package/load-scan-package.js";
import { startTrackedScanCall } from "../scan-package/settlement.js";
import {
  acceptedSkillspectorImageDigestsV1,
  requestedExecutionProfileV1,
  SCAN_DETECTOR_IDS,
  TRUST_DETECTOR_ANALYZER_LABELS,
  type TrustDetectorName,
  type UvExecutionProfileIdV1,
} from "./detectors.js";
import type { SkillSpectorImageApproval } from "./images.js";

// Availability preflight (C2a §3.8): Core asks the installed @aihq/scan whether
// each required detector could run here — prerequisites, offline environment,
// version gate, image present — without a subject. Scan never scans or pulls
// for a probe; Core only reports what Scan found.

export interface ScanDetectorProbeOptionsV1 {
  readonly platform: Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly uvExecutionProfileId?: UvExecutionProfileIdV1;
  readonly skillspectorImageApprovals?: readonly SkillSpectorImageApproval[];
  readonly signal?: AbortSignal;
  /** Test seam: resolves the package namespace. Production imports the installed peer. */
  readonly importer?: ScanPackageImporterV1;
}

export interface ScanDetectorUnavailableV1 {
  readonly detector: TrustDetectorName;
  readonly analyzerLabel: string;
  readonly reason: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function shown(value: unknown): string {
  const text = typeof value === "string" ? value : "no detail";
  const visible = text.replace(/[\p{C}]/gu, " ").trim();
  return visible.length > 300 ? `${visible.slice(0, 297)}...` : visible;
}

/**
 * The detectors Scan reports it cannot run here, with Scan's reason. A missing
 * or incompatible Scan throws `ScanPackageRefusalError`: without Scan no
 * detector is available, and that is the one answer Core must not soften.
 */
export async function probeScanDetectorsV1(
  detectors: readonly TrustDetectorName[],
  options: ScanDetectorProbeOptionsV1,
): Promise<ScanDetectorUnavailableV1[]> {
  const loaded = await loadScanDetectorProbeV1(options.importer);
  if (!loaded.ok) throw new ScanPackageRefusalError(loaded.refusal);
  const { listDetectorCapabilitiesV1, probeDetectorAvailabilityV1 } = loaded.exports;
  const capabilities = listDetectorCapabilitiesV1().map(asRecord);
  const unavailable: ScanDetectorUnavailableV1[] = [];
  for (const detector of detectors) {
    const analyzerLabel = TRUST_DETECTOR_ANALYZER_LABELS[detector];
    const detectorId = SCAN_DETECTOR_IDS[detector];
    const capability = capabilities.find((entry) => entry?.detectorId === detectorId);
    if (capability === undefined) {
      unavailable.push({
        detector,
        analyzerLabel,
        reason: `the installed @aihq/scan declares no ${detectorId} capability`,
      });
      continue;
    }
    const profile = requestedExecutionProfileV1(
      detector,
      capability,
      options.platform,
      options.uvExecutionProfileId,
    );
    if ("refusal" in profile) {
      unavailable.push({ detector, analyzerLabel, reason: profile.refusal });
      continue;
    }
    const digests =
      detector === "skillspector"
        ? acceptedSkillspectorImageDigestsV1(options.skillspectorImageApprovals ?? [])
        : [];
    const token = options.env.SNYK_TOKEN?.trim();
    const probe = asRecord(
      await startTrackedScanCall(options.signal, `${detectorId} availability probe`, () =>
        probeDetectorAvailabilityV1({
          detectorId,
          executionProfileId: profile.id,
          ...(digests.length === 0 ? {} : { acceptedImageDigests: digests }),
          ...(detector === "snyk-agent-scan" && token !== undefined && token.length > 0
            ? { env: { SNYK_TOKEN: token } }
            : {}),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      ),
    );
    if (probe?.available === true) continue;
    unavailable.push({
      detector,
      analyzerLabel,
      reason:
        probe?.available === false
          ? `${shown(probe.reason)}: ${shown(probe.detail)}`
          : `${detectorId} probe returned an unrecognized result`,
    });
  }
  return unavailable;
}
