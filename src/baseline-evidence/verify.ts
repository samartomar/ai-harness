import type { Posture } from "../config/posture.js";
import type { Check, CheckCode } from "../internals/verify.js";
import { TRUST_POLICY_VERSION } from "../trust/evidence.js";
import {
  type AcceptanceDecision,
  type AcceptanceTuple,
  CORRECTED_ACCEPTANCE_POLICY_VERSION,
  matchCorrectedComponentAcceptance,
  readAcceptanceDecisions,
} from "./acceptance.js";
import { type BaselineCatalog, resolveCatalogComponents } from "./catalog.js";
import { hashComponentTree, hashSourceTree } from "./hash.js";
import { componentIdentityPaths } from "./license.js";
import type { OrgBaselineEvidence } from "./org.js";
import type {
  BaselineComponentEvidence,
  BaselineEvidenceLock,
  BaselineSourceEvidence,
} from "./schema.js";

export interface BaselineAuthorization {
  componentId: string;
  source: string;
  pinnedSha: string;
  treeSha256: string;
  tier: "vendor" | "org";
  issuer: string;
  evidenceSha256: string;
  /**
   * Present when an exact signed organization decision records acceptance of the
   * findings this evidence carries: the organization's own record, shown next to
   * the findings. It admits nothing; the evidence alone authorizes the bytes.
   */
  acceptance?: {
    decisionId: string;
    recordSha256: string;
    acceptedFindingCodes: string[];
  };
}

/** A finding or evidence-problem code and how many occurrences the evidence reports. */
export interface BaselineLabelCount {
  code: string;
  count: number;
}

/**
 * What the signed evidence says about one authorized component: information for
 * the consumer, never a gate. Findings and evidence problems stay apart.
 */
export interface BaselineComponentLabels {
  componentId: string;
  tier: "vendor" | "org";
  verdict: BaselineComponentEvidence["verdict"];
  findings: BaselineLabelCount[];
  evidenceProblems: BaselineLabelCount[];
}

/** A component no signed evidence covers or matches: the bytes are not the evidenced bytes. */
export interface BaselineHeldComponent {
  componentId: string;
  routeCode: CheckCode;
  codes: string[];
  details: string[];
}

export interface VerifyBaselineComponentsInput {
  sourceRoot: string;
  catalog: BaselineCatalog;
  componentIds: readonly string[];
  posture: Posture;
  vendorLock: BaselineEvidenceLock;
  vendorLockSha256: string;
  /**
   * Optional exact full-source identity required by an authenticated historical
   * runtime descriptor. Legacy vendor locks intentionally omit this check.
   */
  expectedSourceTreeSha256?: string;
  orgEvidence?: OrgBaselineEvidence;
  /** Signed organization decisions about findings; defaults to the shipped artifact. */
  acceptanceDecisions?: readonly AcceptanceDecision[];
  /** When set, decisions matching this exact profile/host/adapter tuple are attached. */
  acceptanceTuple?: AcceptanceTuple;
}

