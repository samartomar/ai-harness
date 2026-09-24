import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, posix, relative } from "node:path";
import { hashComponentTree } from "../baseline-evidence/hash.js";
import type { Posture } from "../config/posture.js";
import { AihError } from "../errors.js";
import type { Check, CheckCode } from "../internals/verify.js";
import type { ScanExecutionAdapterV1 } from "../org-policy/governance-input-v1.js";
import type { Platform } from "../platform/base.js";
import {
  loadScanExecutionAdapterV1,
  SCAN_PACKAGE_INSTALL_COMMAND,
  SCAN_PACKAGE_PROJECT_INSTALL_COMMAND,
  ScanPackageRefusalError,
  type ScanPackageRefusalReasonV1,
  type ScanPackageRefusalV1,
  scanPackageRefusalMessage,
} from "../scan-package/load-scan-package.js";
import { startTrackedScanCall } from "../scan-package/settlement.js";
import {
  buildCiscoShardManifest,
  type CiscoShardManifest,
  ciscoShardJobSubjectV1,
  type JoinedCiscoShardEvidence,
  verifiedCiscoShardJobSarifV1,
} from "./cisco-shards.js";
import type { RawScannerOccurrence } from "./evidence.js";
import { contentFindingFingerprint } from "./fingerprint.js";
import { gradeTrustCheck } from "./grade.js";
import {
  SKILLSPECTOR_IMAGE,
  SKILLSPECTOR_SOURCE_REVISION,
  type SkillSpectorImageApproval,
} from "./images.js";
import { buildTrustFileInventory, type TrustFileInventory } from "./inventory.js";
import {
  ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1,
  acceptedScanAnalyzerIdentityV1,
  declaredScanAnalyzerIdentityRefusalV1,
  executedScanAnalyzerIdentityRefusalV1,
  observedScanAnalyzerVersionV1,
} from "./scan-analyzer-identity.js";
import {
  type CheckedScanSarifLogV1,
  type CheckedScanSarifV1,
  checkedScanSarifLogV1,
  checkedScanSarifTextV1,
  SCAN_COMPLETION_PROPERTY_V1,
  scanCompletionRefusalV1,
} from "./scan-sarif.js";
import {
  SCAN_EMPTY_SOURCE_COMPLETES_V1,
  type ScanSubjectDigestV1,
  scanDetectorSubjectFilesV1,
  scanSubjectDigestV1,
  sealedScanSubjectFilesV1,
} from "./scan-subject-files.js";
import {
  CISCO_MCP_SCANNER_ANALYZER,
  CISCO_SKILL_SCANNER_ANALYZER,
  SEMGREP_ANALYZER,
  SNYK_AGENT_SCAN_ANALYZER,
} from "./scanner-runtime-identity.js";
import {
  DETECTOR_REPORTED_HIDDEN_UNICODE_RISK,
  type TrustLintArtifactFactsV1,
  type TrustLintCheckV1,
  type TrustLintFactsV1,
  trustLintChecksFromSarifV1,
  type UnicodeRiskV1,
} from "./trust-lint-sarif.js";

// Detector names land here only when Scan can at least surface an honest
// availability result. A required-but-unavailable detector fails closed at
// enterprise posture rather than silently passing.
export type TrustDetectorName =
  | "skillspector"
  | "cisco"
  | "mcp-scanner"
  | "semgrep"
  | "snyk-agent-scan";

/** Core's name for Scan's `detector.aih-trust-lint`, which reports the native findings. */
export const SCAN_TRUST_LINT_DETECTOR = "aih-trust-lint";

/** Every detector Core routes to Scan: the five analyzers and the native findings. */
export type ScanRoutedDetectorV1 = TrustDetectorName | typeof SCAN_TRUST_LINT_DETECTOR;

/** The uv-backed profiles a caller may select; the host profile is the default on every OS. */
export type UvExecutionProfileIdV1 = "host-process-uv-v1" | "linux-namespace-uv-v1";

/** Core's classification of one detector's SARIF; execution is always Scan's. */
export interface TrustDetector {
  name: TrustDetectorName;
  analyzerLabel: string;
  ruleMap: Record<string, CheckCode>;
}

export interface TrustDetectorOptions {
  /** Read only for `SNYK_TOKEN` and `AIH_CISCO_SCAN_CONCURRENCY`; never handed to Scan whole. */
  env: NodeJS.ProcessEnv;
  platform: Platform;
  posture: Posture;
  requiredDetectors?: readonly TrustDetectorName[];
  skillspectorImageApprovals?: readonly SkillSpectorImageApproval[];
  inventory: TrustFileInventory;
  /** Restrict execution to this detector set. Omitted means the complete set for the scan kind. */
  detectors?: readonly TrustDetectorName[];
  /**
   * SARIF that replaces execution for the named detector. It counts complete
   * only with completion evidence v1 for this tree (or as a verified Cisco
   * shard join); without evidence it is `completion-evidence-absent`.
   */
  precomputedSarif?: Readonly<Partial<Record<TrustDetectorName, PrecomputedDetectorSarifV1>>>;
  /**
   * Scan's detector execution. Omitted means the INSTALLED `@aihq/scan`, loaded
   * on first need; an injected adapter replaces it (tests and embedders). Every
   * detector runs through it: one it does not declare is unavailable, never run
   * by Core.
   */
  scanExecution?: ScanExecutionAdapterV1;
  /**
   * The profile every uv-backed detector (semgrep, cisco, mcp-scanner,
   * snyk-agent-scan) is requested under. Default `host-process-uv-v1` on every
   * OS; the Linux namespace profile only when policy selects it. No profile
   * falls back.
   */
  uvExecutionProfileId?: UvExecutionProfileIdV1;
  /** Cancels the scan: Scan kills the analyzer's process tree and Core throws `TrustScanCancelledError`. */
  signal?: AbortSignal;
  /** Native AIH findings that can corroborate an elevated third-party rule on the same line. */
  corroboratedChecks?: readonly Check[];
  /** The facts Scan's trust lint stated for this tree; absent when the trust lint did not run. */
  trustLintFacts?: TrustLintFactsV1;
  /** The incoming MCP configs Core declared for this tree, in discovery order. */
  mcpConfigPaths?: readonly string[];
  progress?: (message: string) => void;
}

/**
 * Which package executed one detector for this scan, and under which Scan
 * execution profile when Scan ran it. Nothing about detector execution is silent.
 */
export interface TrustDetectorExecutionV1 {
  readonly detector: ScanRoutedDetectorV1;
  /**
   * `scan`: `@aihq/scan` handled it (installed package or injected adapter).
   * `precomputed-sarif`: coordinator-validated SARIF replaced execution.
   * `none`: nothing executed it, because the Scan package refused.
   */
  readonly executedBy: "scan" | "precomputed-sarif" | "none";
  readonly scanSource?: ScanExecutionSource;
  /** Scan's execution-profile id for a run Scan actually performed. */
  readonly executionProfileId?: string;
  readonly outcome: "completed" | "refused" | "failed" | "unavailable";
  /** The package-level refusal that left the detector unexecuted. */
  readonly refusal?: ScanPackageRefusalReasonV1;
  /** Precomputed SARIF with no completion evidence v1: never counted complete (decision D17). */
  readonly reason?: "completion-evidence-absent";
}

/**
 * An observation `@aihq/scan` recorded for this scan in addition to Core's own
 * detectors, with the facts Scan states about its own run. It carries no
 * findings and never changes a verdict.
 */
export interface ScanObservationV1 {
  readonly detectorId: string;
  readonly scanSource?: ScanExecutionSource;
  readonly outcome: "recorded" | "refused" | "failed" | "unavailable";
  readonly executionProfileId?: string;
  readonly analyzer?: string;
  readonly analyzerVersion?: string;
  /** The observation's annex digest, checked by Core against the bytes Scan returned. */
  readonly annexSha256?: string;
  /** Scan's own `producer` statement, when the installed Scan makes one. */
  readonly producer?: { readonly name: string; readonly version: string | null };
  /** A refusal's or failure's own words, or the package refusal. */
  readonly detail?: string;
  readonly refusal?: ScanPackageRefusalReasonV1;
}

export interface TrustDetectorResult {
  checks: Check[];
  analyzersRun: string[];
  rawOccurrences: RawScannerOccurrence[];
  executions: TrustDetectorExecutionV1[];
  observations: ScanObservationV1[];
}

const DETECTOR_UNAVAILABLE = "trust.detector-unavailable";

export {
  CISCO_MCP_SCANNER_ANALYZER,
  CISCO_SKILL_SCANNER_ANALYZER,
  SEMGREP_ANALYZER,
  SNYK_AGENT_SCAN_ANALYZER,
} from "./scanner-runtime-identity.js";

const SKILLSPECTOR_RULE_MAP: Record<string, CheckCode> = {
  "auto-exec": "trust.auto-exec-hook",
  "dependency-confusion": "trust.dependency-confusion",
  "hidden-unicode": "trust.hidden-unicode",
  "malicious-code": "trust.malicious-code",
  "prompt-injection": "trust.prompt-injection",
  "skillspector.auto-exec": "trust.auto-exec-hook",
  "skillspector.dependency-confusion": "trust.dependency-confusion",
  "skillspector.hidden-unicode": "trust.hidden-unicode",
  "skillspector.malicious-code": "trust.malicious-code",
  "skillspector.prompt-injection": "trust.prompt-injection",
  "skillspector.typosquat": "trust.typosquat",
  typosquat: "trust.typosquat",
};

export const CISCO_RULE_MAP: Record<string, CheckCode> = {
  PROMPT_INJECTION_IGNORE_INSTRUCTIONS: "trust.prompt-injection",
  YARA_command_injection_generic: "trust.malicious-code",
};

export const MCP_SCANNER_RULE_MAP: Record<string, CheckCode> = {
  "mcp.tool-poisoning": "trust.prompt-injection",
  "mcp.tool_poisoning": "trust.prompt-injection",
  "prompt-injection": "trust.prompt-injection",
  prompt_injection: "trust.prompt-injection",
  "tool-poisoning": "trust.prompt-injection",
  tool_poisoning: "trust.prompt-injection",
  PROMPT_INJECTION_IGNORE_INSTRUCTIONS: "trust.prompt-injection",
};

export const SEMGREP_RULE_MAP: Record<string, CheckCode> = {
  "semgrep.malicious-code": "trust.malicious-code",
  "semgrep.prompt-injection": "trust.prompt-injection",
};

export const SNYK_AGENT_SCAN_RULE_MAP: Record<string, CheckCode> = {
  E001: "trust.prompt-injection",
  E004: "trust.prompt-injection",
  E005: "trust.malicious-code",
  E006: "trust.malicious-code",
  W001: "trust.prompt-injection",
  W021: "trust.hidden-unicode",
};

interface SarifArtifactLocation {
  uri?: unknown;
}

interface SarifRegion {
  startLine?: unknown;
}

interface SarifPhysicalLocation {
  artifactLocation?: SarifArtifactLocation;
  region?: SarifRegion;
}

