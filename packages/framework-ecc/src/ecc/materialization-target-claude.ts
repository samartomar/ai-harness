import type { EccEffectiveSelectionComponent } from "./materialization-selection.js";
import {
  type EccTargetRefusal,
  type EccTargetRefusalReason,
  resolveEccTargetMaterialization,
} from "./materialization-target.js";
import type { EccMaterializationComponentInput } from "./materialization-types.js";

/**
 * F4, first target: the Claude binding of the target-parameterized adapter.
 *
 * Everything this module used to do now lives in `materialization-target.ts`,
 * which answers the same question for any governed target. What remains here is
 * the Claude BINDING: the target constant, and the single-target entry point
 * whose result shape carries no target field because there is only one. The
 * behavior is unchanged — same destinations, same refusal reasons, same refusal
 * text — because it is the same code with `claude` supplied for the target.
 *
 * Keeping this entry point is deliberate. The acceptance journey and the Claude
 * adapter suite pin its exact result, including the verbatim refusal text, and a
 * generalization that quietly rewrote either would be a change to shipped
 * behavior wearing a refactor's clothes.
 */

/** The target this binding supplies. Every other target goes through the resolver. */
export const CLAUDE_MATERIALIZATION_TARGET = "claude";

export type { EccTargetRefusal, EccTargetRefusalReason };

export interface EccClaudeMaterializationRequest {
  /** Absolute path to the checkout holding the pinned framework content. */
  sourceRoot: string;
  /** The F2 resolver's evidence-passed components, carried through unchanged. */
  components: readonly EccEffectiveSelectionComponent[];
}

export interface EccClaudeMaterializationResult {
  /** Ready for `EccMaterializationRequest.components` — nothing else to attach. */
  components: EccMaterializationComponentInput[];
  refused: EccTargetRefusal[];
}

/**
 * Map evidence-passed components onto the Claude target: the `components` half
 * is a complete `EccMaterializationRequest.components`, and the `refused` half
 * names every component that stays visible and unmaterialized, with its reason.
 */
export function resolveEccClaudeMaterialization(
  request: EccClaudeMaterializationRequest,
): EccClaudeMaterializationResult {
  const result = resolveEccTargetMaterialization({
    sourceRoot: request.sourceRoot,
    targets: [CLAUDE_MATERIALIZATION_TARGET],
    components: request.components,
  });
  return {
    components: result.components,
    // Dropped rather than spread through: with one target the field carries no
    // information, and the journey pins this object exactly.
    refused: result.refused.map((entry) => ({
      id: entry.id,
      reason: entry.reason,
      detail: entry.detail,
    })),
  };
}
