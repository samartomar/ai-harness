import type { HostCoverage } from "./contracts/host.js";
import type { PhaseASupportLevel } from "./state.js";

export interface QualificationResult {
  classification: "QUALIFICATION_PASS" | "QUALIFICATION_FAIL_CLOSED" | "QUALIFICATION_BLOCKED";
  supportLevel: PhaseASupportLevel;
  findings: readonly string[];
  providerCodeExecuted: false;
}

export function qualifyMethodology(input: {
  compatibility: "supported" | "unknown";
  hostCoverage: HostCoverage;
  isolation: "proven" | "conflict" | "unknown";
  selfUpdater: boolean;
}): QualificationResult {
  if (input.compatibility === "unknown") {
    return {
      classification: "QUALIFICATION_BLOCKED",
      supportLevel: "plannable",
      findings: ["ADAPTER_COMPATIBILITY_UNKNOWN"],
      providerCodeExecuted: false,
    };
  }
  if (input.hostCoverage === "unknown" || input.isolation === "unknown") {
    return {
      classification: "QUALIFICATION_BLOCKED",
      supportLevel: "plannable",
      findings: [
        input.hostCoverage === "unknown" ? "HOST_LOAD_SURFACE_UNKNOWN" : "QUALIFICATION_INCOMPLETE",
      ],
      providerCodeExecuted: false,
    };
  }
  if (input.isolation === "conflict" || input.selfUpdater) {
    return {
      classification: "QUALIFICATION_FAIL_CLOSED",
      supportLevel: "plannable",
      findings: [
        input.isolation === "conflict" ? "ISOLATION_CONFLICT" : "PROVIDER_SELF_UPDATE_ENABLED",
      ],
      providerCodeExecuted: false,
    };
  }
  return {
    classification: "QUALIFICATION_PASS",
    supportLevel: "plannable",
    findings: [],
    providerCodeExecuted: false,
  };
}
