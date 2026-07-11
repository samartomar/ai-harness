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
import type { BaselineCatalog } from "./catalog.js";
import type { OrgBaselineEvidence } from "./org.js";
import type { BaselineEvidenceLock } from "./schema.js";
import {
  type BaselineAuthorization,
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
  orgEvidence?: OrgBaselineEvidence;
}

export interface BaselineGate {
  allowPartial: boolean;
  sourceRoot: string;
  catalog: BaselineCatalog;
  componentIds: readonly string[];
  posture: Posture;
  vendorLock: BaselineEvidenceLock;
  vendorLockSha256: string;
  orgEvidence?: OrgBaselineEvidence;
  authorizations: BaselineAuthorization[];
  held: BaselineHeldComponent[];
}

export class BaselineEvidenceBlockedError extends AihError {
  readonly checks: Check[];

  constructor(checks: Check[]) {
    super("baseline evidence gate blocked; install actions were not planned", "AIH_TRUST");
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
    orgEvidence: input.orgEvidence,
  });
  const structural = structuralFailureChecks(verification);
  if (structural.length > 0) throw new BaselineEvidenceBlockedError(structural);
  if (input.allowPartial !== true && verification.held.length > 0) {
    const blocked = failingChecks(verification.checks);
    throw new BaselineEvidenceBlockedError(
      blocked.length > 0 ? blocked : heldFailureChecks(verification),
    );
  }
  if (verification.authorizations.length === 0) {
    const blocked = failingChecks(verification.checks);
    throw new BaselineEvidenceBlockedError(
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
    orgEvidence: input.orgEvidence,
    authorizations: verification.authorizations,
    held: verification.held,
  };
}

export async function baselineInstallPhasePlan(
  _ctx: PlanContext,
  gate: BaselineGate,
  buildActions: (
    authorizations: readonly BaselineAuthorization[],
  ) => readonly Action[] | Promise<readonly Action[]>,
): Promise<Plan> {
  const verification = verifyBaselineComponents({
    sourceRoot: gate.sourceRoot,
    catalog: gate.catalog,
    componentIds: gate.componentIds,
    posture: gate.posture,
    vendorLock: gate.vendorLock,
    vendorLockSha256: gate.vendorLockSha256,
    orgEvidence: gate.orgEvidence,
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
  const actions = await buildActions(verification.authorizations);
  return plan(
    "baseline install: evidence re-check + install",
    evidenceProbe,
    ...(verification.held.length > 0 ? [heldDigest(verification.held)] : []),
    ...actions,
  );
}
