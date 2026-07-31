import {
  dispositionForTrustFinding,
  type NormalizedTrustFinding,
  TRUST_POLICY_VERSION,
  type TrustPolicyDisposition,
  type TrustPolicyLevel,
} from "../trust/evidence.js";
import type { BaselineCatalog } from "./catalog.js";

export const ECC_LEAN_PROFILE_ID = "ecc-lean-v1";
export const ECC_UPSTREAM_CORE_PROFILE_ID = "ecc-upstream-core-v2.1.0";
export const ECC_UPSTREAM_FULL_PROFILE_ID = "ecc-upstream-full-v2.1.0";
export const SUPERPOWERS_STANDARD_PROFILE_ID = "superpowers-standard-v1";

export const ECC_LEAN_EVIDENCE_COMPONENTS = [
  "runtime:ecc-installer",
  "baseline:rules",
  "agent:planner",
  "skill:tdd-workflow",
  "agent:tdd-guide",
  "agent:build-error-resolver",
  "agent:code-reviewer",
  "agent:security-reviewer",
  "skill:security-review",
  "skill:verification-loop",
] as const;

export const ECC_UPSTREAM_CORE_EVIDENCE_COMPONENTS = [
  "runtime:ecc-installer",
  "module:rules-core",
  "module:agents-core",
  "module:commands-core",
  "module:hooks-runtime",
  "module:platform-configs",
  "module:skill-unified-memory",
  "module:workflow-quality",
] as const;

export interface QualificationProfile {
  id: string;
  sourceId: string;
  origin: "AIH_CURATED" | "UPSTREAM";
  selectedComponentIds: readonly string[];
}

export function qualificationProfile(
  catalog: BaselineCatalog,
  profileId: string,
): QualificationProfile {
  if (catalog.id === "ecc" && profileId === ECC_LEAN_PROFILE_ID) {
    return {
      id: profileId,
      sourceId: catalog.id,
      origin: "AIH_CURATED",
      selectedComponentIds: ECC_LEAN_EVIDENCE_COMPONENTS,
    };
  }
  if (catalog.id === "ecc" && profileId === ECC_UPSTREAM_CORE_PROFILE_ID) {
    return {
      id: profileId,
      sourceId: catalog.id,
      origin: "UPSTREAM",
      selectedComponentIds: ECC_UPSTREAM_CORE_EVIDENCE_COMPONENTS,
    };
  }
  if (catalog.id === "ecc" && profileId === ECC_UPSTREAM_FULL_PROFILE_ID) {
    return {
      id: profileId,
      sourceId: catalog.id,
      origin: "UPSTREAM",
      selectedComponentIds: catalog.components.map((component) => component.id),
    };
  }
  if (catalog.id === "superpowers" && profileId === SUPERPOWERS_STANDARD_PROFILE_ID) {
    return {
      id: profileId,
      sourceId: catalog.id,
      origin: "UPSTREAM",
      selectedComponentIds: catalog.components.map((component) => component.id),
    };
  }
  throw new Error(`unsupported qualification profile ${catalog.id}/${profileId}`);
}

export interface ComponentQualificationEvidence {
  id: string;
  findings: readonly NormalizedTrustFinding[];
  dispositions: readonly TrustPolicyDisposition[];
}

export interface QualificationReason {
  componentId: string;
  level: Exclude<TrustPolicyLevel, "INFORMATIONAL" | "SUPPRESSED">;
  code?: string;
  detail: string;
  path?: string;
  line?: number;
  value?: string;
  fingerprint: string;
}

export interface ComponentInventoryStatus {
  id: string;
  discovery: "DISCOVERED";
  selection: "SELECTED" | "NOT SELECTED";
  authorization: "AUTHORIZED" | "NOT AUTHORIZED";
  installation: "NOT INSTALLED";
}

export interface ActiveProfileQualification {
  profile: string;
  verdict: "PASS" | "REVIEW" | "BLOCK";
  selectedComponents: string[];
  componentCounts: { pass: number; review: number; block: number };
  findingCounts: { warn: number; review: number; block: number };
  genuineReasons: QualificationReason[];
  inventory: ComponentInventoryStatus[];
  policyDecision: string;
  runtimeRestrictions: string[];
}

function findingByFingerprint(
  component: ComponentQualificationEvidence,
  fingerprint: string,
): NormalizedTrustFinding | undefined {
  return component.findings.find((finding) => finding.fingerprint === fingerprint);
}

