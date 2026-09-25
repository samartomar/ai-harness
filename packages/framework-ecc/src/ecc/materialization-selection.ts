import {
  assertComponentSourcePath,
  assertMaterializedComponentId,
  type BaselineAuthorization,
  type BaselineHeldComponent,
  type BaselineVerificationResult,
  displaySafe,
  type EccComponentProvenance,
  type EffectiveOrgPolicy,
} from "@aihq/core/framework-host";
import type { EccComponentId } from "./components.js";
import { type EccStructuralRelationView, eccMandatoryRequirementIds } from "./selection-closure.js";

/**
 * F2: the policy's evidence-passed effective selection.
 *
 * Ruling 6 makes selection an intent stage: select, then evidence, then
 * install. This module is the resolver in between — it takes the org policy's
 * effective per-component selection (`governance.externalSelections`, carried
 * on `EffectiveOrgPolicy.externalSelections`) and the already-computed
 * evidence/vet state (`verifyBaselineComponents`'s `authorizations`/`held`),
 * and reports exactly which selected components are authorized to
 * materialize.
 *
 * A component that is selected but vet-blocked, or selected with no evidence
 * recorded at its pin, is never returned in `included` — the lifecycle's
 * input is the evidence-passed effective selection and nothing else — but it
 * is reported in `excluded` with its reason, so a caller can still show it:
 * visible and selectable, never materialized.
 *
 * `included` carries the id, authorization tuple, and provenance the
 * materialization engine's `EccMaterializationComponentInput` needs, copied
 * through unchanged. It deliberately omits `files`: mapping a component to
 * target-specific file content is the target adapter's job (F4), not this
 * resolver's, and this module never invents file content. A caller with a
 * target adapter attaches `files` to each entry to get a real
 * `EccMaterializationComponentInput`.
 */

export type EccSelectionExclusionReason =
  | "vet-blocked"
  | "no-evidence"
  | "malformed-selection"
  | "malformed-evidence"
  | "dependency-unavailable";

export interface EccSelectionExclusion {
  /** The raw selection id (`governance.externalSelections[].items[].id`). */
  id: string;
  kind: string;
  framework: "ecc" | "superpowers";
  reason: EccSelectionExclusionReason;
  /** Vet finding codes for a blocked component; empty for every other reason. */
  findingCodes: readonly string[];
  detail: string;
}

/**
 * The materialization engine's component input, minus `files` — see the
 * module header for why `files` is out of scope here.
 */
export interface EccEffectiveSelectionComponent {
  id: EccComponentId;
  authorization: BaselineAuthorization;
  provenance: EccComponentProvenance;
}

export type EccSelectionEvidence = Pick<BaselineVerificationResult, "authorizations" | "held">;

export interface EccEffectiveSelectionResult {
  included: EccEffectiveSelectionComponent[];
  excluded: EccSelectionExclusion[];
}

function excluded(
  item: { id: string; kind: string },
  framework: "ecc" | "superpowers",
  reason: EccSelectionExclusionReason,
  findingCodes: readonly string[],
  detail: string,
): EccSelectionExclusion {
  return { id: item.id, kind: item.kind, framework, reason, findingCodes, detail };
}

/** Reason and finding codes for a component evidence held back from passing. */
function heldReason(held: BaselineHeldComponent): {
  reason: EccSelectionExclusionReason;
  detail: string;
} {
  const reason: EccSelectionExclusionReason =
    held.routeCode === "baseline.evidence-blocked" ? "vet-blocked" : "no-evidence";
  return { reason, detail: held.details.join("; ") };
}

/**
 * Resolve the policy's evidence-passed effective selection: filter
 * `policy.externalSelections` down to the components whose evidence/vet state
 * passed, carrying each one's authorization tuple and provenance through
 * unchanged. Everything else is reported in `excluded` with a reason — never
 * silently dropped and never silently materialized.
 *
 * Fails closed throughout. Three cases exclude a selected component: its
 * evidence is held (blocked or missing/mismatched at the pin); its evidence
 * state is self-contradictory (both an authorization AND a held record exist
 * for the same id — never resolved by guessing which is current); or the
 * selection entry itself cannot resolve to a component id and source path the
 * materialization engine accepts. An id absent from BOTH the authorized and
 * held evidence is treated the same as "no evidence at the pin" — evidence
 * that says nothing is never read as a pass.
 *
 * Evidence that carries an organization decision (`authorization.acceptance`)
 * is included exactly like any other authorization: the source's own vet
 * pipeline (`verifyBaselineComponents`) places every exact signed component in
 * the same `authorizations` result whatever it found, and this resolver
 * carries the tuple through unchanged. Findings are labels for the reader,
 * never a second, stricter notion of "passed" here.
 */
