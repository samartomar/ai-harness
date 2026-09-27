/**
 * Shared custody, identity and receipt minting for observed upstream artifact
 * files.
 *
 * Two callers observe the same thing from different starting points: the
 * `policy observe upstream-artifact` command, which reads its request from an
 * administrator's options, and independent consumption of a saved organization
 * input, which reads the required paths from a freshly verified sealed closure.
 * Both must acquire files under identical custody rules and mint the same
 * receipt identity, so those steps live here once.
 *
 * Nothing here installs, applies or executes anything, and nothing here is
 * authority: a minted receipt is only ever an observation of exact bytes at
 * exact paths.
 */
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { canonicalStrictJsonBytesV1 } from "../contract/strict-json-v1.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { FileAssertion } from "../internals/plan.js";
import { isContainedEvidenceRelativePathV1 } from "./evidence-custody-v1.js";
import type { GovernanceDecisionV2 } from "./governance-decision-v2.js";
import {
  isCanonicalUpstreamArtifactPathV1,
  type UpstreamArtifactManifestV1,
} from "./upstream-artifact-manifest-v1.js";
import {
  MAX_UPSTREAM_OBSERVATION_WINDOW_MS,
  type UpstreamObservationReceiptV1,
  upstreamObservationReceiptDigestV1,
  type VerifiedUpstreamObservationV1,
  verifyUpstreamObservationV1,
} from "./upstream-observation-receipt-v1.js";

export const MAX_OBSERVED_FILE_BYTES_V1 = 4 * 1024 * 1024;
export const MAX_OBSERVED_TOTAL_BYTES_V1 = 64 * 1024 * 1024;

const OBSERVER_CONTRACT = Object.freeze({
  format: "aih-upstream-artifact-observer",
  manifestVersion: 1,
  maxFileBytes: MAX_OBSERVED_FILE_BYTES_V1,
  maxFiles: 256,
  maxTotalBytes: MAX_OBSERVED_TOTAL_BYTES_V1,
  version: 1,
});

/** The one code-owned observer identity every observation receipt is verified against. */
export const UPSTREAM_ARTIFACT_OBSERVER_V1 = Object.freeze({
  id: "upstream-artifact-observer",
  version: "1.0.0",
  digest: `sha256:${createHash("sha256")
    .update("aih-upstream-artifact-observer/v1\0", "utf8")
    .update(canonicalStrictJsonBytesV1(OBSERVER_CONTRACT))
    .digest("hex")}`,
});

/** Exact bounded grammar shared by live observation and durable lifecycle parsing. */
export function isCanonicalUpstreamArtifactRequestPathV1(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    isCanonicalUpstreamArtifactPathV1(value) &&
    isContainedEvidenceRelativePathV1(value)
  );
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function containedPath(root: string, path: string): string | undefined {
  if (!isContainedEvidenceRelativePathV1(path)) return undefined;
  const absolute = resolve(root, ...path.split("/"));
  return isContainedEvidenceRelativePathV1(relative(root, absolute)) ? absolute : undefined;
}

function parentState(root: string, absolute: string): "safe" | "unsafe" | "unavailable" {
  const rootStat = safeLstat(root);
  if (rootStat === undefined) return "unavailable";
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return "unsafe";
  const rel = relative(root, absolute);
  if (!isContainedEvidenceRelativePathV1(rel)) return "unsafe";
  let cursor = root;
  for (const segment of rel.split(sep).slice(0, -1)) {
    cursor = join(cursor, segment);
    const stat = safeLstat(cursor);
    if (stat === undefined) return "unavailable";
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "unsafe";
  }
  return "safe";
}

export interface CustodiedObservedFileV1 {
  readonly assertion: FileAssertion;
  readonly bytes: Buffer;
  readonly identity: { readonly dev: bigint; readonly ino: bigint; readonly nlink: bigint };
  readonly rawDigest: string;
  readonly size: number;
  unchanged(): boolean;
}

/**
 * Acquire one regular, root-contained file with no symlinked component, and
 * keep a closure that proves the same identity and bytes survived every later
 * step of the observation.
 */
