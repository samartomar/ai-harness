import type { BaselineCatalog } from "../baseline-evidence/catalog.js";
import {
  type BaselineEvidencePipelineDeps,
  executeBaselineEvidencePipeline,
} from "../baseline-evidence/pipeline.js";
import type { BaselineAuthorization, BaselineHeldComponent } from "../baseline-evidence/verify.js";
import { AihError } from "../errors.js";
import type { PlanResult } from "../internals/execute.js";
import { digest, type Plan, type PlanContext, plan } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { resolveEffectiveOrgPolicy } from "../org-policy/effective.js";
import type { OrgPolicy } from "../org-policy/schema.js";
import type { TrustSource } from "../trust/fetch.js";
import {
  applyEccMaterialization,
  type EccMaterializationAdvisory,
  type EccMaterializationFilePlan,
  previewEccMaterialization,
} from "./materialization.js";
import {
  type EccSelectionExclusion,
  resolveEccMaterializationSelection,
} from "./materialization-selection.js";
import {
  type EccTargetRefusal,
  resolveEccClaudeMaterialization,
} from "./materialization-target-claude.js";

/**
 * F6: `aih ecc --lifecycle install` in a governed repository.
 *
 * Every part of the governed framework lifecycle already exists — the effective
 * policy reader, the evidence-passed selection resolver (F2), the Claude target
 * adapter (F4) and the AIH-direct materialization engine (F1/F5). This module is
 * the only thing that was missing: the route an operator can actually take to
 * them. It composes them in exactly the order the acceptance journey walks
 * (`tests/ecc/acceptance-governed-lifecycle.test.ts`) and adds no behavior of
 * its own — a second copy of any of those decisions would be free to drift from
 * the one the journey pins.
 *
 * Evidence is not optional and not re-derived here. The install runs through
 * `executeBaselineEvidencePipeline`, which acquires the exact pinned source,
 * verifies it, and hands this module the sourceRoot plus the authorizations and
 * held records from that one verification. `allowPartial` is set because a
 * governed selection is expected to contain components the vet blocked or never
 * recorded: the resolver reports each one with its reason instead of failing the
 * whole run, which is what "visible and selectable, never materialized" means.
 *
 * Preview-first is the harness's own `--apply` gate and nothing else: without it
 * the chain plans and reports; with it the same chain applies. There is no
 * second preview flag, and this module never writes outside the engine.
 */

/** The framework this lifecycle materializes. Superpowers is a later row. */
const GOVERNED_FRAMEWORK = "ecc";

export interface GovernedEccMaterializationInput {
  catalog: BaselineCatalog;
  source: TrustSource;
  /** The parsed governed policy, already read through the product's own reader. */
  policy: OrgPolicy;
}

/** One normalized report for both halves of the `--apply` gate. */
interface GovernedMaterializationReport {
  root: string;
  applied: boolean;
  write: EccMaterializationFilePlan[];
  subtract: EccMaterializationFilePlan[];
  advisories: EccMaterializationAdvisory[];
  excluded: EccSelectionExclusion[];
  refused: EccTargetRefusal[];
}

/**
 * The component ids the policy selected for this framework — the identity the
 * evidence gate verifies and the selection resolver matches on. An id the
 * catalog does not carry is refused here, by name: the alternative is a raw
 * catalog error that never mentions the policy the id came from.
 */
function selectedComponentIds(policy: OrgPolicy, catalog: BaselineCatalog): string[] {
  const selected = new Set<string>();
  for (const selection of policy.governance?.externalSelections ?? []) {
    if (selection.framework !== GOVERNED_FRAMEWORK) continue;
    for (const item of selection.items) selected.add(item.id);
  }
  if (selected.size === 0) {
    throw new AihError(
      "refusing the governed ECC framework lifecycle: the policy selects no ECC component to materialize",
      "AIH_CONFIG",
    );
  }
  const known = new Set(catalog.components.map((component) => component.id));
  const unknown = [...selected].filter((id) => !known.has(id)).sort();
  if (unknown.length > 0) {
    throw new AihError(
      `refusing the governed ECC framework lifecycle: the policy selects component(s) the pinned ECC catalog does not carry: ${unknown.join(", ")}`,
      "AIH_CONFIG",
    );
  }
  return [...selected];
}

