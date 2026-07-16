export const phaseASupportLevels = [
  "discoverable",
  "evaluable",
  "plannable",
  "mutation-research-eligible",
] as const;

export type PhaseASupportLevel = (typeof phaseASupportLevels)[number];

export function isPhaseASupportLevel(value: string): value is PhaseASupportLevel {
  return phaseASupportLevels.some((level) => level === value);
}

export const findingCodes = [
  "METHODOLOGY_INTENT_INVALID",
  "PROVIDER_UNKNOWN",
  "PROVIDER_SOURCE_UNRESOLVED",
  "PROVIDER_TRUST_HELD",
  "PROVIDER_TRUST_BLOCKED",
  "PROVIDER_CONFORMANCE_FAILED",
  "ADAPTER_COMPATIBILITY_UNKNOWN",
  "PROVIDER_CONTRACT_UNSUPPORTED",
  "HOST_LOAD_SURFACE_UNKNOWN",
  "HOST_UNSUPPORTED",
  "ISOLATION_UNSUPPORTED",
  "ISOLATION_CONFLICT",
  "UNOWNED_PROVIDER_CONFLICT",
  "INSTALLER_CONFINEMENT_UNPROVEN",
  "PROVIDER_SELF_UPDATE_ENABLED",
  "QUALIFICATION_PLAN_NONDETERMINISTIC",
  "QUALIFICATION_INCOMPLETE",
] as const;

export type MethodologyFindingCode = (typeof findingCodes)[number];

export interface EnrollmentState {
  enrollment: "unenrolled" | "selected-but-inactive";
  activation: "inactive";
  selectedProvider: string | undefined;
}

export function classifyEnrollment(selectedProvider: string | undefined): EnrollmentState {
  if (selectedProvider === undefined) {
    return { enrollment: "unenrolled", activation: "inactive", selectedProvider: undefined };
  }
  return {
    enrollment: "selected-but-inactive",
    activation: "inactive",
    selectedProvider,
  };
}
