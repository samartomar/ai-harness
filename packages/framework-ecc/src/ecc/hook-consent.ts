import { existsSync } from "node:fs";
import { join } from "node:path";

export type EccHookConsentDecision = "enabled" | "declined";

type ModuleLoader = (path: string) => unknown;

interface HookConsentPlanShape {
  hookConsent?: unknown;
  selectedModuleIds?: unknown;
  excludedModuleIds?: unknown;
  statePreview?: {
    request?: { hookConsent?: unknown };
    resolution?: { selectedModules?: unknown };
  };
}

interface HookConsentModule {
  withHookConsent(plan: object, hookConsent: EccHookConsentDecision): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function assertAdaptedPlan(
  value: unknown,
  original: HookConsentPlanShape,
  decision: EccHookConsentDecision,
): asserts value is HookConsentPlanShape {
  if (!isRecord(value)) throw new Error("invalid ECC upstream hook consent plan");
  const plan = value as HookConsentPlanShape;
  if (
    plan.hookConsent !== decision ||
    !isRecord(plan.statePreview) ||
    !isRecord(plan.statePreview.request) ||
    plan.statePreview.request.hookConsent !== decision
  ) {
    throw new Error("ECC upstream hook consent decision/state drift");
  }
  const selected = plan.selectedModuleIds;
  const stateSelected = plan.statePreview.resolution?.selectedModules;
  if (
    !stringArray(selected) ||
    !stringArray(stateSelected) ||
    selected.length !== stateSelected.length ||
    selected.some((moduleId, index) => moduleId !== stateSelected[index])
  ) {
    throw new Error("ECC upstream hook consent selected-module drift");
  }
  if (decision !== "declined") return;
  if (selected.includes("hooks-runtime")) {
    throw new Error("ECC upstream declined hook consent retained hooks-runtime");
  }
  if (
    stringArray(original.selectedModuleIds) &&
    original.selectedModuleIds.includes("hooks-runtime") &&
    (!stringArray(plan.excludedModuleIds) || !plan.excludedModuleIds.includes("hooks-runtime"))
  ) {
    throw new Error("ECC upstream declined hook consent did not exclude hooks-runtime");
  }
}

/**
 * Adapt a manifest plan only when the verified checkout exposes ECC's consent
 * helper. Its absence is the qualified legacy contract and leaves the plan
 * byte-for-byte untouched.
 */
export function applyEccUpstreamHookConsent<Plan extends object>(
  plan: Plan,
  sourceRoot: string,
  decision: EccHookConsentDecision,
  loadModule: ModuleLoader,
): Plan {
  const helperPath = join(sourceRoot, "scripts", "lib", "install", "hook-consent.js");
  if (!existsSync(helperPath)) return plan;
  const loaded = loadModule(helperPath);
  if (!isRecord(loaded) || typeof loaded.withHookConsent !== "function") {
    throw new Error("invalid ECC upstream hook consent helper");
  }
  const adapted = (loaded as unknown as HookConsentModule).withHookConsent(plan, decision);
  assertAdaptedPlan(adapted, plan, decision);
  return adapted as Plan;
}

/** Shared CommonJS adapter embedded in the verified and Codex fallback drivers. */
export const ECC_UPSTREAM_HOOK_CONSENT_ADAPTER_SOURCE = `
function applyEccUpstreamHookConsent(plan, sourceRoot, decision) {
  if (decision !== "enabled" && decision !== "declined") throw new Error("invalid ECC executable consent");
  const helperPath = path.join(sourceRoot, "scripts", "lib", "install", "hook-consent.js");
  if (!fs.existsSync(helperPath)) return plan;
  const helper = require(helperPath);
  if (!helper || typeof helper !== "object" || typeof helper.withHookConsent !== "function") throw new Error("invalid ECC upstream hook consent helper");
  const adapted = helper.withHookConsent(plan, decision);
  if (!adapted || typeof adapted !== "object" || Array.isArray(adapted)) throw new Error("invalid ECC upstream hook consent plan");
  if (adapted.hookConsent !== decision || !adapted.statePreview || !adapted.statePreview.request || adapted.statePreview.request.hookConsent !== decision) throw new Error("ECC upstream hook consent decision/state drift");
  const strings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");
  const selected = adapted.selectedModuleIds;
  const stateSelected = adapted.statePreview.resolution && adapted.statePreview.resolution.selectedModules;
  if (!strings(selected) || !strings(stateSelected) || selected.length !== stateSelected.length || selected.some((moduleId, index) => moduleId !== stateSelected[index])) throw new Error("ECC upstream hook consent selected-module drift");
  if (decision === "declined") {
    if (selected.includes("hooks-runtime")) throw new Error("ECC upstream declined hook consent retained hooks-runtime");
    if (strings(plan.selectedModuleIds) && plan.selectedModuleIds.includes("hooks-runtime") && (!strings(adapted.excludedModuleIds) || !adapted.excludedModuleIds.includes("hooks-runtime"))) throw new Error("ECC upstream declined hook consent did not exclude hooks-runtime");
  }
  return adapted;
}
`;