export function resolveEccMaterializationSelection(
  policy: Pick<EffectiveOrgPolicy, "externalSelections">,
  evidence: EccSelectionEvidence,
  relations?: EccStructuralRelationView,
): EccEffectiveSelectionResult {
  const authorizationById = new Map(
    evidence.authorizations.map((authorization) => [authorization.componentId, authorization]),
  );
  const heldById = new Map(evidence.held.map((held) => [held.componentId, held]));

  const included: EccEffectiveSelectionComponent[] = [];
  const excludedItems: EccSelectionExclusion[] = [];

  for (const selection of policy.externalSelections) {
    if (selection.framework !== "ecc") continue;
    for (const item of selection.items) {
      const authorization = authorizationById.get(item.id);
      const held = heldById.get(item.id);

      if (authorization !== undefined && held !== undefined) {
        excludedItems.push(
          excluded(
            item,
            selection.framework,
            "malformed-evidence",
            held.codes,
            `${displaySafe(item.id)} has both a passed authorization and a held evidence record; refusing to guess which is current`,
          ),
        );
        continue;
      }

      if (held !== undefined) {
        const { reason, detail } = heldReason(held);
        excludedItems.push(excluded(item, selection.framework, reason, held.codes, detail));
        continue;
      }

      if (authorization === undefined) {
        excludedItems.push(
          excluded(
            item,
            selection.framework,
            "no-evidence",
            [],
            `no evidence recorded for ${displaySafe(item.id)} at ${displaySafe(item.source.repository)}@${item.source.commit.slice(0, 12)}`,
          ),
        );
        continue;
      }

      let id: EccComponentId;
      try {
        id = assertMaterializedComponentId(item.id) as EccComponentId;
      } catch (error) {
        excludedItems.push(
          excluded(item, selection.framework, "malformed-selection", [], (error as Error).message),
        );
        continue;
      }
      if (!id.startsWith(`${item.kind}:`)) {
        excludedItems.push(
          excluded(
            item,
            selection.framework,
            "malformed-selection",
            [],
            `selection kind ${displaySafe(item.kind)} does not match component id ${displaySafe(id)}`,
          ),
        );
        continue;
      }

      let provenance: EccComponentProvenance;
      try {
        provenance = {
          repository: item.source.repository,
          commit: item.source.commit,
          componentPath: assertComponentSourcePath(item.source.path),
        };
      } catch (error) {
        excludedItems.push(
          excluded(item, selection.framework, "malformed-selection", [], (error as Error).message),
        );
        continue;
      }

      included.push({ id, authorization, provenance });
    }
  }

  // Every included id passed assertMaterializedComponentId above before it can
  // reach the closure helper, which refuses (never returns an empty closure)
  // when it cannot compute requirements. Evidence is component-granular,
  // but structural module requirements are
  // not optional. Recompute closure after the evidence filter so a held or
  // malformed dependency cannot leave its dependent eligible to materialize.
  // Iterate to a fixed point because a removed dependency can itself be a
  // dependency of another selected component.
  let changed = true;
  while (changed) {
    changed = false;
    const includedIds = new Set<string>(included.map((component) => component.id));
    for (let index = included.length - 1; index >= 0; index -= 1) {
      const component = included[index];
      if (component === undefined) continue;
      const missing = eccMandatoryRequirementIds(component.id, relations).filter(
        (dependency) => !includedIds.has(dependency),
      );
      if (missing.length === 0) continue;
      included.splice(index, 1);
      includedIds.delete(component.id);
      excludedItems.push({
        id: component.id,
        kind: component.id.slice(0, component.id.indexOf(":")),
        framework: "ecc",
        reason: "dependency-unavailable",
        findingCodes: [],
        detail: `${displaySafe(component.id)} requires evidence-passed structural component(s) ${missing
          .map((dependency) => displaySafe(dependency))
          .join(", ")}`,
      });
      changed = true;
    }
  }

  return { included, excluded: excludedItems };
}