export function custodyObservedFileV1(
  root: string,
  path: string,
  maxBytes: number,
  describe: string,
): CustodiedObservedFileV1 | "unsafe" | "unavailable" {
  const absolute = containedPath(root, path);
  if (absolute === undefined) return "unsafe";
  const parents = parentState(root, absolute);
  if (parents !== "safe") return parents;
  const opened = readRegularFileWithStats(absolute, { maxBytes });
  if (opened === undefined) {
    const stat = safeLstat(absolute);
    return stat === undefined ? "unavailable" : "unsafe";
  }
  const bytes = Buffer.from(opened.contents);
  const identity = {
    dev: opened.identity.dev,
    ino: opened.identity.ino,
    nlink: opened.identity.nlink,
    size: opened.stats.size,
  };
  const raw = createHash("sha256").update(bytes).digest("hex");
  return {
    assertion: { path, sha256: raw, maxBytes, describe },
    bytes,
    identity: { dev: identity.dev, ino: identity.ino, nlink: identity.nlink },
    rawDigest: `sha256:${raw}`,
    size: bytes.byteLength,
    unchanged(): boolean {
      if (parentState(root, absolute) !== "safe") return false;
      const current = readRegularFileWithStats(absolute, { maxBytes });
      return (
        current !== undefined &&
        current.identity.dev === identity.dev &&
        current.identity.ino === identity.ino &&
        current.identity.nlink === identity.nlink &&
        current.stats.size === identity.size &&
        current.contents.equals(bytes)
      );
    },
  };
}

/** The installed identity a receipt commits to: exactly what the manifest declares. */
export function installedUpstreamArtifactIdentityV1(manifest: UpstreamArtifactManifestV1): {
  id: string;
  digest: string;
} {
  const identity = {
    effect: manifest.effect,
    files: manifest.files,
    integration: manifest.integration,
    subject: manifest.subject,
    target: manifest.target,
  };
  return {
    id: "upstream-artifact-files",
    digest: `sha256:${createHash("sha256")
      .update("aih-upstream-artifact-installed/v1\0", "utf8")
      .update(canonicalStrictJsonBytesV1(identity))
      .digest("hex")}`,
  };
}

export interface MintedUpstreamObservationV1 {
  readonly receipt: UpstreamObservationReceiptV1;
  readonly digest: string;
  readonly installed: { id: string; digest: string };
  readonly integration: UpstreamObservationReceiptV1["integration"];
  /** Absent when the minted receipt did not survive its own verification seam. */
  readonly observation: VerifiedUpstreamObservationV1 | undefined;
}

/**
 * Mint one observation receipt for exactly the files a manifest declares, and
 * verify it through the code-owned seam. The window never outlives the
 * authority, the decision, its review date, the evidence, or the 24-hour
 * observation ceiling, whichever comes first.
 */
