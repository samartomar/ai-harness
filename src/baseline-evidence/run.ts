import { type Posture, postureFromContext } from "../config/posture.js";
import { AihError } from "../errors.js";
import {
  type Action,
  digest,
  type Plan,
  type PlanContext,
  type ProbeAction,
  plan,
  structuredChecksProbe,
} from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import type { AcceptanceTuple } from "./acceptance.js";
import type { BaselineCatalog } from "./catalog.js";
import type { OrgBaselineEvidence } from "./org.js";
import type { BaselineEvidenceLock } from "./schema.js";
import {
  type BaselineAuthorization,
  type BaselineComponentLabels,
  type BaselineHeldComponent,
  type BaselineVerificationResult,
  verifyBaselineComponents,
} from "./verify.js";

export interface CaptureBaselineGateInput {
  ctx: PlanContext;
  allowPartial?: boolean;
  sourceRoot: string;
  catalog: BaselineCatalog;
  componentIds: readonly string[];
  vendorLock: BaselineEvidenceLock;
  vendorLockSha256: string;
  expectedSourceTreeSha256?: string;
  orgEvidence?: OrgBaselineEvidence;
  /** When set, organization decisions for this exact tuple are attached to the evidence. */
  acceptanceTuple?: AcceptanceTuple;
}

export interface BaselineGate {
  allowPartial: boolean;
  sourceRoot: string;
  catalog: BaselineCatalog;
  componentIds: readonly string[];
  posture: Posture;
  vendorLock: BaselineEvidenceLock;
  vendorLockSha256: string;
  expectedSourceTreeSha256?: string;
  orgEvidence?: OrgBaselineEvidence;
  acceptanceTuple?: AcceptanceTuple;
  authorizations: BaselineAuthorization[];
  /** What the evidence found in each authorized component: labels, never a gate. */
  labels: BaselineComponentLabels[];
  /** Components whose bytes no signed evidence covers or matches. */
  held: BaselineHeldComponent[];
}

/** Signed evidence does not cover or match the bytes; findings never raise this. */
export class BaselineEvidenceIntegrityError extends AihError {
  readonly checks: Check[];

  constructor(checks: Check[]) {
    super(
      "signed baseline evidence does not cover or match the selected component bytes; install actions were not planned",
      "AIH_TRUST",
    );
    this.checks = checks;
  }
}

function failingChecks(checks: readonly Check[]): Check[] {
  return checks.filter((check) => check.verdict === "fail");
}

function heldFailureChecks(verification: BaselineVerificationResult): Check[] {
  return verification.held.map((held) => ({
    name: `baseline evidence ${held.componentId}`,
    verdict: "fail",
    code: held.routeCode,
    detail: held.details.join("; "),
  }));
}

function structuralFailureChecks(verification: BaselineVerificationResult): Check[] {
  return heldFailureChecks({
    ...verification,
    held: verification.held.filter((held) => held.routeCode === "baseline.evidence-mismatch"),
  });
}

function partialInstallChecks(verification: BaselineVerificationResult): Check[] {
  const held = new Map(verification.held.map((entry) => [entry.componentId, entry]));
  return verification.checks.map((check) => {
    const prefix = "baseline evidence ";
    const component = check.name.startsWith(prefix)
      ? held.get(check.name.slice(prefix.length))
      : undefined;
    if (component === undefined) return check;
    return {
      name: check.name,
      verdict: "skip",
      code: component.routeCode,
      detail: `held from install: ${component.details.join("; ")}`,
    };
  });
}

function heldDigest(held: readonly BaselineHeldComponent[]): Action {
  return digest(
    "held baseline components",
    held.map((component) => `${component.componentId}: ${component.codes.join(", ")}`).join("\n"),
    { held: [...held] },
  );
}

function countList(counts: readonly { code: string; count: number }[]): string {
  return counts
    .map((entry) => (entry.count === 1 ? entry.code : `${entry.code} x${entry.count}`))
    .join(", ");
}

/**
 * What the evidence found in the components being installed, for the reader.
 * Present only when some component carries findings or evidence problems; it
 * never changes what is installed.
 */
function labelDigest(labels: readonly BaselineComponentLabels[]): Action[] {
  const labelled = labels.filter(
    (label) => label.findings.length > 0 || label.evidenceProblems.length > 0,
  );
  if (labelled.length === 0) return [];
  return [
    digest(
      "baseline evidence labels",
      labelled
        .map((label) =>
          [
            `${label.componentId}: ${label.verdict}`,
            ...(label.findings.length > 0 ? [`findings: ${countList(label.findings)}`] : []),
            ...(label.evidenceProblems.length > 0
              ? [`evidence problems: ${countList(label.evidenceProblems)}`]
              : []),
          ].join("; "),
        )
        .join("\n"),
      { labels: labelled },
    ),
  ];
}

