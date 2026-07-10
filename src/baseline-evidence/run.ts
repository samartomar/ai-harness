import { type Posture, postureFromContext } from "../config/posture.js";
import { AihError } from "../errors.js";
import {
  type Action,
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
import { type BaselineAuthorization, verifyBaselineComponents } from "./verify.js";

export interface CaptureBaselineGateInput {
  ctx: PlanContext;
  sourceRoot: string;
  catalog: BaselineCatalog;
  componentIds: readonly string[];
  vendorLock: BaselineEvidenceLock;
  vendorLockSha256: string;
  orgEvidence?: OrgBaselineEvidence;
}

export interface ClearedBaselineGate {
  sourceRoot: string;
  catalog: BaselineCatalog;
  componentIds: readonly string[];
  posture: Posture;
  vendorLock: BaselineEvidenceLock;
  vendorLockSha256: string;
  orgEvidence?: OrgBaselineEvidence;
  authorizations: BaselineAuthorization[];
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

export function captureClearedBaselineGate(input: CaptureBaselineGateInput): ClearedBaselineGate {
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
  const blocked = failingChecks(verification.checks);
  if (blocked.length > 0) throw new BaselineEvidenceBlockedError(blocked);
  return {
    sourceRoot: input.sourceRoot,
    catalog: input.catalog,
    componentIds: [...input.componentIds],
    posture,
    vendorLock: input.vendorLock,
    vendorLockSha256: input.vendorLockSha256,
    orgEvidence: input.orgEvidence,
    authorizations: verification.authorizations,
  };
}

export async function baselineInstallPhasePlan(
  _ctx: PlanContext,
  gate: ClearedBaselineGate,
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
  const evidenceProbe = verificationProbe(verification.checks);
  if (failingChecks(verification.checks).length > 0) {
    return plan("baseline install: evidence re-check", evidenceProbe);
  }
  const actions = await buildActions(verification.authorizations);
  return plan("baseline install: evidence re-check + install", evidenceProbe, ...actions);
}
