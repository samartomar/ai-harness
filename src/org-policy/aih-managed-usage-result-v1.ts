import type { PlanResult } from "../internals/execute.js";
import { VerificationReport } from "../internals/verify.js";

export interface AihManagedUsageResultDomainV1 {
  readonly outcome: "fulfilled" | "partial" | "refused" | "reported-only";
  readonly reason?: string;
}

export interface AihManagedUsageResultInspectionV1 {
  readonly state:
    | "absent"
    | "claimed"
    | "configured"
    | "revoking"
    | "revoked"
    | "drifted"
    | "invalid";
}

/** Preserve every committed phase while making non-effective custody fail closed. */
export function aihManagedUsagePlanResultV1(
  domain: AihManagedUsageResultDomainV1,
  inspection: AihManagedUsageResultInspectionV1,
  phases: readonly PlanResult[],
): PlanResult {
  const report = new VerificationReport();
  const effective =
    domain.outcome === "fulfilled" &&
    (inspection.state === "configured" || inspection.state === "revoked");
  if (effective)
    report.pass("AIH-managed usage adapter", "current V4 ownership receipt and outputs are exact");
  else if (
    domain.outcome === "reported-only" &&
    domain.reason === undefined &&
    (inspection.state === "absent" || inspection.state === "configured")
  )
    report.pass("AIH-managed usage adapter preview", "qualified preview is non-effective");
  else
    report.fail(
      "AIH-managed usage adapter",
      `non-effective state: outcome=${domain.outcome}; receipt=${inspection.state}${domain.reason === undefined ? "" : `; reason=${domain.reason}`}`,
    );
  return {
    capability: "policy usage-metering",
    applied: phases.some((phase) => phase.applied),
    writes: phases.flatMap((phase) => phase.writes),
    docs: phases.flatMap((phase) => phase.docs),
    probes: phases.flatMap((phase) => phase.probes),
    execs: phases.flatMap((phase) => phase.execs),
    digests: [
      ...phases.flatMap((phase) => phase.digests),
      {
        describe: "AIH-managed usage adapter result",
        text: JSON.stringify(domain),
        data: { domain, inspection },
      },
    ],
    backups: phases.flatMap((phase) => phase.backups),
    removed: phases.flatMap((phase) => phase.removed),
    report,
  };
}