function reportBody(report: GovernedMaterializationReport): string {
  const verb = report.applied ? "wrote" : "would write";
  return lines(
    `Governed ECC framework materialization (${report.applied ? "applied" : "preview"}):`,
    ...report.write.map((file) => `  [${verb}] ${file.path} - ${file.componentId}`),
    ...report.subtract.map(
      (file) =>
        `  [${report.applied ? "removed" : "would remove"}] ${file.path} - ownership no longer selected`,
    ),
    ...(report.excluded.length > 0
      ? [
          "",
          "Selected, and not materialized - evidence is what admits a component:",
          ...report.excluded.map((entry) => `  [${entry.reason}] ${entry.id} - ${entry.detail}`),
        ]
      : []),
    ...(report.refused.length > 0
      ? [
          "",
          "Evidence-passed, and refused by the Claude target:",
          ...report.refused.map((entry) => `  [${entry.reason}] ${entry.id} - ${entry.detail}`),
        ]
      : []),
    ...(report.advisories.length > 0
      ? [
          "",
          "Manual review - owned destinations AIH could not act on:",
          ...report.advisories.map(
            (entry) => `  [${entry.reason}] ${entry.path} - ${entry.detail}`,
          ),
        ]
      : []),
    ...(report.applied ? [] : ["", "Dry-run: nothing was written; pass --apply to materialize."]),
  );
}

/**
 * Steps 2-5 of the journey, run against the verified source: resolve the
 * effective policy, resolve the evidence-passed effective selection, map it onto
 * the Claude target, and preview or apply.
 */
function governedMaterializationPlan(
  ctx: PlanContext,
  policy: OrgPolicy,
  sourceRoot: string,
  authorizations: readonly BaselineAuthorization[],
  held: readonly BaselineHeldComponent[],
): Plan {
  const effective = resolveEffectiveOrgPolicy(policy);
  const selection = resolveEccMaterializationSelection(effective, {
    authorizations: [...authorizations],
    held: [...held],
  });
  const target = resolveEccClaudeMaterialization({ sourceRoot, components: selection.included });
  const request = { root: ctx.root, components: target.components };
  // The ONLY preview-first gate. The engine writes on apply and plans on dry
  // run; nothing here re-implements either half.
  const outcome = ctx.apply ? applyEccMaterialization(request) : previewEccMaterialization(request);
  const report: GovernedMaterializationReport = {
    root: ctx.root,
    applied: ctx.apply,
    write: "written" in outcome ? outcome.written : outcome.write,
    subtract: "removed" in outcome ? outcome.removed : outcome.subtract,
    advisories: outcome.advisories,
    excluded: selection.excluded,
    refused: target.refused,
  };
  return plan(
    "ecc: governed framework materialization",
    digest("governed ECC framework materialization", reportBody(report), report),
  );
}

/**
 * Run the governed framework lifecycle's install verb. The caller has already
 * proved the repository is governed and resolved the pinned source; this owns
 * the evidence run and the chain that follows it.
 */
export async function executeGovernedEccMaterialization(
  ctx: PlanContext,
  input: GovernedEccMaterializationInput,
  deps: BaselineEvidencePipelineDeps = {},
): Promise<PlanResult> {
  return executeBaselineEvidencePipeline(
    ctx,
    {
      catalog: input.catalog,
      source: input.source,
      componentIds: selectedComponentIds(input.policy, input.catalog),
      // A governed selection is expected to carry components the vet blocked or
      // never recorded. Each is reported with its reason by the resolver; one of
      // them must not take the whole install down with it.
      allowPartial: true,
      buildInstallPlan: (sourceRoot, authorizations, held) =>
        governedMaterializationPlan(ctx, input.policy, sourceRoot, authorizations, held),
    },
    deps,
  );
}
