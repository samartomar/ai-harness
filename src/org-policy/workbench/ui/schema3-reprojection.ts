import type { WorkbenchStateV1 } from "../contracts.js";

/**
 * The schema-3 re-projection both admin shells run after a policy change
 * (main.ts): an accepted schema-3 policy is projected through the prepared
 * catalog and restored, so its compatibility fields always match its pinned
 * selections. The caller owns the re-entrancy guard around `restore`.
 */
export interface Schema3ReprojectionSteps {
  importSelections(policy: unknown): {
    accepted: boolean;
    state: WorkbenchStateV1;
    diagnostics: readonly string[];
  };
  project(
    policy: Record<string, unknown>,
    state: WorkbenchStateV1,
  ): { accepted: boolean; policy: unknown; diagnostics: readonly string[] };
  /** Replace the session policy; throws when the policy is rejected. */
  restore(policy: unknown): void;
}

export interface Schema3ReprojectionOutcome {
  state: WorkbenchStateV1;
  diagnostics: string[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function reprojectSchema3Policy(
  snapshot: unknown,
  steps: Schema3ReprojectionSteps,
): Schema3ReprojectionOutcome {
  const imported = steps.importSelections(snapshot);
  const outcome = { state: imported.state, diagnostics: [...imported.diagnostics] };
  const basePolicy = object(snapshot);
  if (!imported.accepted || basePolicy === undefined || basePolicy.schemaVersion !== 3)
    return outcome;
  const projected = steps.project(basePolicy, imported.state);
  if (!projected.accepted) {
    outcome.diagnostics.push(...projected.diagnostics);
    return outcome;
  }
  try {
    steps.restore(projected.policy);
  } catch (error) {
    outcome.diagnostics.push(
      error instanceof Error ? error.message : "Policy update was rejected.",
    );
  }
  return outcome;
}
