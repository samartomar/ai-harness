import type { Posture } from "../config/posture.js";
import type { Check, CheckCode } from "../internals/verify.js";
import {
  type AcceptanceDecision,
  type AcceptanceTuple,
  matchComponentAcceptance,
  readAcceptanceDecisions,
} from "./acceptance.js";
import { type BaselineCatalog, resolveCatalogComponents } from "./catalog.js";
import { hashComponentTree } from "./hash.js";
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
  /** Effective disposition. Absent/"pass" = signed vet pass. "accepted-with-conditions"
   * = the raw vet verdict is BLOCKED (preserved untouched in the lock) and an exact
   * signed acceptance decision admitted this component (W4 ruling (e)). */
  effective?: "pass" | "accepted-with-conditions";
  /** Present iff `effective` is "accepted-with-conditions": the signed decision. */
  acceptance?: {
    decisionId: string;
    recordSha256: string;
    acceptedFindingCodes: string[];
  };
}

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
  orgEvidence?: OrgBaselineEvidence;
  /** Signed accepted-with-conditions decisions; defaults to the shipped artifact. */
  acceptanceDecisions?: readonly AcceptanceDecision[];
  /** When set, only decisions matching this exact profile/host/adapter tuple apply. */
  acceptanceTuple?: AcceptanceTuple;
}

export interface BaselineVerificationResult {
  checks: Check[];
  authorizations: BaselineAuthorization[];
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

function blockedCheck(name: string, evidence: BaselineComponentEvidence): Check {
  const codes = [...new Set(evidence.findings.map((finding) => finding.code))].join(", ");
  return {
    name,
    verdict: "fail",
    code: "baseline.evidence-blocked",
    detail: `${evidence.id} is blocked by signed evidence (${codes || "trust finding"}); fix and vet a new pin — org evidence cannot waive this verdict`,
  };
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
    issuer: tier === "vendor" ? "@aihq/harness release" : (input.orgEvidence?.issuer ?? "org"),
    evidenceSha256:
      tier === "vendor" ? input.vendorLockSha256 : (input.orgEvidence?.evidenceSha256 ?? ""),
  };
}

export function verifyBaselineComponents(
  input: VerifyBaselineComponentsInput,
): BaselineVerificationResult {
  const components = resolveCatalogComponents(input.catalog, input.componentIds);
  const sourceName = `${input.catalog.owner}/${input.catalog.repo}`;
  const vendorSource = sourceEvidence(input.vendorLock, input.catalog);
  const orgSource =
    input.orgEvidence === undefined
      ? undefined
      : sourceEvidence(input.orgEvidence.lock, input.catalog);
  const checks: Check[] = [];
  const authorizations: BaselineAuthorization[] = [];
  const held: BaselineHeldComponent[] = [];

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
    const actual = hashComponentTree(input.sourceRoot, component.paths).treeSha256;
    const vendorEntry = vendorSource?.components.find((candidate) => candidate.id === component.id);
    const exactVendor = exactComponent(vendorSource, component.id, component.paths, actual);
    if (exactVendor?.verdict === "blocked") {
      // Accepted-with-conditions join (W4 ruling (e)): the raw verdict stays
      // blocked; an EXACT signed acceptance (same repo/pin/component/digest,
      // every finding code accepted, none unwaivable, unexpired) may admit the
      // component. The check names BOTH facts — the raw block is never
      // reported as a vet pass.
      const rawCodes = [...new Set(exactVendor.findings.map((finding) => finding.code))];
      const acceptance = matchComponentAcceptance(
        input.acceptanceDecisions ?? readAcceptanceDecisions(),
        {
          framework: input.catalog.id,
          repository: sourceName,
          commitSha: input.catalog.pinnedSha,
          componentId: component.id,
          componentTreeSha256: actual,
          findingCodes: rawCodes,
        },
        new Date(),
        input.acceptanceTuple,
      );
      if (acceptance !== undefined) {
        checks.push({
          name,
          verdict: "pass",
          detail:
            `${component.id} raw vet verdict is BLOCKED (${rawCodes.join(", ") || "trust finding"}); ` +
            `admitted by signed acceptance ${acceptance.decisionId} (accepted-with-conditions; ` +
            `raw findings preserved in the vendor lock)`,
        });
        authorizations.push({
          ...authorization(input, component.id, actual, "vendor"),
          effective: "accepted-with-conditions",
          acceptance,
        });
        continue;
      }
      const check = blockedCheck(name, exactVendor);
      checks.push(check);
      hold(
        component.id,
        check,
        "baseline.evidence-blocked",
        exactVendor.findings.map((finding) => finding.code),
      );
      continue;
    }
    if (exactVendor?.verdict === "pass") {
      checks.push({
        name,
        verdict: "pass",
        detail: `${component.id} matches signed vendor evidence; user-side analyzer runtime not required`,
      });
      authorizations.push(authorization(input, component.id, actual, "vendor"));
      continue;
    }

    const orgEntry = orgSource?.components.find((candidate) => candidate.id === component.id);
    const exactOrg = exactComponent(orgSource, component.id, component.paths, actual);
    if (exactOrg?.verdict === "blocked") {
      const check = blockedCheck(name, exactOrg);
      checks.push(check);
      hold(
        component.id,
        check,
        "baseline.evidence-blocked",
        exactOrg.findings.map((finding) => finding.code),
      );
      continue;
    }
    if (exactOrg?.verdict === "pass") {
      checks.push({
        name,
        verdict: "pass",
        detail: `${component.id} matches signed org evidence from ${input.orgEvidence?.issuer}; user-side analyzer runtime not required`,
      });
      authorizations.push(authorization(input, component.id, actual, "org"));
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

  return { checks, authorizations, held };
}