export function qualifyActiveProfile(
  catalog: BaselineCatalog,
  profile: QualificationProfile,
  componentEvidence: readonly ComponentQualificationEvidence[],
): ActiveProfileQualification {
  const selected = new Set(profile.selectedComponentIds);
  const evidenceById = new Map<string, ComponentQualificationEvidence>();
  for (const component of componentEvidence) {
    if (evidenceById.has(component.id)) {
      throw new Error(`duplicate active profile component evidence: ${component.id}`);
    }
    evidenceById.set(component.id, component);
  }
  const missing = profile.selectedComponentIds.filter((id) => !evidenceById.has(id));
  if (missing.length > 0) {
    throw new Error(`active profile evidence missing selected components: ${missing.join(", ")}`);
  }

  const genuineReasons: QualificationReason[] = [];
  let warn = 0;
  let review = 0;
  let block = 0;
  const componentCounts = { pass: 0, review: 0, block: 0 };
  for (const componentId of profile.selectedComponentIds) {
    const component = evidenceById.get(componentId);
    if (component === undefined) continue;
    const findingFingerprints = new Set<string>();
    for (const finding of component.findings) {
      if (findingFingerprints.has(finding.fingerprint)) {
        throw new Error(`duplicate normalized finding fingerprint: ${finding.fingerprint}`);
      }
      findingFingerprints.add(finding.fingerprint);
    }
    const dispositionByFingerprint = new Map<string, TrustPolicyDisposition>();
    for (const disposition of component.dispositions) {
      if (disposition.policyVersion !== TRUST_POLICY_VERSION) {
        throw new Error(
          `stale trust policy disposition ${disposition.findingFingerprint}: ${disposition.policyVersion}`,
        );
      }
      if (dispositionByFingerprint.has(disposition.findingFingerprint)) {
        throw new Error(
          `duplicate policy disposition fingerprint: ${disposition.findingFingerprint}`,
        );
      }
      dispositionByFingerprint.set(disposition.findingFingerprint, disposition);
    }
    for (const finding of component.findings) {
      const supplied = dispositionByFingerprint.get(finding.fingerprint);
      const expected = dispositionForTrustFinding(finding);
      if (supplied === undefined) {
        throw new Error(`normalized finding has no policy disposition: ${finding.fingerprint}`);
      }
      if (supplied.level !== expected.level || supplied.policyVersion !== expected.policyVersion) {
        throw new Error(`policy disposition contradicts current policy: ${finding.fingerprint}`);
      }
    }
    for (const fingerprint of dispositionByFingerprint.keys()) {
      if (!findingFingerprints.has(fingerprint)) {
        throw new Error(`policy disposition has no normalized finding: ${fingerprint}`);
      }
    }
    let componentLevel: "PASS" | "REVIEW" | "BLOCK" = "PASS";
    for (const disposition of component.dispositions) {
      if (disposition.level === "BLOCK") componentLevel = "BLOCK";
      else if (disposition.level === "REVIEW" && componentLevel !== "BLOCK") {
        componentLevel = "REVIEW";
      }
      if (disposition.level === "WARN") warn++;
      if (disposition.level === "REVIEW") review++;
      if (disposition.level === "BLOCK") block++;
      if (!["WARN", "REVIEW", "BLOCK"].includes(disposition.level)) continue;
      const finding = findingByFingerprint(component, disposition.findingFingerprint);
      if (finding === undefined) continue;
      genuineReasons.push({
        componentId,
        level: disposition.level as "WARN" | "REVIEW" | "BLOCK",
        ...(finding.code === undefined ? {} : { code: finding.code }),
        detail: finding.detail,
        ...(finding.location === undefined ? {} : { path: finding.location.uri }),
        ...(finding.location?.startLine === undefined ? {} : { line: finding.location.startLine }),
        ...(finding.sourceValue === undefined ? {} : { value: finding.sourceValue }),
        fingerprint: finding.fingerprint,
      });
    }
    componentCounts[componentLevel.toLowerCase() as "pass" | "review" | "block"]++;
  }

  const verdict = block > 0 ? "BLOCK" : review > 0 ? "REVIEW" : "PASS";
  return {
    profile: profile.id,
    verdict,
    selectedComponents: [...profile.selectedComponentIds],
    componentCounts,
    findingCounts: { warn, review, block },
    genuineReasons,
    inventory: catalog.components.map((component) => {
      const isSelected = selected.has(component.id);
      return {
        id: component.id,
        discovery: "DISCOVERED",
        selection: isSelected ? "SELECTED" : "NOT SELECTED",
        authorization: isSelected && verdict === "PASS" ? "AUTHORIZED" : "NOT AUTHORIZED",
        installation: "NOT INSTALLED",
      };
    }),
    policyDecision:
      verdict === "PASS"
        ? "active profile may proceed to the bounded install journey; no framework acceptance was used"
        : verdict === "REVIEW"
          ? "active profile is not authorized until genuine residual review findings receive an exact-pin decision"
          : "active profile is blocked by genuine executable, integrity, or mandatory-coverage danger",
    runtimeRestrictions: [
      "exact source pin and component-tree identity required",
      "only selected profile components may materialize or load",
      "network and credential use denied unless explicitly reviewed",
      "destructive automatic execution denied",
      "install remains provisional until remove and rollback evidence pass",
    ],
  };
}