interface SarifLocation {
  physicalLocation?: SarifPhysicalLocation;
}

interface SarifResult {
  ruleId?: unknown;
  rule?: { id?: unknown };
  level?: unknown;
  message?: { text?: unknown };
  locations?: SarifLocation[];
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

/** The source line a finding names: evidence for its fingerprint and `sourceValue`, never detection. */
function fileLine(root: string, uri: string, line: number): string | undefined {
  try {
    const text = readFileSync(join(root, uri), "utf8");
    return text.split(/\r?\n/)[line - 1] ?? "";
  } catch {
    return undefined;
  }
}

// --------------------------------------------------------------------------
// Cisco source-wide shards: Core builds the manifest and joins the results;
// Scan executes each shard (`runCiscoShardV1`, see cisco-shard-delegation.ts).
// --------------------------------------------------------------------------

const DEFAULT_CISCO_SCAN_CONCURRENCY = 4;
const MAX_CISCO_SCAN_CONCURRENCY = 64;

export function resolveCiscoScanConcurrency(env: NodeJS.ProcessEnv): number {
  const raw = env.AIH_CISCO_SCAN_CONCURRENCY?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_CISCO_SCAN_CONCURRENCY;
  if (!/^[1-9][0-9]*$/.test(raw)) return DEFAULT_CISCO_SCAN_CONCURRENCY;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= MAX_CISCO_SCAN_CONCURRENCY
    ? parsed
    : DEFAULT_CISCO_SCAN_CONCURRENCY;
}

export interface CiscoSourceShardManifestOptions {
  source: {
    id: string;
    pinnedSha: string;
  };
  analyzer: {
    version: string;
    lockSha256: string;
  };
  policy: {
    version: string;
    profile: string;
  };
  shardCount: number;
  inventory?: TrustFileInventory;
}

/** Every directory holding a selected `SKILL.md`, sorted by relative path as Core has always sorted it. */
function collectCiscoSkillDirs(root: string, inventory: TrustFileInventory): string[] {
  const dirs = new Set<string>();
  for (const entry of inventory.matching(
    (candidate) => basename(candidate.absolutePath) === "SKILL.md",
  )) {
    dirs.add(dirname(entry.absolutePath));
  }
  return [...dirs].sort((a, b) =>
    toPosix(relative(root, a)).localeCompare(toPosix(relative(root, b))),
  );
}

export function buildCiscoSourceShardManifest(
  root: string,
  options: CiscoSourceShardManifestOptions,
): CiscoShardManifest {
  const safeRoot = realpathSync(root);
  const paths = collectCiscoSkillDirs(
    safeRoot,
    options.inventory ?? buildTrustFileInventory(safeRoot),
  ).map((skillDir) => toPosix(relative(safeRoot, skillDir)));
  if (paths.length === 0) throw new Error("no SKILL.md directories found for Cisco scan");
  const sourceTree = hashComponentTree(safeRoot, paths);
  return buildCiscoShardManifest({
    source: {
      ...options.source,
      treeSha256: sourceTree.treeSha256,
    },
    analyzer: {
      name: "cisco",
      ...options.analyzer,
    },
    policy: options.policy,
    jobs: paths.map((path) => ({
      path,
      inputSha256: hashComponentTree(safeRoot, [path]).treeSha256,
    })),
    shardCount: options.shardCount,
  });
}

function sourcePathsIntersect(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Cisco SARIF joined from shard jobs whose completion evidence Core checked,
 * job by job, against each job's own subject (`joinCiscoShardResults`). Its
 * runs name different subjects, so it is exempt from the one-subject check
 * precomputed SARIF otherwise meets, and only a value `joinedCiscoShardSarif`
 * issued is: a look-alike is refused. The exemption holds only for the tree
 * the value was issued for: its root, its exact job set, and each job's
 * subject as verified at the join (`issuedShardJoinRefusalV1`).
 */
export interface VerifiedCiscoShardSarifV1 {
  readonly kind: "verified-cisco-shard-join-v1";
  readonly sarif: string;
}

/** Precomputed SARIF: a Scanner annex's bytes, or a Cisco shard join Core verified. */
export type PrecomputedDetectorSarifV1 = string | VerifiedCiscoShardSarifV1;

/** What an issued join is bound to: the canonical root it is presented for, and each job's verified subject. */
interface IssuedShardJoinBindingV1 {
  readonly root: string;
  readonly jobs: readonly { readonly path: string; readonly subject: ScanSubjectDigestV1 }[];
}

const ISSUED_SHARD_JOINS = new WeakMap<VerifiedCiscoShardSarifV1, IssuedShardJoinBindingV1>();

/**
 * Issues the verified join's SARIF, optionally only for the jobs that meet
 * `includedPaths`. It is bound to `scanRoot` (by default the root the join was
 * verified against): a projection of the source presents it at its own root,
 * which must hold exactly those jobs with the files the join verified.
 */
export function joinedCiscoShardSarif(
  joined: JoinedCiscoShardEvidence,
  includedPaths?: readonly string[],
  scanRoot?: string,
): VerifiedCiscoShardSarifV1 {
  const verified = verifiedCiscoShardJobSarifV1(joined);
  if (verified === undefined)
    throw new Error("Cisco shard evidence was not joined by joinCiscoShardResults");
  const runs: CheckedScanSarifLogV1["runs"][number][] = [];
  const bound: IssuedShardJoinBindingV1["jobs"][number][] = [];
  for (const job of verified.jobs) {
    if (
      includedPaths !== undefined &&
      !includedPaths.some((path) => sourcePathsIntersect(job.path, path))
    ) {
      continue;
    }
    const checked = checkedScanSarifLogV1(JSON.parse(job.sarif));
    if ("refusal" in checked) {
      throw new Error(
        `Cisco shard job ${job.path} did not retain valid SARIF evidence: it holds ${checked.refusal}`,
      );
    }
    runs.push(...checked.log.runs);
    bound.push(Object.freeze({ path: job.path, subject: Object.freeze({ ...job.subject }) }));
  }
  const issued: VerifiedCiscoShardSarifV1 = Object.freeze({
    kind: "verified-cisco-shard-join-v1",
    sarif: JSON.stringify({ version: "2.1.0", runs }),
  });
  ISSUED_SHARD_JOINS.set(
    issued,
    Object.freeze({
      root: scanRoot === undefined ? verified.root : realpathSync.native(scanRoot),
      jobs: Object.freeze(bound),
    }),
  );
  return issued;
}

/**
 * Why an issued shard join does not describe the tree being scanned now, or
 * undefined when it does: the scanned root must be the one it is bound to,
 * the jobs Core derives from that tree (every directory holding a selected
 * `SKILL.md`) must be exactly its jobs, and each job's subject, rehashed now,
 * must equal the subject verified at the join.
 */
function issuedShardJoinRefusalV1(
  binding: IssuedShardJoinBindingV1,
  root: string,
  inventory: TrustFileInventory,
): string | undefined {
  let scanned: string;
  try {
    scanned = realpathSync.native(root);
  } catch (error) {
    return `the root being scanned cannot be resolved: ${(error as Error)?.message ?? "unknown error"}`;
  }
  if (scanned !== binding.root)
    return `the shard join Core verified is bound to source root ${binding.root}, not the root being scanned, ${scanned}`;
  const bound = binding.jobs.map((job) => job.path).sort();
  const derived = [
    ...new Set(
      inventory.files
        .map((entry) => entry.relativePath)
        .filter((path) => posix.basename(path) === "SKILL.md")
        .map((path) => posix.dirname(path)),
    ),
  ].sort();
  const added = derived.filter((path) => !bound.includes(path));
  const removed = bound.filter((path) => !derived.includes(path));
  if (added.length > 0 || removed.length > 0)
    return `the shard join Core verified covers jobs ${bound.join(", ")}, and the tree being scanned has jobs ${derived.join(", ") || "none"} (added: ${added.join(", ") || "none"}; removed: ${removed.join(", ") || "none"})`;
  for (const job of binding.jobs) {
    let now: ScanSubjectDigestV1;
    try {
      now = ciscoShardJobSubjectV1(scanned, job.path);
    } catch (error) {
      return `the tree changed after Core verified the shard join: job ${job.path} cannot be rehashed: ${(error as Error)?.message ?? "unknown error"}`;
    }
    if (
      now.subjectTreeSha256 !== job.subject.subjectTreeSha256 ||
      now.analyzedFileCount !== job.subject.analyzedFileCount
    )
      return `the tree changed after Core verified the shard join: job ${job.path} was verified with ${job.subject.analyzedFileCount} files and subject tree ${job.subject.subjectTreeSha256}, and now has ${now.analyzedFileCount} files with subject tree ${now.subjectTreeSha256}`;
  }
  return undefined;
}

// --------------------------------------------------------------------------
// SARIF -> Core check classification (Core's policy; the facts come from Scan)
// --------------------------------------------------------------------------

function unavailableDetail(detector: TrustDetectorName, reason: string): string {
  const runbook =
    detector === "skillspector"
      ? " Load the pinned SkillSpector image locally as @aihq/scan documents; Core never pulls it."
      : "";
  return `DEGRADED-COVERAGE: deep scan SKIPPED — ${detector} not available (${reason}); coverage is GREEN-tier only. Analyzers run: aih-native.${runbook}`;
}

function unavailableCheck(
  detector: TrustDetectorName,
  reason: string,
  posture: Posture,
  required: boolean,
): Check {
  const base: Check = {
    name: `trust detector ${detector}`,
    verdict: "skip",
    code: DETECTOR_UNAVAILABLE,
    detail: unavailableDetail(detector, reason),
  };
  if (!required || posture !== "enterprise") return base;
  return {
    ...base,
    verdict: "fail",
    detail: `required detector ${detector} is unavailable at enterprise posture. ${base.detail}`,
  };
}

function resultRuleId(result: SarifResult): string | undefined {
  const raw = typeof result.ruleId === "string" ? result.ruleId : result.rule?.id;
  return typeof raw === "string" ? raw : undefined;
}

const NO_TRUST_LINT_FACTS: TrustLintFactsV1 = Object.freeze({
  trustDocumentCount: 0,
  repositoryLicenseFile: null,
  artifacts: new Map(),
});

/** The facts Scan stated for a readable sealed file, or undefined (absent, a directory, or unreadable). */
function readableFacts(
  facts: TrustLintFactsV1,
  location: NonNullable<Check["location"]>,
): Exclude<TrustLintArtifactFactsV1, { unreadable: true }> | undefined {
  const entry = facts.artifacts.get(location.uri);
  return entry === undefined || entry.unreadable ? undefined : entry;
}

function unicodeRiskForLocation(
  facts: TrustLintFactsV1,
  location: NonNullable<Check["location"]>,
): UnicodeRiskV1 | undefined {
  const file = readableFacts(facts, location);
  return file === undefined
    ? DETECTOR_REPORTED_HIDDEN_UNICODE_RISK
    : (file.unicodeRisk ?? undefined);
}

function isReviewableVisibleUnicodeDetectorResult(
  result: SarifResult,
  detector: TrustDetector,
): boolean {
  if (detector.name !== "skillspector") return false;
  const message = resultMessage(result, detector).toLowerCase();
  return (
    /\bvisible\b.*\bunicode\b/.test(message) ||
    /\bunicode\b.*\bvisible\b/.test(message) ||
    /\bnon-ascii\b/.test(message) ||
    /\bunicode\b.*\bcount\b/.test(message)
  );
}

function hiddenUnicodeRiskForDetectorResult(
  result: SarifResult,
  detector: TrustDetector,
  facts: TrustLintFactsV1,
  location: NonNullable<Check["location"]>,
): UnicodeRiskV1 | undefined {
  if (!isReviewableVisibleUnicodeDetectorResult(result, detector)) {
    return DETECTOR_REPORTED_HIDDEN_UNICODE_RISK;
  }
  return unicodeRiskForLocation(facts, location);
}

type DetectorRuleClassification =
  | { code: CheckCode; advisory?: never }
  | { advisory: string; code?: never };

const SKILLSPECTOR_SC4_OFFLINE_FALLBACK =
  /^🟡 SC4: OSV\.dev unreachable, using static fallback \([1-9][0-9]* packages\)\. Results may be incomplete\. Set SKILLSPECTOR_OSV_TIMEOUT to increase timeout or check network connectivity to api\.osv\.dev\.$/;
const SKILLSPECTOR_YR4_METADATA_MESSAGE =
  "YARA rule 'agent_skill_mcp_tool_poisoning_metadata': MCP/tool metadata poisoning indicators in tool schemas or skill manifests [agent_skills]";
// The Cisco skill-scanner's metadata-hygiene "missing license field" finding.
// Its rule id (MANIFEST_MISSING_LICENSE, emitted by cisco-ai-skill-scanner
// ==2.0.12) is not in CISCO_RULE_MAP, so it otherwise falls through to the
// block-at-every-posture trust.cisco-finding bucket. It is an evidence/metadata
// gap (mirrors the native trust.license-missing UNKNOWN posture), not poisoning,
// so it is reclassified to a graded, acknowledgeable trust-origin finding. The
// reclass is gated on that SPECIFIC benign rule id (never a danger-mapped one),
// the skill-scanner, the manifest surface (SKILL.md), and the specific wording
// pinned to that scanner version; re-verify the rule id and wording on a scanner
// pin bump. Scope is deliberately narrow: only this metadata-hygiene finding
// reclassifies — every other Cisco finding stays as mapped or cisco-finding.
const CISCO_MISSING_LICENSE_RULE_ID = "MANIFEST_MISSING_LICENSE";
const CISCO_MISSING_LICENSE_MESSAGE =
  /\bskill manifest does not include a ['"‘’]?license['"‘’]?\s+field\b/i;

// SkillSpector YR4 (`agent_skill_mcp_tool_poisoning_metadata`) fires on
// ubiquitous manifest keys plus at least one Gate-B poisoning co-signal. It is
// downgraded to an advisory only when Scan's trust lint states that the SOLE
// surviving co-signal in this `package.json` is the pinned Corepack
// `packageManager` integrity blob (`yr4CorepackIntegrityOnly`, C2a §2.6). Core
// keeps the gate on the rule id, the exact message and the file name.
function skillspectorAdvisory(
  result: SarifResult,
  detector: TrustDetector,
  facts: TrustLintFactsV1,
  location: NonNullable<Check["location"]>,
): string | undefined {
  if (detector.name !== "skillspector") return undefined;
  const ruleId = resultRuleId(result);
  const message = resultMessage(result, detector);
  if (
    ruleId === "SC4" &&
    result.level === "note" &&
    SKILLSPECTOR_SC4_OFFLINE_FALLBACK.test(message)
  ) {
    return `${message} This is the expected dependency-coverage mode for the locked no-egress baseline scan; static fallback coverage remains incomplete.`;
  }
  if (
    ruleId !== "YR4" ||
    message !== SKILLSPECTOR_YR4_METADATA_MESSAGE ||
    basename(location.uri) !== "package.json"
  ) {
    return undefined;
  }
  if (readableFacts(facts, location)?.yr4CorepackIntegrityOnly !== true) return undefined;
  return `${message}; reviewed false positive: the only poisoning co-signal is the top-level Corepack packageManager integrity suffix, which remains pinned.`;
}

// The Cisco skill-scanner's "missing license field" metadata-hygiene finding is
// reclassified out of the generic cisco-finding block into an acknowledgeable
// trust-origin finding. It is gated on the SPECIFIC benign SARIF rule id the
// scanner emits for it (MANIFEST_MISSING_LICENSE) and NEVER reclassifies a rule
// id that maps to a danger code — so a danger finding whose echoed message text
// merely quotes the license phrase can never be relabelled. Only the Cisco
// skill-scanner, only that rule id, only the manifest surface (SKILL.md), only
// that exact wording — never the mcp-scanner or any other Cisco finding.
function ciscoMetadataLicenseClassification(
  result: SarifResult,
  detector: TrustDetector,
  facts: TrustLintFactsV1,
  location: NonNullable<Check["location"]>,
): DetectorRuleClassification | undefined {
  if (detector.name !== "cisco") return undefined;
  const ruleId = resultRuleId(result);
  if (ruleId !== CISCO_MISSING_LICENSE_RULE_ID) return undefined;
  // A danger-mapped rule id is never eligible for the benign reclass, even if it
  // somehow shared the benign rule id string.
  if (detector.ruleMap[ruleId] !== undefined) return undefined;
  if (basename(location.uri) !== "SKILL.md") return undefined;
  if (!CISCO_MISSING_LICENSE_MESSAGE.test(resultMessage(result, detector))) return undefined;
  const inherited = facts.repositoryLicenseFile;
  return inherited === null
    ? { code: "trust.skill-metadata-license" }
    : {
        advisory: `${resultMessage(result, detector)}; repository-level license inheritance resolved by ${inherited}`,
      };
}

function ruleCode(
  result: SarifResult,
  detector: TrustDetector,
  facts: TrustLintFactsV1,
  location: NonNullable<Check["location"]>,
  corroboratedDangerLocations: ReadonlySet<string>,
): DetectorRuleClassification | undefined {
  const raw = resultRuleId(result);
  if (raw === undefined) return undefined;
  const advisory = skillspectorAdvisory(result, detector, facts, location);
  if (advisory !== undefined) return { advisory };
  // A rule id mapped by the detector always wins over any message-text
  // reclassification below: a danger-mapped finding (e.g.
  // PROMPT_INJECTION_IGNORE_INSTRUCTIONS -> trust.prompt-injection,
  // YARA_command_injection_generic -> trust.malicious-code) must never be
  // relabelled to an acknowledgeable trust-origin code by a substring match on
  // echoed message content.
  // Own properties only: a rule id such as "constructor" names no mapped rule.
  const mapped = Object.hasOwn(detector.ruleMap, raw) ? detector.ruleMap[raw] : undefined;
  if (mapped !== undefined) {
    if (mapped === "trust.hidden-unicode") {
      const risk = hiddenUnicodeRiskForDetectorResult(result, detector, facts, location);
      return risk === undefined ? undefined : { code: risk.code };
    }
    if (mapped === "trust.prompt-injection") {
      // Corroborated by Scan's whole-file lint of the same line, never by Core reading the file.
      const file = readableFacts(facts, location);
      if (file === undefined) return { code: "trust.detector-finding" };
      const codes = file.lintLines.get(location.startLine ?? 1) ?? [];
      if (codes.includes("trust.prompt-injection")) return { code: "trust.prompt-injection" };
      if (codes.includes("trust.external-egress")) return { code: "trust.external-egress" };
      return { code: "trust.detector-finding" };
    }
    if (
      mapped === "trust.malicious-code" &&
      !corroboratedDangerLocations.has(
        `trust.malicious-code:${location.uri}:${String(location.startLine ?? 1)}`,
      )
    ) {
      return { code: "trust.detector-finding" };
    }
    if (
      mapped === "trust.auto-exec-hook" &&
      !corroboratedDangerLocations.has(
        `trust.auto-exec-hook:${location.uri}:${String(location.startLine ?? 1)}`,
      )
    ) {
      return { code: "trust.detector-finding" };
    }
    return {
      code: mapped,
    };
  }
  // Only an UNMAPPED Cisco rule id reaches the benign missing-license reclass.
  const metadataLicense = ciscoMetadataLicenseClassification(result, detector, facts, location);
  if (metadataLicense !== undefined) return metadataLicense;
  const legalText = readableFacts(facts, location)?.legalText === true;
  if (
    detector.name === "skillspector" ||
    detector.name === "semgrep" ||
    detector.name === "snyk-agent-scan"
  ) {
    if (
      detector.name === "skillspector" &&
      /\bExternal Transmission\b/i.test(resultMessage(result, detector))
    ) {
      return { code: "trust.external-egress" };
    }
    return legalText
      ? { code: "trust.legal-text-detector-finding" }
      : { code: "trust.detector-finding" };
  }
  if (detector.name === "cisco" || detector.name === "mcp-scanner") {
    return legalText
      ? { code: "trust.legal-text-detector-finding" }
      : { code: "trust.cisco-finding" };
  }
  return undefined;
}

function detectorFindingLabel(detector: TrustDetector): string {
  if (detector.name === "skillspector") return "SkillSpector";
  if (detector.name === "mcp-scanner") return "Cisco AI Defense mcp-scanner";
  if (detector.name === "semgrep") return "Semgrep";
  if (detector.name === "snyk-agent-scan") return "Snyk Agent Scan";
  return "Cisco AI Defense skill-scanner";
}

function resultMessage(result: SarifResult, detector: TrustDetector): string {
  return typeof result.message?.text === "string" && result.message.text.length > 0
    ? result.message.text
    : `${detectorFindingLabel(detector)} SARIF finding`;
}

const ROLE_ASSIGNMENT =
  /\b(?:act|behave|serve|work)\s+as\b|\byou\s+are\s+(?:an?|the)\b|\brole\s+(?:assignment|definition)\b/i;
const DANGEROUS_ROLE_CONTEXT =
  /\b(?:ignore|disregard|override|jailbreak|previous|prior|system\s+prompt|developer\s+instruction|api[_ -]?key|credential|password|secret|token|upload|send|post|leak|steal|exfiltrat\w*)\b|https?:\/\//i;

function isNarrowReviewableRoleDefinition(
  result: SarifResult,
  detector: TrustDetector,
  root: string,
  facts: TrustLintFactsV1,
  location: NonNullable<Check["location"]>,
): boolean {
  // A strict surface (instructions, config, executables) is never a reviewable role definition.
  if (readableFacts(facts, location)?.strictUnicodeSurface !== false) return false;
  const line = fileLine(root, location.uri, location.startLine ?? 1) ?? "";
  const evidence = [resultRuleId(result) ?? "", resultMessage(result, detector), line].join("\n");
  return ROLE_ASSIGNMENT.test(evidence) && !DANGEROUS_ROLE_CONTEXT.test(evidence);
}

function unicodeResultMessage(message: string, risk: UnicodeRiskV1 | undefined): string {
  if (risk === undefined) return message;
  return `${message}; character category: ${risk.category}; reason: ${risk.reason}`;
}

function legalTextResultMessage(message: string, code: CheckCode): string {
  if (code !== "trust.legal-text-detector-finding") return message;
  return `${message}; file class: non-executable legal text; severity: reviewable trust-origin because generic detector heuristics on LICENSE/COPYING/NOTICE require human review`;
}

/**
 * A finding's URI was checked at the boundary (`checkedScanSarifLogV1`): a
 * source-relative path or ".", kept exactly as Scan wrote it. A result with no
 * URI is located at the detector's SARIF.
 */
function sarifUri(raw: unknown, detector: TrustDetector): string {
  return typeof raw === "string" && raw.length > 0 ? raw : `${detector.name}.sarif`;
}

function sarifStartLine(result: SarifResult): number {
  const raw = result.locations?.[0]?.physicalLocation?.region?.startLine;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 1;
}

function sarifLocation(
  result: SarifResult,
  detector: TrustDetector,
): NonNullable<Check["location"]> {
  const physical = result.locations?.[0]?.physicalLocation;
  return {
    uri: sarifUri(physical?.artifactLocation?.uri, detector),
    startLine: sarifStartLine(result),
  };
}

function sarifFingerprint(
  occurrences: Map<string, number>,
  code: CheckCode,
  root: string,
  location: NonNullable<Check["location"]>,
  ruleId: string,
  detail: string,
  detector: TrustDetector,
): string {
  const line = location.startLine ?? 1;
  const findingRule = `${detector.name}:${ruleId}`;
  const lineContent = fileLine(root, location.uri, line) ?? detail;
  const content = `${lineContent}\0${detail}`;
  const key = JSON.stringify([code, location.uri, findingRule, content]);
  const occurrence = occurrences.get(key) ?? 0;
  occurrences.set(key, occurrence + 1);
  return contentFindingFingerprint({
    code,
    path: location.uri,
    ruleId: findingRule,
    content,
    occurrence,
    displayLine: line,
  });
}

function isSealedRegularFile(root: string, uri: string): boolean {
  try {
    return lstatSync(join(root, uri)).isFile();
  } catch {
    return false;
  }
}

/**
 * Scan's trust lint states facts for every regular file in the sealed tree, skip
 * directories included (C2a §2.6). A finding on such a file without facts is
 * Scan's omission, never absent corroboration: the detector's SARIF cannot be
 * classified, so it fails closed. A directory, the source root and the
 * detector's own SARIF name no file and carry no facts.
 */
function unstatedFactsRefusal(
  log: CheckedScanSarifLogV1,
  detector: TrustDetector,
  root: string,
  facts: TrustLintFactsV1,
): string | undefined {
  for (const run of log.runs) {
    for (const result of run.results) {
      const { uri } = sarifLocation(result as SarifResult, detector);
      if (facts.artifacts.has(uri) || !isSealedRegularFile(root, uri)) continue;
      return `${SCAN_DETECTOR_IDS[detector.name]} reported ${adapterReason(uri)}, a sealed file ${SCAN_DETECTOR_IDS[SCAN_TRUST_LINT_DETECTOR]} stated no facts for`;
    }
  }
  return undefined;
}

/**
 * `canonicalRuleId`, when given, names the rule Core classifies and fingerprints a
 * result under; the raw occurrence keeps the analyzer's own rule id as evidence.
 */
function sarifChecks(
  log: CheckedScanSarifLogV1,
  root: string,
  posture: Posture,
  detector: TrustDetector,
  corroboratedDangerLocations: ReadonlySet<string>,
  facts: TrustLintFactsV1,
  canonicalRuleId?: (raw: string) => string | undefined,
): { checks: Check[]; rawOccurrences: RawScannerOccurrence[] } {
  const checks: Check[] = [];
  const rawOccurrences: RawScannerOccurrence[] = [];
  const occurrences = new Map<string, number>();
  const rawOccurrenceCounts = new Map<string, number>();
  const seen = new Set<string>();
  for (const run of log.runs) {
    for (const checked of run.results) {
      const result = checked as SarifResult;
      const location = sarifLocation(result, detector);
      const rawRuleId = resultRuleId(result) ?? "unknown-rule";
      const rawMessage = resultMessage(result, detector);
      const rawKey = JSON.stringify([
        detector.name,
        rawRuleId,
        location.uri,
        location.startLine ?? 1,
        rawMessage,
      ]);
      const rawOccurrence = rawOccurrenceCounts.get(rawKey) ?? 0;
      rawOccurrenceCounts.set(rawKey, rawOccurrence + 1);
      const sourceValue = fileLine(root, location.uri, location.startLine ?? 1);
      rawOccurrences.push({
        fingerprint: `trust-raw:${createHash("sha256")
          .update(JSON.stringify([rawKey, rawOccurrence]), "utf8")
          .digest("hex")}`,
        analyzer: detector.analyzerLabel,
        ruleId: rawRuleId,
        message: rawMessage,
        ...(typeof result.level === "string" ? { level: result.level } : {}),
        location,
        ...(sourceValue === undefined ? {} : { sourceValue }),
      });
      const duplicateKey = JSON.stringify([
        detector.name,
        rawRuleId,
        location.uri,
        location.startLine ?? 1,
      ]);
      if (seen.has(duplicateKey)) continue;
      seen.add(duplicateKey);
      const canonical =
        canonicalRuleId === undefined || resultRuleId(result) === undefined
          ? undefined
          : canonicalRuleId(rawRuleId);
      const classified: SarifResult =
        canonical === undefined ? result : { ...result, ruleId: canonical };
      const classification = ruleCode(
        classified,
        detector,
        facts,
        location,
        corroboratedDangerLocations,
      );
      if (classification === undefined) continue;
      if (classification.advisory !== undefined) {
        checks.push({
          name: `trust detector ${detector.name} advisory`,
          verdict: "pass",
          detail: `${location.uri}:${location.startLine ?? 1} — ${detectorFindingLabel(detector)}: ${classification.advisory}`,
          location,
        });
        continue;
      }
      const { code } = classification;
      if (
        code === "trust.prompt-injection" &&
        isNarrowReviewableRoleDefinition(classified, detector, root, facts, location)
      ) {
        continue;
      }
      const risk =
        code === "trust.hidden-unicode" || code === "trust.visible-unicode"
          ? hiddenUnicodeRiskForDetectorResult(classified, detector, facts, location)
          : undefined;
      const detail = legalTextResultMessage(
        unicodeResultMessage(resultMessage(classified, detector), risk),
        code,
      );
      checks.push(
        gradeTrustCheck(
          {
            name: code,
            verdict: "fail",
            code,
            detail: `${location.uri}:${location.startLine ?? 1} — ${detectorFindingLabel(detector)}: ${detail}`,
            location,
            fingerprint: sarifFingerprint(
              occurrences,
              code,
              root,
              location,
              resultRuleId(classified) ?? "unknown-rule",
              detail,
              detector,
            ),
          },
          posture,
        ),
      );
    }
  }
  return { checks, rawOccurrences };
}

function analyzerPassCheck(
  detector: TrustDetector,
  analyzersRun: readonly string[],
  delegated?: { readonly source: ScanExecutionSource; readonly executionProfileId?: string },
): Check {
  // Never describe a mechanism Core did not use: Scan executed the run (or its
  // SARIF was precomputed), and only Scan's own result states the profile.
  const through =
    delegated === undefined
      ? "precomputed SARIF"
      : delegated.source === "installed-package"
        ? `the installed @aihq/scan${
            delegated.executionProfileId === undefined
              ? ""
              : ` under execution profile ${delegated.executionProfileId}`
          }`
        : "the injected scan execution adapter";
  return {
    name: `trust detector ${detector.name}`,
    verdict: "pass",
    detail: `${detector.analyzerLabel} static scan completed through ${through}; Core did not execute it. No findings != safe. Analyzers run: ${analyzersRun.join(", ")}`,
  };
}

function isRequired(
  detector: TrustDetectorName,
  requiredDetectors: readonly TrustDetectorName[],
): boolean {
  return requiredDetectors.includes(detector);
}

// --------------------------------------------------------------------------
// Delegated execution: the installed @aihq/scan, or an injected adapter
// --------------------------------------------------------------------------

/**
 * Scan's in-process identity observation. It is NOT the native findings (Scan's
 * `detector.aih-trust-lint` reports those): it records a tree hash and file
 * list. Core invokes it through the installed package as an additional recorded
 * observation, never as a finding source.
 */
export const SCAN_NATIVE_OBSERVATION_DETECTOR_ID = "detector.aih-native";

/** Scan's detector id for each detector Core routes to it. */
export const SCAN_DETECTOR_IDS: Readonly<Record<ScanRoutedDetectorV1, string>> = Object.freeze({
  [SCAN_TRUST_LINT_DETECTOR]: "detector.aih-trust-lint",
  skillspector: "detector.skillspector",
  cisco: "detector.cisco",
  "mcp-scanner": "detector.cisco-mcp-scanner",
  semgrep: "detector.semgrep",
  "snyk-agent-scan": "detector.snyk-agent-scan",
});

/** Detectors Scan runs through uv; each is requested under one named uv profile. */
const UV_BACKED_DETECTORS: ReadonlySet<ScanRoutedDetectorV1> = new Set([
  "semgrep",
  "cisco",
  "mcp-scanner",
  "snyk-agent-scan",
]);

export const DEFAULT_UV_EXECUTION_PROFILE: UvExecutionProfileIdV1 = "host-process-uv-v1";
/** The native findings: Scan's in-process trust lint, on every platform. */
export const TRUST_LINT_EXECUTION_PROFILE = "in-process-trust-lint-v1";
/** SkillSpector: the locally loaded pinned image under host Docker; it never pulls. */
export const SKILLSPECTOR_EXECUTION_PROFILE = "docker-host-local-skillspector-v1";

/**
 * A trust scan the caller cancelled. Scan kills the analyzer's process tree and
 * returns a failure; Core then stops, because a cancelled scan has no verdict.
 */
export class TrustScanCancelledError extends AihError {
  constructor(detail: string) {
    super(`trust scan cancelled: ${detail}`, "AIH_TRUST_CANCELLED");
  }
}

function throwIfCancelled(signal: AbortSignal | undefined, detail: string): void {
  if (signal?.aborted === true) throw new TrustScanCancelledError(detail);
}

/** How Core reached Scan's execution for this scan. */
export type ScanExecutionSource = "installed-package" | "injected-adapter";

export type ResolvedScanExecutionV1 =
  | { readonly adapter: ScanExecutionAdapterV1; readonly source: ScanExecutionSource }
  | { readonly refusal: ScanPackageRefusalV1 };

/** Scan's execution for a scan: the injected adapter, else the installed package or its refusal. */
export function resolveScanExecutionV1(
  injected?: ScanExecutionAdapterV1,
): Promise<ResolvedScanExecutionV1> {
  return injected !== undefined
    ? Promise.resolve({ adapter: injected, source: "injected-adapter" })
    : loadScanExecutionAdapterV1().then((loaded) =>
        loaded.ok
          ? { adapter: loaded.adapter, source: "installed-package" }
          : { refusal: loaded.refusal },
      );
}

export type DelegatedDetectorResultV1 =
  | { readonly sarif: string; readonly executionProfileId?: string }
  | {
      readonly unavailable: string;
      readonly outcome: "refused" | "failed";
      readonly executionProfileId?: string;
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Adapter text reaches a report, so bound it and keep control characters out. */
function adapterReason(value: string): string {
  const visible = value.replace(/[\p{C}]/gu, " ").trim();
  return visible.length > 300 ? `${visible.slice(0, 297)}...` : visible;
}

/** The SARIF media type Scan's analyzer observation declares for SARIF bytes. */
const DELEGATED_SARIF_MEDIA_TYPE = "application/sarif+json";

function stringMember(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * The capability the adapter publishes for this detector, or undefined when it
 * publishes none. Scan names its capabilities by `SCAN_DETECTOR_IDS`. A
 * capability list Core cannot read names nothing.
 */
function adapterCapabilityFor(
  adapter: ScanExecutionAdapterV1,
  detector: ScanRoutedDetectorV1 | typeof SCAN_NATIVE_OBSERVATION_DETECTOR_ID,
): Record<string, unknown> | undefined {
  const scanId =
    detector === SCAN_NATIVE_OBSERVATION_DETECTOR_ID ? detector : SCAN_DETECTOR_IDS[detector];
  let capabilities: readonly unknown[];
  try {
    capabilities = adapter.listDetectorCapabilitiesV1();
  } catch {
    return undefined;
  }
  if (!Array.isArray(capabilities)) return undefined;
  for (const capability of capabilities) {
    const record = asRecord(capability);
    if (record?.detectorId === scanId) return record;
  }
  return undefined;
}

/** Scan's platform name for this host (`amd64` for Node's `x64`). */
function scanArchitecture(): string {
  return process.arch === "x64" ? "amd64" : process.arch;
}

/**
 * The execution profile Core names for this detector, checked against what the
 * capability declares for this host before anything is asked of Scan.
 *
 * uv-backed detectors run under `host-process-uv-v1` on every OS unless policy
 * selects `linux-namespace-uv-v1`; the native findings under
 * `in-process-trust-lint-v1`; SkillSpector under the never-pull local Docker
 * profile, and only in a container. A profile the capability does not declare
 * for this OS and architecture is refused: nothing falls back to another profile.
 */
export function requestedExecutionProfileV1(
  detector: ScanRoutedDetectorV1,
  capability: Record<string, unknown> | undefined,
  platform: Platform,
  uvProfile: UvExecutionProfileIdV1 | undefined,
):
  | { readonly id: string; readonly profile: Record<string, unknown> }
  | { readonly refusal: string } {
  const scanId = SCAN_DETECTOR_IDS[detector];
  const architecture = scanArchitecture();
  const id = UV_BACKED_DETECTORS.has(detector)
    ? (uvProfile ?? DEFAULT_UV_EXECUTION_PROFILE)
    : detector === SCAN_TRUST_LINT_DETECTOR
      ? TRUST_LINT_EXECUTION_PROFILE
      : SKILLSPECTOR_EXECUTION_PROFILE;
  const profiles = capability?.executionProfiles;
  const profile = Array.isArray(profiles)
    ? profiles.map(asRecord).find((entry) => entry?.id === id)
    : undefined;
  const declared =
    profile !== undefined &&
    Array.isArray(profile.supportedPlatforms) &&
    profile.supportedPlatforms.some((host) => {
      const supported = asRecord(host);
      return supported?.os === platform && supported.architecture === architecture;
    });
  if (!declared || profile === undefined)
    return {
      refusal: `${scanId} does not declare ${id} for ${platform}/${architecture}`,
    };
  if (detector === "skillspector" && profile.isolation !== "container")
    return {
      refusal: `${scanId} profile ${id} is not a container profile; Core runs SkillSpector only in a container`,
    };
  return { id, profile };
}

/**
 * The digests Core's approval POLICY accepts for the local SkillSpector image:
 * the organization's approvals recorded for exactly the pinned tag and source
 * revision, deduplicated in policy order. Scan applies the identity rule.
 */
export function acceptedSkillspectorImageDigestsV1(
  approvals: readonly SkillSpectorImageApproval[],
): string[] {
  const digests: string[] = [];
  for (const approval of approvals) {
    if (
      approval.imageTag === SKILLSPECTOR_IMAGE &&
      approval.sourceRevision === SKILLSPECTOR_SOURCE_REVISION &&
      !digests.includes(approval.imageDigest)
    )
      digests.push(approval.imageDigest);
  }
  return digests;
}

/** `SNYK_TOKEN`, trimmed, only when set and non-blank; it goes to snyk-agent-scan alone. */
function snykTokenEnv(env: NodeJS.ProcessEnv): { readonly SNYK_TOKEN: string } | undefined {
  const token = env.SNYK_TOKEN?.trim();
  return token === undefined || token.length === 0 ? undefined : { SNYK_TOKEN: token };
}

/**
 * Core narrows the adapter's `unknown` result here and nowhere else, against
 * Scan's own `RunDetectorV1Result`. A refusal, a failure, a throw, an evidence
 * shape Core's SARIF normalization cannot read and an unrecognized result are
 * all the same verdict — the detector did not run — and each carries its own
 * reason into the existing degraded-coverage path. None of them is ever a pass.
 * The profile a run used is Scan's own statement, taken only from a run Scan
 * says it performed (a success or a failure), never from a refusal.
 */
export function delegatedDetectorResult(result: unknown): DelegatedDetectorResultV1 {
  const record = asRecord(result);
  const narrowed = narrowedDelegatedResult(record);
  const profileId =
    record?.outcome === "succeeded" || record?.outcome === "failed"
      ? stringMember(asRecord(record.executionProfile), "id")
      : undefined;
  const executionProfileId = profileId === undefined ? undefined : adapterReason(profileId);
  const profile = executionProfileId === undefined ? {} : { executionProfileId };
  if ("sarif" in narrowed) return { sarif: narrowed.sarif, ...profile };
  return {
    unavailable: narrowed.unavailable,
    outcome: record?.outcome === "refused" ? "refused" : "failed",
    ...profile,
  };
}

function narrowedDelegatedResult(
  record: Record<string, unknown> | undefined,
): { readonly sarif: string } | { readonly unavailable: string } {
  if (record === undefined) return { unavailable: "scan execution adapter returned no result" };
  if (record.outcome === "refused") {
    const reason = stringMember(record, "reason");
    const detail = stringMember(record, "detail");
    const text =
      detail === undefined ? reason : reason === undefined ? detail : `${reason}: ${detail}`;
    return {
      unavailable: adapterReason(text ?? "scan execution adapter refused without a reason"),
    };
  }
  if (record.outcome === "failed") {
    const failure = asRecord(record.failure);
    const stage = stringMember(failure, "stage");
    const detail = stringMember(failure, "detail");
    const cause = stringMember(failure, "cause");
    const text =
      detail === undefined ? stage : stage === undefined ? detail : `${stage}: ${detail}`;
    const said = text ?? "scan execution adapter failed without a reason";
    return { unavailable: adapterReason(cause === undefined ? said : `${said} (${cause})`) };
  }
  if (record.outcome !== "succeeded")
    return { unavailable: "scan execution adapter returned an unrecognized result" };
  const evidence = asRecord(record.evidence);
  if (evidence?.kind !== "baseline-analyzer-observation-v1") {
    return {
      unavailable: `scan execution adapter returned ${
        typeof evidence?.kind === "string"
          ? adapterReason(`${evidence.kind} evidence`)
          : "no analyzer observation"
      }, which carries no SARIF for this scan`,
    };
  }
  const observation = asRecord(evidence.observation);
  const mediaType = stringMember(observation, "mediaType");
  if (mediaType !== DELEGATED_SARIF_MEDIA_TYPE) {
    return {
      unavailable: `scan execution adapter returned ${
        mediaType === undefined ? "analyzer bytes with no media type" : adapterReason(mediaType)
      }, and this scan normalizes ${DELEGATED_SARIF_MEDIA_TYPE}`,
    };
  }
  const bytes = observation?.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
    return { unavailable: "scan execution adapter returned an analyzer observation without bytes" };
  // The adapter is never trusted: the observation's own annex (digest and
  // length) is the claim, and Core recomputes both over the bytes before reading.
  if (!annexNamesBytes(observation?.annex, bytes)) {
    return {
      unavailable:
        "scan execution adapter returned analyzer bytes that its own annex does not name",
    };
  }
  let sarif: string;
  try {
    sarif = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { unavailable: "scan execution adapter returned analyzer bytes that are not UTF-8" };
  }
  return sarif.trim().length > 0
    ? { sarif }
    : { unavailable: "scan execution adapter returned empty analyzer bytes" };
}

/** Whether an observation's annex states exactly these bytes: both its sha256 and its byteLength. */
function annexNamesBytes(annex: unknown, bytes: Uint8Array): boolean {
  const record = asRecord(annex);
  return (
    stringMember(record, "sha256") === createHash("sha256").update(bytes).digest("hex") &&
    record?.byteLength === bytes.byteLength
  );
}

/** Scan's `producer` statement, when present and well-formed. */
function scanProducer(value: unknown): ScanObservationV1["producer"] {
  const record = asRecord(value);
  const name = stringMember(record, "name");
  const version = record?.version;
  if (name === undefined || !(version === null || typeof version === "string")) return undefined;
  return { name: adapterReason(name), version: version === null ? null : adapterReason(version) };
}

/**
 * Scan's `detector.aih-native` through the resolved execution: an identity
 * observation (tree hash and file list) recorded beside Core's own detectors.
 * It shows which Scan ran and under which profile; it yields no findings and
 * never changes a check. A package refusal is recorded as the observation.
 */
async function recordScanNativeObservation(
  scan: ResolvedScanExecutionV1,
  root: string,
  inventory: TrustFileInventory,
  signal: AbortSignal | undefined,
): Promise<ScanObservationV1 | undefined> {
  const detectorId = SCAN_NATIVE_OBSERVATION_DETECTOR_ID;
  if ("refusal" in scan) {
    return {
      detectorId,
      outcome: "unavailable",
      refusal: scan.refusal.reason,
      detail: scanPackageRefusalMessage(scan.refusal),
    };
  }
  // An adapter that does not declare the observation is not asked for it.
  if (adapterCapabilityFor(scan.adapter, detectorId) === undefined) return undefined;
  const base = { detectorId, scanSource: scan.source } as const;
  let result: unknown;
  try {
    result = await startTrackedScanCall(signal, detectorId, () =>
      scan.adapter.runDetectorV1({
        detectorId,
        subject: {
          kind: "source-tree",
          sourceRoot: root,
          selectedClosurePaths: inventory.files.map((entry) => entry.relativePath),
        },
        ...(signal === undefined ? {} : { signal }),
      }),
    );
  } catch (error) {
    return {
      ...base,
      outcome: "failed",
      detail: adapterReason(
        `scan execution adapter failed: ${(error as Error)?.message ?? "unknown error"}`,
      ),
    };
  }
  const record = asRecord(result);
  const producer = scanProducer(record?.producer);
  const profileId = stringMember(asRecord(record?.executionProfile), "id");
  const ran = {
    ...base,
    ...(profileId === undefined ? {} : { executionProfileId: adapterReason(profileId) }),
    ...(producer === undefined ? {} : { producer }),
  };
  if (record?.outcome !== "succeeded") {
    const narrowed = narrowedDelegatedResult(record);
    const detail = "unavailable" in narrowed ? narrowed.unavailable : "unrecognized result";
    return record?.outcome === "refused"
      ? { ...base, outcome: "refused", detail }
      : { ...ran, outcome: "failed", detail };
  }
  const observation = asRecord(asRecord(record.evidence)?.observation);
  const annex = asRecord(observation?.annex);
  const annexSha256 = stringMember(annex, "sha256");
  const bytes = observation?.bytes;
  // Scan is never trusted: the annex is its claim, checked against the bytes.
  if (
    !(bytes instanceof Uint8Array) ||
    annexSha256 === undefined ||
    !annexNamesBytes(annex, bytes)
  ) {
    return {
      ...ran,
      outcome: "failed",
      detail: "scan execution adapter returned observation bytes that its own annex does not name",
    };
  }
  const analyzer = stringMember(observation, "analyzer");
  const analyzerVersion = stringMember(observation, "analyzerVersion");
  return {
    ...ran,
    outcome: "recorded",
    ...(analyzer === undefined ? {} : { analyzer: adapterReason(analyzer) }),
    ...(analyzerVersion === undefined ? {} : { analyzerVersion: adapterReason(analyzerVersion) }),
    annexSha256,
  };
}

/**
 * Semgrep prefixes each rule id with the dotted directory of the config file it
 * read (`aih.work.semgrep.prompt-injection`), so a Semgrep rule is matched by its
 * exact id or by `.<id>` suffix against Core's own rule ids (owner decision
 * 2026-09-24: the rule map is applied).
 */
function canonicalSemgrepRuleId(raw: string): string | undefined {
  if (Object.hasOwn(SEMGREP_RULE_MAP, raw)) return raw;
  return Object.keys(SEMGREP_RULE_MAP).find((id) => raw.endsWith(`.${id}`));
}

/**
 * Scan's SARIF crosses a trust boundary, whether a delegated run returned it or
 * it arrives precomputed: the one shape check (`checkedScanSarifTextV1`), and a
 * Semgrep run may report only Core's own rules. Anything else fails closed as
 * this detector's failure, never partly read.
 */
function checkedDetectorSarif(detector: ScanRoutedDetectorV1, sarif: string): CheckedScanSarifV1 {
  const checked = checkedScanSarifTextV1(sarif);
  if ("refusal" in checked || detector !== "semgrep") return checked;
  for (const run of checked.log.runs) {
    for (const result of run.results) {
      const ruleId = result.ruleId ?? asRecord(result.rule)?.id;
      if (typeof ruleId !== "string" || canonicalSemgrepRuleId(ruleId) === undefined)
        return {
          refusal: `rule id ${adapterReason(JSON.stringify(ruleId) ?? "")}, which is not one of Core's Semgrep rules (${Object.keys(SEMGREP_RULE_MAP).join(", ")})`,
        };
    }
  }
  return checked;
}

/** What one detector call analyzes: the request fields its subject rule reads (C2a §1.6). */
export interface ScanCallSubjectRequestV1 {
  readonly detectorId: string;
  readonly sourceRoot: string;
  readonly selectedClosurePaths: readonly string[];
  readonly mcpConfigPaths?: readonly string[];
}

/**
 * The subject one detector call analyzes, rebuilt now from Core's own disk
 * and request (the source root, the selected paths and, for mcp-scanner, the
 * config paths it named), or why Core cannot rebuild it. Never cached: each
 * call binds the tree as it stands for that call.
 */
export function scanCallSubjectV1(
  request: ScanCallSubjectRequestV1,
): { readonly subject: ScanSubjectDigestV1 } | { readonly refusal: string } {
  try {
    return {
      subject: scanSubjectDigestV1(
        scanDetectorSubjectFilesV1(request.detectorId, request.sourceRoot, {
          selectedClosurePaths: request.selectedClosurePaths,
          ...(request.mcpConfigPaths === undefined
            ? {}
            : { mcpConfigPaths: request.mcpConfigPaths }),
          sealed: () => sealedScanSubjectFilesV1(request.sourceRoot),
        }),
      ),
    };
  } catch (error) {
    return {
      refusal: adapterReason(
        `completion evidence Core cannot check, because it cannot rebuild the subject of ${request.detectorId}: ${(error as Error)?.message ?? "unknown error"}`,
      ),
    };
  }
}

/**
 * Why a succeeded run's completion evidence v1 (C2a §1.6) does not bind it to
 * what Core submitted, or undefined when it does. `request.subject` is the
 * subject Core bound immediately before the call; Core rebuilds it again now,
 * after the call, and any change fails the run (the tree Scan analyzed is not
 * the one Core grades). The evidence must name that subject, and the analyzer
 * is the identity Core accepted for the run, never the evidence's own claim.
 */
export function delegatedScanCompletionRefusalV1(
  raw: unknown,
  log: CheckedScanSarifLogV1,
  request: ScanCallSubjectRequestV1 & {
    readonly executionProfileId: string;
    /** The subject bound before the call (`scanCallSubjectV1`). */
    readonly subject: ScanSubjectDigestV1;
  },
): string | undefined {
  const identity = acceptedScanAnalyzerIdentityV1(request.detectorId, request.executionProfileId);
  const version = stringMember(
    asRecord(asRecord(asRecord(raw)?.evidence)?.observation),
    "analyzerVersion",
  );
  if (identity === undefined || version === undefined)
    return `no analyzer identity Core accepts for ${request.detectorId} under ${request.executionProfileId}`;
  const after = scanCallSubjectV1(request);
  if ("refusal" in after) return after.refusal;
  if (
    after.subject.subjectTreeSha256 !== request.subject.subjectTreeSha256 ||
    after.subject.analyzedFileCount !== request.subject.analyzedFileCount
  )
    return `completion evidence Core cannot accept, because the source changed while ${request.detectorId} ran: Core submitted ${request.subject.analyzedFileCount} files with subject tree ${request.subject.subjectTreeSha256}, and the tree now has ${after.subject.analyzedFileCount} files with subject tree ${after.subject.subjectTreeSha256}`;
  return scanCompletionRefusalV1(log, {
    detectorId: request.detectorId,
    subject: request.subject,
    emptyAllowed: SCAN_EMPTY_SOURCE_COMPLETES_V1.has(request.detectorId),
    analyzer: { version, lockSha256: identity.lockSha256 },
  });
}

/**
 * Why precomputed SARIF (a Scanner annex's bytes) does not prove this tree was
 * analyzed, or undefined when it does. With no run stating completion evidence
 * v1 at all, it is `completion-evidence-absent` (every publication made before
 * Scan wrote the evidence): never counted complete, never a crash. Otherwise
 * every run's evidence must name this detector, the subject Core rebuilds from
 * this tree for it, and an analyzer identity Core pins for the detector (under
 * any of its profiles; for SkillSpector, also an image digest policy accepted).
 */
function precomputedScanCompletionRefusalV1(
  log: CheckedScanSarifLogV1,
  request: {
    readonly detectorId: string;
    readonly sourceRoot: string;
    readonly selectedClosurePaths: readonly string[];
    readonly mcpConfigPaths?: readonly string[];
    readonly acceptedImageDigests: readonly string[];
  },
): { readonly absent: true } | string | undefined {
  const firstEvidence = log.runs.map((run) => {
    const invocations = (run as unknown as Record<string, unknown>).invocations;
    const properties = asRecord(
      Array.isArray(invocations) ? invocations[0] : undefined,
    )?.properties;
    return asRecord(properties)?.[SCAN_COMPLETION_PROPERTY_V1];
  });
  if (firstEvidence.every((evidence) => evidence === undefined)) return { absent: true };
  const accepted = ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1.filter(
    (identity) => identity.detectorId === request.detectorId,
  ).flatMap((identity) => [
    { version: observedScanAnalyzerVersionV1(identity), lockSha256: identity.lockSha256 },
    ...(request.detectorId === "detector.skillspector"
      ? request.acceptedImageDigests.map((digest) => ({
          version: `${SKILLSPECTOR_SOURCE_REVISION}@${digest}`,
          lockSha256: null,
        }))
      : []),
  ]);
  const stated = asRecord(
    asRecord(firstEvidence.find((evidence) => evidence !== undefined))?.analyzer,
  );
  const analyzer =
    accepted.find(
      (candidate) =>
        candidate.version === stated?.version && candidate.lockSha256 === stated?.lockSha256,
    ) ?? accepted[0];
  if (analyzer === undefined) return `Core accepts no analyzer identity for ${request.detectorId}`;
  const bound = scanCallSubjectV1(request);
  if ("refusal" in bound) return bound.refusal;
  return scanCompletionRefusalV1(log, {
    detectorId: request.detectorId,
    subject: bound.subject,
    emptyAllowed: SCAN_EMPTY_SOURCE_COMPLETES_V1.has(request.detectorId),
    analyzer,
  });
}

interface DelegatedRunOptionsV1 {
  readonly platform: Platform;
  readonly uvProfile?: UvExecutionProfileIdV1;
  readonly signal?: AbortSignal;
  /** Detector-specific request fields (C2a §1.3), passed as named. */
  readonly detectorOptions?: Readonly<Record<string, unknown>>;
  readonly acceptedImageDigests?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

async function runDelegatedDetector(
  adapter: ScanExecutionAdapterV1,
  capability: Record<string, unknown> | undefined,
  detector: ScanRoutedDetectorV1,
  root: string,
  inventory: TrustFileInventory,
  options: DelegatedRunOptionsV1,
): Promise<DelegatedDetectorResultV1> {
  const scanId = SCAN_DETECTOR_IDS[detector];
  const profile = requestedExecutionProfileV1(
    detector,
    capability,
    options.platform,
    options.uvProfile,
  );
  if ("refusal" in profile) return { unavailable: profile.refusal, outcome: "refused" };
  const executionProfileId = profile.id;
  // Core, not Scan, is the authority on which analyzer runs: a capability that
  // declares another version or lock is not asked to run.
  const declared = declaredScanAnalyzerIdentityRefusalV1(capability, scanId, executionProfileId);
  if (declared !== undefined) return { unavailable: declared, outcome: "refused" };
  // The subject this call analyzes, bound now: the evidence is checked against
  // it, and the tree must still be it once the call returns.
  const mcpConfigPaths = options.detectorOptions?.mcpConfigPaths;
  const subjectRequest: ScanCallSubjectRequestV1 = {
    detectorId: scanId,
    sourceRoot: root,
    selectedClosurePaths: inventory.files.map((entry) => entry.relativePath),
    ...(Array.isArray(mcpConfigPaths) ? { mcpConfigPaths: mcpConfigPaths as string[] } : {}),
  };
  const bound = scanCallSubjectV1(subjectRequest);
  if ("refusal" in bound) return { unavailable: bound.refusal, outcome: "refused" };
  let raw: unknown;
  try {
    raw = await startTrackedScanCall(options.signal, scanId, () =>
      adapter.runDetectorV1({
        detectorId: scanId,
        executionProfileId,
        subject: {
          kind: "source-tree",
          sourceRoot: root,
          selectedClosurePaths: inventory.files.map((entry) => entry.relativePath),
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.detectorOptions === undefined
          ? {}
          : { detectorOptions: options.detectorOptions }),
        ...(options.acceptedImageDigests === undefined || options.acceptedImageDigests.length === 0
          ? {}
          : { acceptedImageDigests: [...options.acceptedImageDigests] }),
        ...(options.env === undefined ? {} : { env: options.env }),
      }),
    );
  } catch (error) {
    throwIfCancelled(options.signal, `${scanId} was running`);
    return {
      unavailable: adapterReason(
        `scan execution adapter failed: ${(error as Error)?.message ?? "unknown error"}`,
      ),
      outcome: "failed",
    };
  }
  // Scan reports a cancelled run as a failure; Core stops rather than grade it.
  throwIfCancelled(options.signal, `${scanId} was running`);
  const result = delegatedDetectorResult(raw);
  if (!("sarif" in result)) return result;
  if (result.executionProfileId !== executionProfileId)
    return {
      unavailable: `${scanId} returned execution profile ${result.executionProfileId ?? "unstated"} instead of requested ${executionProfileId}`,
      outcome: "failed",
    };
  const executed = executedScanAnalyzerIdentityRefusalV1(raw, scanId, executionProfileId, {
    acceptedImageDigests: options.acceptedImageDigests ?? [],
  });
  if (executed !== undefined)
    return { unavailable: executed, outcome: "failed", executionProfileId };
  const checked = checkedDetectorSarif(detector, result.sarif);
  if ("refusal" in checked)
    return {
      unavailable: `${scanId} returned ${checked.refusal}`,
      outcome: "failed",
      executionProfileId,
    };
  // Zero findings count only when the SARIF names the subject Scan proved was
  // analyzed, and that subject is the one Core submitted.
  const completion = delegatedScanCompletionRefusalV1(raw, checked.log, {
    ...subjectRequest,
    executionProfileId,
    subject: bound.subject,
  });
  if (completion !== undefined)
    return {
      unavailable: `${scanId} returned ${completion}`,
      outcome: "failed",
      executionProfileId,
    };
  return result;
}

/** Where a scan's native findings come from: Scan's trust lint, always. */
export interface ScanTrustLintRouteV1 {
  readonly adapter: ScanExecutionAdapterV1;
  readonly source: ScanExecutionSource;
  readonly capability: Record<string, unknown>;
}

/**
 * Scan's `detector.aih-trust-lint`, which produces every trust scan's native
 * findings. There is no fallback: a missing or incompatible package (or an
 * injected adapter that does not declare the detector) refuses the whole trust
 * scan with `ScanPackageRefusalError`, because without native findings Core has
 * nothing to grade the source on.
 */
export async function resolveScanTrustLintRouteV1(options: {
  readonly scanExecution?: ScanExecutionAdapterV1;
}): Promise<ScanTrustLintRouteV1> {
  const scan = await resolveScanExecutionV1(options.scanExecution);
  if ("refusal" in scan) throw new ScanPackageRefusalError(scan.refusal);
  const capability = adapterCapabilityFor(scan.adapter, SCAN_TRUST_LINT_DETECTOR);
  if (capability === undefined)
    throw new ScanPackageRefusalError({
      reason: "scan-package-incompatible",
      detail: `the ${scan.source === "installed-package" ? "installed @aihq/scan" : "injected scan execution adapter"} declares no ${SCAN_DETECTOR_IDS[SCAN_TRUST_LINT_DETECTOR]} capability, so Core has no native findings for this source. Install it with: ${SCAN_PACKAGE_INSTALL_COMMAND} (in a project: ${SCAN_PACKAGE_PROJECT_INSTALL_COMMAND}).`,
    });
  return { adapter: scan.adapter, source: scan.source, capability };
}

function trustLintUnavailableCheck(source: ScanExecutionSource, reason: string): Check {
  const said = source === "installed-package" ? `installed @aihq/scan: ${reason}` : reason;
  return {
    name: `trust detector ${SCAN_TRUST_LINT_DETECTOR}`,
    verdict: "fail",
    code: DETECTOR_UNAVAILABLE,
    detail: `native trust findings are unavailable (${said}); Core cannot grade this source without them, so this fails at every posture.`,
  };
}

export interface ScanTrustLintResultV1 {
  /** The graded native checks in Scan's order, MCP-description findings tagged, or one failing check. */
  readonly checks: TrustLintCheckV1[];
  readonly execution: TrustDetectorExecutionV1;
  /** The classification facts, only when the trust lint completed. */
  readonly facts?: TrustLintFactsV1;
}

/**
 * Scan's native findings as Core's graded native checks, in Core's native order,
 * plus the facts Core's third-party classification reads. A refusal, a failure
 * or SARIF Core cannot accept leaves one failing `trust.detector-unavailable`
 * check at every posture: native coverage is the floor every trust verdict
 * stands on, so its absence never passes.
 */
export async function runScanTrustLintV1(
  route: ScanTrustLintRouteV1,
  root: string,
  options: {
    readonly inventory: TrustFileInventory;
    readonly platform: Platform;
    readonly posture: Posture;
    readonly internalScopes: readonly string[];
    readonly mcpConfigPaths: readonly string[];
    readonly signal?: AbortSignal;
  },
): Promise<ScanTrustLintResultV1> {
  throwIfCancelled(options.signal, `before ${SCAN_DETECTOR_IDS[SCAN_TRUST_LINT_DETECTOR]} started`);
  const delegated = await runDelegatedDetector(
    route.adapter,
    route.capability,
    SCAN_TRUST_LINT_DETECTOR,
    root,
    options.inventory,
    {
      platform: options.platform,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      // Dependency confusion is decided against the organization's internal
      // scopes; MCP secrets and descriptions against the configs Core declared.
      detectorOptions: {
        internalScopes: [...options.internalScopes],
        mcpConfigPaths: [...options.mcpConfigPaths],
      },
    },
  );
  const base = {
    detector: SCAN_TRUST_LINT_DETECTOR,
    executedBy: "scan",
    scanSource: route.source,
    ...(delegated.executionProfileId === undefined
      ? {}
      : { executionProfileId: delegated.executionProfileId }),
  } as const;
  if ("unavailable" in delegated)
    return {
      checks: [{ check: trustLintUnavailableCheck(route.source, delegated.unavailable) }],
      execution: { ...base, outcome: delegated.outcome },
    };
  const mapped = trustLintChecksFromSarifV1(delegated.sarif, options.posture, {
    selectedPaths: options.inventory.files.map((entry) => entry.relativePath),
    mcpConfigPaths: options.mcpConfigPaths,
  });
  if ("refusal" in mapped)
    return {
      checks: [{ check: trustLintUnavailableCheck(route.source, mapped.refusal) }],
      execution: { ...base, outcome: "failed" },
    };
  return {
    checks: mapped.checks,
    execution: { ...base, outcome: "completed" },
    facts: mapped.facts,
  };
}

const SKILL_TRUST_DETECTORS: TrustDetector[] = [
  { name: "skillspector", analyzerLabel: "skillspector@docker", ruleMap: SKILLSPECTOR_RULE_MAP },
  { name: "cisco", analyzerLabel: CISCO_SKILL_SCANNER_ANALYZER, ruleMap: CISCO_RULE_MAP },
  { name: "semgrep", analyzerLabel: SEMGREP_ANALYZER, ruleMap: SEMGREP_RULE_MAP },
  {
    name: "snyk-agent-scan",
    analyzerLabel: SNYK_AGENT_SCAN_ANALYZER,
    ruleMap: SNYK_AGENT_SCAN_RULE_MAP,
  },
];

// Semgrep stays in SKILL_TRUST_DETECTORS: it scans the full trust tree,
// including MCP config files. This list is for MCP-specific detector tools.
const MCP_CONFIG_DETECTORS: TrustDetector[] = [
  { name: "mcp-scanner", analyzerLabel: CISCO_MCP_SCANNER_ANALYZER, ruleMap: MCP_SCANNER_RULE_MAP },
];

/** The analyzer label Core records for each detector (`analyzersRun`, baseline receipts). */
export const TRUST_DETECTOR_ANALYZER_LABELS: Readonly<Record<TrustDetectorName, string>> =
  Object.freeze(
    Object.fromEntries(
      [...SKILL_TRUST_DETECTORS, ...MCP_CONFIG_DETECTORS].map((detector) => [
        detector.name,
        detector.analyzerLabel,
      ]),
    ) as Record<TrustDetectorName, string>,
  );

/** The request fields one detector takes beyond the subject (C2a §2.1, §3.3, §4.1, §5.1, §6.2). */
function detectorRequestFields(
  detector: TrustDetectorName,
  options: TrustDetectorOptions,
): Pick<DelegatedRunOptionsV1, "detectorOptions" | "acceptedImageDigests" | "env"> {
  if (detector === "cisco")
    return { detectorOptions: { concurrency: resolveCiscoScanConcurrency(options.env) } };
  if (detector === "mcp-scanner")
    return { detectorOptions: { mcpConfigPaths: [...(options.mcpConfigPaths ?? [])] } };
  if (detector === "skillspector")
    return {
      acceptedImageDigests: acceptedSkillspectorImageDigestsV1(
        options.skillspectorImageApprovals ?? [],
      ),
    };
  if (detector === "snyk-agent-scan") {
    const env = snykTokenEnv(options.env);
    return env === undefined ? {} : { env };
  }
  return {};
}

async function runDetectorList(
  detectors: readonly TrustDetector[],
  root: string,
  options: TrustDetectorOptions,
  recordScanObservation = false,
): Promise<TrustDetectorResult> {
  const required = options.requiredDetectors ?? [];
  const checks: Check[] = [];
  const analyzersRun: string[] = [];
  const rawOccurrences: RawScannerOccurrence[] = [];
  const facts = options.trustLintFacts ?? NO_TRUST_LINT_FACTS;
  const corroboratedDangerLocations = new Set(
    (options.corroboratedChecks ?? [])
      .filter(
        (check) =>
          check.location !== undefined &&
          (check.code === "trust.malicious-code" || check.code === "trust.auto-exec-hook"),
      )
      .map(
        (check) =>
          `${check.code ?? ""}:${check.location?.uri ?? ""}:${String(check.location?.startLine ?? 1)}`,
      ),
  );

  const executions: TrustDetectorExecutionV1[] = [];
  // Scan is resolved once per list and only when a detector actually needs
  // execution: precomputed SARIF never loads the package.
  let scanExecution: Promise<ResolvedScanExecutionV1> | undefined;
  const resolveScanExecution = (): Promise<ResolvedScanExecutionV1> => {
    scanExecution ??= resolveScanExecutionV1(options.scanExecution);
    return scanExecution;
  };
  const unavailable = (detector: TrustDetector, reason: string): void => {
    checks.push(
      unavailableCheck(detector.name, reason, options.posture, isRequired(detector.name, required)),
    );
  };

  for (const detector of detectors) {
    throwIfCancelled(options.signal, `before ${SCAN_DETECTOR_IDS[detector.name]} started`);
    options.progress?.(`trust scan: detector ${detector.name} started`);
    const precomputed = options.precomputedSarif?.[detector.name];
    let sarifText: string;
    let execution: Omit<TrustDetectorExecutionV1, "detector" | "outcome"> = {
      executedBy: "precomputed-sarif",
    };
    let delegatedPass: Parameters<typeof analyzerPassCheck>[2];
    // A verified shard join's jobs were each checked against their own subject.
    let verifiedShardJoin = false;
    if (typeof precomputed === "string") sarifText = precomputed;
    else if (precomputed !== undefined) {
      const binding = ISSUED_SHARD_JOINS.get(precomputed);
      if (detector.name !== "cisco" || binding === undefined) {
        unavailable(
          detector,
          `precomputed SARIF for ${SCAN_DETECTOR_IDS[detector.name]} is refused: a shard join Core did not verify for ${SCAN_DETECTOR_IDS[detector.name]}`,
        );
        executions.push({ detector: detector.name, ...execution, outcome: "failed" });
        continue;
      }
      const unbound = issuedShardJoinRefusalV1(binding, root, options.inventory);
      if (unbound !== undefined) {
        unavailable(
          detector,
          `precomputed SARIF for ${SCAN_DETECTOR_IDS[detector.name]} is refused: ${unbound}`,
        );
        executions.push({ detector: detector.name, ...execution, outcome: "failed" });
        continue;
      }
      sarifText = precomputed.sarif;
      verifiedShardJoin = true;
    } else {
      const scan = await resolveScanExecution();
      const capability =
        "adapter" in scan ? adapterCapabilityFor(scan.adapter, detector.name) : undefined;
      if (!("adapter" in scan) || capability === undefined) {
        // No fallback: a detector Scan cannot run is unavailable, never run by Core.
        const refusal: ScanPackageRefusalV1 =
          "refusal" in scan
            ? scan.refusal
            : {
                reason: "scan-package-incompatible",
                detail: `the ${scan.source === "installed-package" ? "installed @aihq/scan" : "injected scan execution adapter"} declares no ${SCAN_DETECTOR_IDS[detector.name]} capability; Core does not execute ${detector.name} itself.`,
              };
        unavailable(detector, scanPackageRefusalMessage(refusal));
        executions.push({
          detector: detector.name,
          executedBy: "none",
          outcome: "unavailable",
          refusal: refusal.reason,
        });
        continue;
      }
      const delegated = await runDelegatedDetector(
        scan.adapter,
        capability,
        detector.name,
        root,
        options.inventory,
        {
          platform: options.platform,
          ...(options.uvExecutionProfileId === undefined
            ? {}
            : { uvProfile: options.uvExecutionProfileId }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...detectorRequestFields(detector.name, options),
        },
      );
      execution = {
        executedBy: "scan",
        scanSource: scan.source,
        ...(delegated.executionProfileId === undefined
          ? {}
          : { executionProfileId: delegated.executionProfileId }),
      };
      if ("unavailable" in delegated) {
        // Scan's own words, prefixed with who said them when it is the installed package.
        unavailable(
          detector,
          scan.source === "installed-package"
            ? `installed @aihq/scan: ${delegated.unavailable}`
            : delegated.unavailable,
        );
        executions.push({ detector: detector.name, ...execution, outcome: delegated.outcome });
        continue;
      }
      sarifText = delegated.sarif;
      delegatedPass = {
        source: scan.source,
        ...(delegated.executionProfileId === undefined
          ? {}
          : { executionProfileId: delegated.executionProfileId }),
      };
    }

    // Precomputed SARIF meets the same boundary as a run Scan just returned.
    const checked = checkedDetectorSarif(detector.name, sarifText);
    if ("refusal" in checked) {
      unavailable(
        detector,
        execution.executedBy === "precomputed-sarif"
          ? `precomputed SARIF for ${SCAN_DETECTOR_IDS[detector.name]} is refused: it holds ${checked.refusal}`
          : `${SCAN_DETECTOR_IDS[detector.name]} returned ${checked.refusal}`,
      );
      executions.push({ detector: detector.name, ...execution, outcome: "failed" });
      continue;
    }
    // Precomputed SARIF counts complete only when it proves this tree was
    // analyzed, exactly as a delegated run must (decision D17).
    if (execution.executedBy === "precomputed-sarif" && !verifiedShardJoin) {
      const scanId = SCAN_DETECTOR_IDS[detector.name];
      const completion = precomputedScanCompletionRefusalV1(checked.log, {
        detectorId: scanId,
        sourceRoot: root,
        selectedClosurePaths: options.inventory.files.map((entry) => entry.relativePath),
        ...(detector.name === "mcp-scanner"
          ? { mcpConfigPaths: [...(options.mcpConfigPaths ?? [])] }
          : {}),
        acceptedImageDigests: acceptedSkillspectorImageDigestsV1(
          options.skillspectorImageApprovals ?? [],
        ),
      });
      if (typeof completion === "object") {
        unavailable(
          detector,
          `precomputed SARIF for ${scanId} carries no completion evidence v1 (completion-evidence-absent); SARIF published before Scan wrote completion evidence is never counted complete, so it must be republished with evidence`,
        );
        executions.push({
          detector: detector.name,
          ...execution,
          outcome: "unavailable",
          reason: "completion-evidence-absent",
        });
        continue;
      }
      if (completion !== undefined) {
        unavailable(detector, `precomputed SARIF for ${scanId} is refused: ${completion}`);
        executions.push({ detector: detector.name, ...execution, outcome: "failed" });
        continue;
      }
    }
    // Without completed native facts the scan already fails; with them, none may be missing.
    const unstated =
      options.trustLintFacts === undefined
        ? undefined
        : unstatedFactsRefusal(checked.log, detector, root, options.trustLintFacts);
    if (unstated !== undefined) {
      unavailable(detector, unstated);
      executions.push({ detector: detector.name, ...execution, outcome: "failed" });
      continue;
    }
    const mapped = sarifChecks(
      checked.log,
      root,
      options.posture,
      detector,
      corroboratedDangerLocations,
      facts,
      // Semgrep rule ids carry its config directory; Core classifies by its own id.
      detector.name === "semgrep" ? canonicalSemgrepRuleId : undefined,
    );
    analyzersRun.push(detector.analyzerLabel);
    rawOccurrences.push(...mapped.rawOccurrences);
    const completedAnalyzers = ["aih-native", ...analyzersRun];
    checks.push(analyzerPassCheck(detector, completedAnalyzers, delegatedPass), ...mapped.checks);
    executions.push({ detector: detector.name, ...execution, outcome: "completed" });
    options.progress?.(`trust scan: detector ${detector.name} complete`);
  }

  // Scan's identity observation rides along only when Scan was consulted at all.
  const observations =
    recordScanObservation && scanExecution !== undefined
      ? [
          await recordScanNativeObservation(
            await scanExecution,
            root,
            options.inventory,
            options.signal,
          ),
        ].filter((observation): observation is ScanObservationV1 => observation !== undefined)
      : [];
  return { checks, analyzersRun, rawOccurrences, executions, observations };
}

export async function runTrustDetectors(
  root: string,
  options: TrustDetectorOptions,
): Promise<TrustDetectorResult> {
  const selected =
    options.detectors === undefined
      ? SKILL_TRUST_DETECTORS
      : SKILL_TRUST_DETECTORS.filter((detector) => options.detectors?.includes(detector.name));
  return runDetectorList(selected, root, options, true);
}

export async function runMcpConfigDetectors(
  root: string,
  options: TrustDetectorOptions,
): Promise<TrustDetectorResult> {
  const selected =
    options.detectors === undefined
      ? MCP_CONFIG_DETECTORS
      : MCP_CONFIG_DETECTORS.filter((detector) => options.detectors?.includes(detector.name));
  return runDetectorList(selected, root, options);
}

function executorText(execution: TrustDetectorExecutionV1): string {
  if (execution.executedBy !== "scan") return `${execution.detector}=${execution.executedBy}`;
  const source =
    execution.scanSource === "injected-adapter" ? "injected scan adapter" : "installed @aihq/scan";
  const profile =
    execution.executionProfileId === undefined ? "" : ` ${execution.executionProfileId}`;
  return `${execution.detector}=${source}${profile} (${execution.outcome})`;
}

function observationText(observation: ScanObservationV1): string {
  if (observation.outcome !== "recorded")
    return `@aihq/scan observation ${observation.detectorId} ${observation.outcome === "unavailable" ? "not recorded" : observation.outcome}: ${observation.detail ?? "no reason given"}`;
  const producer =
    observation.producer === undefined
      ? ""
      : ` (producer ${observation.producer.name}@${observation.producer.version ?? "unknown"})`;
  const source =
    observation.scanSource === "injected-adapter"
      ? "the injected scan adapter"
      : "the installed @aihq/scan";
  return `@aihq/scan observation ${observation.detectorId} recorded by ${source}${producer} under execution profile ${observation.executionProfileId ?? "unstated"}: analyzer ${observation.analyzer ?? "unstated"} ${observation.analyzerVersion ?? ""}, annex sha256 ${observation.annexSha256}. An identity observation, not a Core finding.`;
}

export function trustRuntimeAdvisory(
  analyzersRun: readonly string[],
  record: {
    readonly executions?: readonly TrustDetectorExecutionV1[];
    readonly observations?: readonly ScanObservationV1[];
  } = {},
): string {
  const executions = record.executions ?? [];
  return [
    `No findings != safe. Static analyzers actually run: ${analyzersRun.join(", ")}.`,
    "What this gate does not cover, and the manual runtime mitigations to consider:",
    "- Transitive or pinned-dependency malice: run a sandboxed `npm install --ignore-scripts` and `npm audit` before trusting dependency behavior.",
    "- Hosted-MCP rug-pull after approval: run a runtime MCP-scan with tool-pinning before first use.",
    "- Bundled installer scripts may fetch-pipes remote code to a shell (`curl|wget ... | sh`); review setup scripts before running them.",
    '- Residual auto-exec risk: set `permissions.deny: ["Bash(*)"]` in the consuming CLI policy.',
    "These are advisory commands/settings for a human to review; the trust gate never auto-runs them.",
    // Who executed each detector is stated, never implied.
    ...(executions.length === 0
      ? []
      : [`Detector executors: ${executions.map(executorText).join(", ")}.`]),
    ...(record.observations ?? []).map(observationText),
  ].join("\n");
}