export function mintUpstreamObservationReceiptV1(input: {
  readonly authorityExpiresAt: string;
  readonly decision: GovernanceDecisionV2;
  readonly decisionReference: { readonly id: string; readonly digest: string };
  readonly evidenceExpiresAt: string;
  readonly manifest: UpstreamArtifactManifestV1;
  readonly observedAt: string;
  readonly target: string;
}): MintedUpstreamObservationV1 {
  const installed = installedUpstreamArtifactIdentityV1(input.manifest);
  const integration = {
    mode: "upstream-managed" as const,
    owner: input.manifest.integration.owner,
    version: input.manifest.integration.version,
  };
  const bound = Math.min(
    Date.parse(input.authorityExpiresAt),
    Date.parse(input.decision.expiresAt),
    Date.parse(input.evidenceExpiresAt),
    input.decision.disposition === "accepted-with-conditions"
      ? Date.parse(input.decision.reviewBy)
      : Number.POSITIVE_INFINITY,
    Date.parse(input.observedAt) + MAX_UPSTREAM_OBSERVATION_WINDOW_MS,
  );
  // An unparseable instant mints a receipt its own schema refuses, rather than
  // throwing: every caller of this seam must get a verdict, never an exception.
  const validUntil = Number.isFinite(bound) ? new Date(bound).toISOString() : input.observedAt;
  const receipt: UpstreamObservationReceiptV1 = {
    format: "aih-upstream-observation-receipt",
    version: 1,
    id: "observation-upstream-artifact",
    decision: { id: input.decisionReference.id, digest: input.decisionReference.digest },
    subject: input.manifest.subject,
    targets: [input.target],
    allowedEffects: [input.manifest.effect],
    integration,
    installed,
    verifier: UPSTREAM_ARTIFACT_OBSERVER_V1,
    observedAt: input.observedAt,
    validUntil,
    outcome: "observed-success",
  };
  const digest = upstreamObservationReceiptDigestV1(receipt);
  const observation = verifyUpstreamObservationV1({
    receipt,
    expectedVerifier: UPSTREAM_ARTIFACT_OBSERVER_V1,
    expectedInstalled: installed,
    expectedIntegration: integration,
    subject: input.decision.subject,
    target: input.target,
    effect: input.manifest.effect,
    supportedTargets: SUPPORTED_CLIS,
    now: input.observedAt,
    verify: (candidate) => upstreamObservationReceiptDigestV1(candidate) === digest,
  });
  return { receipt, digest, installed, integration, observation };
}

// --------------------------------------------------------------------------
// The installation mapping
// --------------------------------------------------------------------------

export interface ObservedFileMappingV1 {
  /** The path the scan sealed, relative to the scanned source tree. */
  readonly sealedPath: string;
  /** Where that exact file must be installed, relative to the consumption root. */
  readonly observedPath: string;
  /** The sealed record's bare digest. */
  readonly sha256: string;
  readonly byteLength: number;
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * An installation root is a bounded, root-relative directory an administrator
 * names explicitly. It is never derived from the material, and never a
 * filesystem-absolute or escaping path.
 */
export function isBoundedObservationInstallRootV1(value: unknown): value is string {
  return isCanonicalUpstreamArtifactRequestPathV1(value);
}

/**
 * The exact set of paths an installation must present: one observed path per
 * sealed file, under the named root. Identical bytes under another name are a
 * different path, so this mapping is the whole basis of the match — it refuses
 * rather than guesses whenever it cannot build the set one-to-one.
 */
export function requiredObservedPathsV1(input: {
  readonly installRoot: unknown;
  readonly sealedFiles: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly byteLength: number;
  }[];
}): readonly ObservedFileMappingV1[] | undefined {
  if (!isBoundedObservationInstallRootV1(input.installRoot)) return undefined;
  if (!Array.isArray(input.sealedFiles) || input.sealedFiles.length === 0) return undefined;
  const mapping: ObservedFileMappingV1[] = [];
  const sealedPaths = new Set<string>();
  const observedPaths = new Set<string>();
  for (const file of input.sealedFiles) {
    const observedPath = `${input.installRoot}/${file.path}`;
    if (!isCanonicalUpstreamArtifactRequestPathV1(observedPath)) return undefined;
    // One installed file can never cover two sealed records, on any filesystem.
    if (sealedPaths.has(file.path) || observedPaths.has(observedPath.toLowerCase()))
      return undefined;
    sealedPaths.add(file.path);
    observedPaths.add(observedPath.toLowerCase());
    mapping.push({
      sealedPath: file.path,
      observedPath,
      sha256: file.sha256,
      byteLength: file.byteLength,
    });
  }
  return mapping.sort((left, right) => ordinalCompare(left.observedPath, right.observedPath));
}

/**
 * Exact one-to-one comparison between the required paths and what a manifest
 * declares. A missing path, an extra path, a duplicate, or a different name
 * all fail; ordering never matters.
 */
export function observedPathSetMatchesV1(
  required: readonly ObservedFileMappingV1[],
  declared: readonly string[],
): boolean {
  if (required.length === 0 || required.length !== declared.length) return false;
  const declaredPaths = new Set(declared);
  if (declaredPaths.size !== declared.length) return false;
  return required.every((file) => declaredPaths.has(file.observedPath));
}
