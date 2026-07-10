import type { Posture } from "../config/posture.js";
import type { Check } from "../internals/verify.js";
import { type BaselineCatalog, resolveCatalogComponents } from "./catalog.js";
import { hashComponentTree } from "./hash.js";
import type { BaselineEvidenceLock } from "./schema.js";

export interface BaselineAuthorization {
  componentId: string;
  source: string;
  pinnedSha: string;
  treeSha256: string;
  tier: "vendor";
  issuer: "@aihq/harness release";
  evidenceSha256: string;
}

export interface VerifyBaselineComponentsInput {
  sourceRoot: string;
  catalog: BaselineCatalog;
  componentIds: readonly string[];
  posture: Posture;
  vendorLock: BaselineEvidenceLock;
  vendorLockSha256: string;
}

export interface BaselineVerificationResult {
  checks: Check[];
  authorizations: BaselineAuthorization[];
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

export function verifyBaselineComponents(
  input: VerifyBaselineComponentsInput,
): BaselineVerificationResult {
  const components = resolveCatalogComponents(input.catalog, input.componentIds);
  const sourceName = `${input.catalog.owner}/${input.catalog.repo}`;
  const sourceEvidence = input.vendorLock.sources.find(
    (source) =>
      source.id === input.catalog.id &&
      source.owner === input.catalog.owner &&
      source.repo === input.catalog.repo &&
      source.pinnedSha === input.catalog.pinnedSha,
  );
  const checks: Check[] = [];
  const authorizations: BaselineAuthorization[] = [];

  for (const component of components) {
    const name = `baseline evidence ${component.id}`;
    const evidence = sourceEvidence?.components.find((candidate) => candidate.id === component.id);
    if (evidence === undefined) {
      checks.push(
        warningOrFailure(
          input.posture,
          name,
          `${sourceName}@${input.catalog.pinnedSha.slice(0, 12)} component ${component.id} is not covered by the shipped vendor lock`,
          "baseline.evidence-missing",
        ),
      );
      continue;
    }
    if (!sameStrings(evidence.paths, component.paths)) {
      checks.push(
        warningOrFailure(
          input.posture,
          name,
          `${component.id} catalog paths differ from the signed vendor entry`,
          "baseline.evidence-mismatch",
        ),
      );
      continue;
    }
    const actual = hashComponentTree(input.sourceRoot, component.paths).treeSha256;
    if (actual !== evidence.treeSha256) {
      checks.push(
        warningOrFailure(
          input.posture,
          name,
          `${component.id} content hash ${actual} does not match signed ${evidence.treeSha256}`,
          "baseline.evidence-mismatch",
        ),
      );
      continue;
    }
    if (evidence.verdict === "blocked") {
      const codes = [...new Set(evidence.findings.map((finding) => finding.code))].join(", ");
      checks.push({
        name,
        verdict: "fail",
        code: "baseline.evidence-blocked",
        detail: `${component.id} is blocked by signed vendor evidence (${codes || "trust finding"}); fix and vet a new pin — org evidence cannot waive this verdict`,
      });
      continue;
    }
    checks.push({
      name,
      verdict: "pass",
      detail: `${component.id} matches signed vendor evidence; user-side analyzer runtime not required`,
    });
    authorizations.push({
      componentId: component.id,
      source: sourceName,
      pinnedSha: input.catalog.pinnedSha,
      treeSha256: actual,
      tier: "vendor",
      issuer: "@aihq/harness release",
      evidenceSha256: input.vendorLockSha256,
    });
  }

  return { checks, authorizations };
}