function verificationProbe(checks: readonly Check[]): ProbeAction {
  const all = [...checks];
  const action = structuredChecksProbe("baseline evidence gate", () => all);
  const decisive = failingChecks(all)[0] ??
    all[0] ?? {
      name: "baseline evidence gate",
      verdict: "pass" as const,
      detail: "no baseline components requested",
    };
  return { ...action, run: () => decisive };
}

export function captureBaselineGate(input: CaptureBaselineGateInput): BaselineGate {
  const posture = postureFromContext(input.ctx);
  const verification = verifyBaselineComponents({
    sourceRoot: input.sourceRoot,
    catalog: input.catalog,
    componentIds: input.componentIds,
    posture,
    vendorLock: input.vendorLock,
    vendorLockSha256: input.vendorLockSha256,
    expectedSourceTreeSha256: input.expectedSourceTreeSha256,
    orgEvidence: input.orgEvidence,
    acceptanceTuple: input.acceptanceTuple,
  });
  const structural = structuralFailureChecks(verification);
  if (structural.length > 0) throw new BaselineEvidenceIntegrityError(structural);
  if (input.allowPartial !== true && verification.held.length > 0) {
    const blocked = failingChecks(verification.checks);
    throw new BaselineEvidenceIntegrityError(
      blocked.length > 0 ? blocked : heldFailureChecks(verification),
    );
  }
  if (verification.authorizations.length === 0) {
    const blocked = failingChecks(verification.checks);
    throw new BaselineEvidenceIntegrityError(
      blocked.length > 0 ? blocked : heldFailureChecks(verification),
    );
  }
  return {
    allowPartial: input.allowPartial === true,
    sourceRoot: input.sourceRoot,
    catalog: input.catalog,
    componentIds: [...input.componentIds],
    posture,
    vendorLock: input.vendorLock,
    vendorLockSha256: input.vendorLockSha256,
    expectedSourceTreeSha256: input.expectedSourceTreeSha256,
    orgEvidence: input.orgEvidence,
    acceptanceTuple: input.acceptanceTuple,
    authorizations: verification.authorizations,
    labels: verification.labels,
    held: verification.held,
  };
}

export async function baselineInstallPhasePlan(
  _ctx: PlanContext,
  gate: BaselineGate,
  buildActions: (
    authorizations: readonly BaselineAuthorization[],
    held: readonly BaselineHeldComponent[],
    labels: readonly BaselineComponentLabels[],
  ) => readonly Action[] | Promise<readonly Action[]>,
): Promise<Plan> {
  const verification = verifyBaselineComponents({
    sourceRoot: gate.sourceRoot,
    catalog: gate.catalog,
    componentIds: gate.componentIds,
    posture: gate.posture,
    vendorLock: gate.vendorLock,
    vendorLockSha256: gate.vendorLockSha256,
    expectedSourceTreeSha256: gate.expectedSourceTreeSha256,
    orgEvidence: gate.orgEvidence,
    acceptanceTuple: gate.acceptanceTuple,
  });
  const structural = structuralFailureChecks(verification);
  if (structural.length > 0) {
    return plan(
      "baseline install: structural evidence failure",
      verificationProbe(structural),
      ...(verification.held.length > 0 ? [heldDigest(verification.held)] : []),
    );
  }
  if (!gate.allowPartial && verification.held.length > 0) {
    const blocked = failingChecks(verification.checks);
    return plan(
      "baseline install: evidence re-check",
      verificationProbe(blocked.length > 0 ? blocked : heldFailureChecks(verification)),
      heldDigest(verification.held),
    );
  }
  if (verification.authorizations.length === 0) {
    return plan(
      "baseline install: evidence re-check",
      verificationProbe(heldFailureChecks(verification)),
      ...(verification.held.length > 0 ? [heldDigest(verification.held)] : []),
    );
  }
  const evidenceProbe = verificationProbe(partialInstallChecks(verification));
  // The SAME verification the probe above reports: authorizations, held records
  // and labels come from one run, so a caller can never explain an install with
  // evidence the gate did not act on.
  const actions = await buildActions(
    verification.authorizations,
    verification.held,
    verification.labels,
  );
  return plan(
    "baseline install: evidence re-check + install",
    evidenceProbe,
    ...(verification.held.length > 0 ? [heldDigest(verification.held)] : []),
    ...labelDigest(verification.labels),
    ...actions,
  );
}