export interface BaselineVerificationResult {
  checks: Check[];
  authorizations: BaselineAuthorization[];
  /** One entry per authorization, in the same order. */
  labels: BaselineComponentLabels[];
  held: BaselineHeldComponent[];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function warningOrFailure(
  posture: Posture,
  name: string,
  detail: string,
  code: "baseline.evidence-missing" | "baseline.evidence-mismatch",
): Check {
  if (posture === "vibe") {
    return { name, verdict: "pass", detail: `warning-only (vibe posture): ${detail}` };
  }
  return { name, verdict: "fail", code, detail };
}

function sourceEvidence(
  lock: BaselineEvidenceLock,
  catalog: BaselineCatalog,
): BaselineSourceEvidence | undefined {
  return lock.sources.find(
    (source) =>
      source.id === catalog.id &&
      source.owner === catalog.owner &&
      source.repo === catalog.repo &&
      source.pinnedSha === catalog.pinnedSha,
  );
}

function exactComponent(
  source: BaselineSourceEvidence | undefined,
  componentId: string,
  paths: readonly string[],
  actualHash: string,
): BaselineComponentEvidence | undefined {
  const evidence = source?.components.find((candidate) => candidate.id === componentId);
  return evidence !== undefined &&
    sameStrings(evidence.paths, paths) &&
    evidence.treeSha256 === actualHash
    ? evidence
    : undefined;
}

function labelCounts(entries: BaselineComponentEvidence["findings"]): BaselineLabelCount[] {
  const counts = new Map<string, number>();
  for (const entry of entries)
    counts.set(entry.code, (counts.get(entry.code) ?? 0) + (entry.count ?? 1));
  return [...counts].map(([code, count]) => ({ code, count }));
}

export function baselineComponentLabels(
  evidence: BaselineComponentEvidence,
  tier: "vendor" | "org",
): BaselineComponentLabels {
  return {
    componentId: evidence.id,
    tier,
    verdict: evidence.verdict,
    findings: labelCounts(evidence.findings),
    evidenceProblems: labelCounts(evidence.evidenceProblems),
  };
}

function labelDetail(labels: BaselineComponentLabels): string {
  const parts: string[] = [];
  const total = labels.findings.reduce((sum, entry) => sum + entry.count, 0);
  if (total > 0) {
    parts.push(
      `carries ${total} finding${total === 1 ? "" : "s"}: ${labels.findings.map((entry) => entry.code).join(", ")}`,
    );
  }
  if (labels.evidenceProblems.length > 0) {
    parts.push(
      `evidence problems: ${labels.evidenceProblems.map((entry) => entry.code).join(", ")}`,
    );
  }
  return parts.map((part) => `; ${part}`).join("");
}

function authorization(
  input: VerifyBaselineComponentsInput,
  componentId: string,
  actualHash: string,
  tier: "vendor" | "org",
): BaselineAuthorization {
  return {
    componentId,
    source: `${input.catalog.owner}/${input.catalog.repo}`,
    pinnedSha: input.catalog.pinnedSha,
    treeSha256: actualHash,
    tier,
    issuer: tier === "vendor" ? "@aihq/core release" : (input.orgEvidence?.issuer ?? "org"),
    evidenceSha256:
      tier === "vendor" ? input.vendorLockSha256 : (input.orgEvidence?.evidenceSha256 ?? ""),
  };
}

/**
 * The organization's signed decision about exactly these findings on exactly these
 * bytes, when one exists. Every bound field must match so a decision about other
 * bytes is never shown as being about these; the decision itself admits nothing.
 */
function organizationDecision(
  input: VerifyBaselineComponentsInput,
  evidence: BaselineComponentEvidence,
  actual: string,
  sourceTreeDigest: string,
): BaselineAuthorization["acceptance"] {
  if (input.acceptanceTuple === undefined || evidence.findings.length === 0) return undefined;
  const fingerprintCoverage = evidence.findings.every(
    (finding) => finding.fingerprints !== undefined || finding.fingerprint !== undefined,
  );
  if (!fingerprintCoverage) return undefined;
  return matchCorrectedComponentAcceptance(input.acceptanceDecisions ?? readAcceptanceDecisions(), {
    framework: input.catalog.id,
    repository: `${input.catalog.owner}/${input.catalog.repo}`,
    commitSha: input.catalog.pinnedSha,
    componentId: evidence.id,
    componentTreeSha256: actual,
    findingCodes: [...new Set(evidence.findings.map((finding) => finding.code))],
    policyVersion: CORRECTED_ACCEPTANCE_POLICY_VERSION,
    trustPolicyVersion: TRUST_POLICY_VERSION,
    profile: input.acceptanceTuple.profile,
    host: input.acceptanceTuple.host,
    adapter: input.acceptanceTuple.adapter,
    sourceTreeDigest,
    occurrenceFingerprints: evidence.findings.flatMap(
      (finding) =>
        finding.fingerprints ?? (finding.fingerprint === undefined ? [] : [finding.fingerprint]),
    ),
    analyzerVersions: evidence.analyzers
      .map((receipt) => `${receipt.name}@${receipt.version}`)
      .sort((left, right) => left.localeCompare(right)),
  });
}

export function verifyBaselineComponents(
  input: VerifyBaselineComponentsInput,
): BaselineVerificationResult {
  const components = resolveCatalogComponents(input.catalog, input.componentIds);
  const sourceName = `${input.catalog.owner}/${input.catalog.repo}`;
  const vendorSource = sourceEvidence(input.vendorLock, input.catalog);
  const sourceTreeDigest = hashSourceTree(input.sourceRoot).treeSha256;
  if (
    input.expectedSourceTreeSha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(input.expectedSourceTreeSha256)
  ) {
    throw new TypeError(
      "expected historical source tree digest must be a lowercase SHA-256 hex string",
    );
  }
  const orgSource =
    input.orgEvidence === undefined
      ? undefined
      : sourceEvidence(input.orgEvidence.lock, input.catalog);
  const checks: Check[] = [];
  const authorizations: BaselineAuthorization[] = [];
  const held: BaselineHeldComponent[] = [];
  const labelled: BaselineComponentLabels[] = [];

  if (
    input.expectedSourceTreeSha256 !== undefined &&
    sourceTreeDigest !== input.expectedSourceTreeSha256
  ) {
    const detail =
      `acquired source tree digest ${sourceTreeDigest} does not match the authenticated historical descriptor ` +
      `${input.expectedSourceTreeSha256}`;
    for (const component of components) {
      checks.push({
        name: `baseline evidence ${component.id}`,
        verdict: "fail",
        code: "baseline.evidence-mismatch",
        detail,
      });
      held.push({
        componentId: component.id,
        routeCode: "baseline.evidence-mismatch",
        codes: ["baseline.evidence-mismatch"],
        details: [detail],
      });
    }
    return { checks, authorizations, labels: labelled, held };
  }

  const hold = (
    componentId: string,
    check: Check,
    routeCode: CheckCode,
    codes: readonly string[] = [routeCode],
  ): void => {
    held.push({
      componentId,
      routeCode: check.code ?? routeCode,
      codes: [...new Set(codes)],
      details: [check.detail ?? check.name],
    });
  };

  for (const component of components) {
    const name = `baseline evidence ${component.id}`;
    const actual = hashComponentTree(
      input.sourceRoot,
      componentIdentityPaths(input.sourceRoot, component.paths),
    ).treeSha256;
    const vendorEntry = vendorSource?.components.find((candidate) => candidate.id === component.id);
    const exactVendor = exactComponent(vendorSource, component.id, component.paths, actual);
    // Exact signed evidence authorizes these bytes whatever it found. Findings and
    // evidence problems travel as labels for the consumer; nothing is held for them.
    if (exactVendor !== undefined) {
      const labels = baselineComponentLabels(exactVendor, "vendor");
      const acceptance = organizationDecision(input, exactVendor, actual, sourceTreeDigest);
      checks.push({
        name,
        verdict: "pass",
        detail:
          `${component.id} matches signed vendor evidence; user-side analyzer runtime not required` +
          labelDetail(labels) +
          (acceptance === undefined
            ? ""
            : `; organization decision ${acceptance.decisionId} records acceptance of ${acceptance.acceptedFindingCodes.join(", ")}`),
      });
      authorizations.push({
        ...authorization(input, component.id, actual, "vendor"),
        ...(acceptance === undefined ? {} : { acceptance }),
      });
      labelled.push(labels);
      continue;
    }

    const orgEntry = orgSource?.components.find((candidate) => candidate.id === component.id);
    const exactOrg = exactComponent(orgSource, component.id, component.paths, actual);
    if (exactOrg !== undefined) {
      const labels = baselineComponentLabels(exactOrg, "org");
      checks.push({
        name,
        verdict: "pass",
        detail:
          `${component.id} matches signed org evidence from ${input.orgEvidence?.issuer}; user-side analyzer runtime not required` +
          labelDetail(labels),
      });
      authorizations.push(authorization(input, component.id, actual, "org"));
      labelled.push(labels);
      continue;
    }

    const mismatched = vendorEntry !== undefined || orgEntry !== undefined;
    const code = mismatched ? "baseline.evidence-mismatch" : "baseline.evidence-missing";
    const check = warningOrFailure(
      input.posture,
      name,
      mismatched
        ? `${component.id} content hash or catalog paths do not match the available signed evidence`
        : `${sourceName}@${input.catalog.pinnedSha.slice(0, 12)} component ${component.id} is not covered by vendor or org evidence`,
      code,
    );
    checks.push(check);
    hold(component.id, check, code);
  }

  return { checks, authorizations, labels: labelled, held };
}
