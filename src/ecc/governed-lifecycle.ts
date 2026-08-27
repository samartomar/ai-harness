import type { BaselineCatalog } from "../baseline-evidence/catalog.js";
import {
  type BaselineEvidencePipelineDeps,
  executeBaselineEvidencePipeline,
} from "../baseline-evidence/pipeline.js";
import type { BaselineAuthorization, BaselineHeldComponent } from "../baseline-evidence/verify.js";
import { AihError } from "../errors.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import { digest, type Plan, type PlanContext, plan } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { resolveEffectiveOrgPolicy } from "../org-policy/effective.js";
import type { OrgPolicy } from "../org-policy/schema.js";
import { cleanupQuarantine, type TrustSource } from "../trust/fetch.js";
import {
  applyEccMaterialization,
  type EccMaterializationAdvisory,
  type EccMaterializationFilePlan,
  type EccMaterializationRequest,
  type EccMaterializationTransactionGuard,
  previewEccMaterialization,
} from "./materialization.js";
import { displaySafe, ECC_KIRO_RUNTIME_COMPONENT_ID } from "./materialization-receipt.js";
import {
  type EccSelectionExclusion,
  resolveEccMaterializationSelection,
} from "./materialization-selection.js";
import {
  type EccMaterializationTarget,
  type EccTargetedRefusal,
  eccMaterializationTargetName,
  resolveEccTargetMaterialization,
} from "./materialization-target.js";

/**
 * F6: `aih ecc --lifecycle install` in a governed repository.
 *
 * Every part of the governed framework lifecycle already exists — the effective
 * policy reader, the evidence-passed selection resolver (F2), the target
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
 * Preview-first is the harness's own `--apply` gate and nothing else: with the
 * pinned source on disk the chain plans and reports without it, and applies with
 * it. With the DEFAULT remote source there is nothing on disk to plan against in
 * dry run — the evidence pipeline returns after the unrun acquisition — so the
 * dry run reports the pin and the selected components and says outright that
 * file-level preview needs `--ecc-path` or `--apply`, rather than implying that
 * nothing would be written. There is no second preview flag, and this module
 * never writes outside the engine.
 *
 * WHICH TARGETS is the caller's business, not a governed-only concept: the
 * command resolves the ordinary workstation CLI selection and hands the
 * narrowed target set in. N targets are ONE materialization here — the adapter
 * unions their destinations per component, the engine sees one request against
 * one root, and a later run with a narrower set subtracts the dropped target's
 * files as stale ownership. Every report row that used to name Claude now names
 * the target that produced it.
 */

/** The framework this lifecycle materializes. Superpowers is a later row. */
const GOVERNED_FRAMEWORK = "ecc";

export interface GovernedEccMaterializationInput {
  catalog: BaselineCatalog;
  source: TrustSource;
  /** The parsed governed policy, already read through the product's own reader. */
  policy: OrgPolicy;
  /** {@link governedEccComponentIds}, resolved by the caller BEFORE the source. */
  componentIds: readonly string[];
  /**
   * The requested governed targets, narrowed by
   * `assertGovernedMaterializationTargets` BEFORE the source is resolved — a
   * target this lifecycle refuses must create no quarantine.
   */
  targets: readonly EccMaterializationTarget[];
  /** One verified protected-policy observation carried to the direct writer. */
  transactionGuard?: EccMaterializationTransactionGuard;
}

/** One normalized report for both halves of the `--apply` gate. */
interface GovernedMaterializationReport {
  root: string;
  applied: boolean;
  targets: readonly EccMaterializationTarget[];
  write: EccMaterializationFilePlan[];
  subtract: EccMaterializationFilePlan[];
  advisories: EccMaterializationAdvisory[];
  excluded: EccSelectionExclusion[];
  refused: EccTargetedRefusal[];
}

/**
 * The component ids the policy selected for this framework — the identity the
 * evidence gate verifies and the selection resolver matches on. An id the
 * catalog does not carry is refused here, by name: the alternative is a raw
 * catalog error that never mentions the policy the id came from.
 *
 * Also the provenance gate. Each item's `source.repository`/`source.commit` is
 * the POLICY'S CLAIM about where its bytes came from, and it flows verbatim into
 * the materialization receipt (`materialization-selection.ts:191-197`) — while
 * the bytes actually come from the catalog pin this run verifies against. When
 * those disagree the receipt would assert a provenance nothing checked, so the
 * run refuses and names both values. The authoring surface derives the claim
 * from this same catalog identity (`src/org-policy/catalog.ts:388-392`), so an
 * authored policy always agrees; a hand-edited one, a fork, or a stale pin
 * against an `AIH_ECC_REF` override is exactly what this catches.
 *
 * Exported so the caller can validate BEFORE resolving a source: source
 * resolution creates a quarantine directory, and a refusing invocation must
 * create nothing.
 */
export function governedEccComponentIds(policy: OrgPolicy, catalog: BaselineCatalog): string[] {
  const expectedRepository = `${catalog.owner}/${catalog.repo}`;
  const selected = new Set<string>();
  for (const selection of policy.governance?.externalSelections ?? []) {
    if (selection.framework !== GOVERNED_FRAMEWORK) continue;
    for (const item of selection.items) {
      // GitHub owner/repo identity is case-insensitive, and this repository
      // carries both spellings of the ECC repo, so casing alone is never the
      // disagreement. The commit is already lowercase-constrained by the policy
      // schema, so it compares exactly.
      if (item.source.repository.toLowerCase() !== expectedRepository.toLowerCase()) {
        throw new AihError(
          `refusing the governed ECC framework lifecycle: ${displaySafe(item.id)} claims repository ${displaySafe(item.source.repository)}, but its bytes would come from ${displaySafe(expectedRepository)}`,
          "AIH_TRUST",
        );
      }
      if (item.source.commit !== catalog.pinnedSha) {
        throw new AihError(
          `refusing the governed ECC framework lifecycle: ${displaySafe(item.id)} claims commit ${displaySafe(item.source.commit)}, but its bytes would come from ${displaySafe(catalog.pinnedSha)}`,
          "AIH_TRUST",
        );
      }
      selected.add(item.id);
    }
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
      // Wrapped rather than passed by reference: `map` supplies the index as
      // `displaySafe`'s second argument, which is its `max` — every id would
      // render as a bare ellipsis and the refusal would name nothing.
      `refusing the governed ECC framework lifecycle: the policy selects component(s) the pinned ECC catalog does not carry: ${unknown.map((id) => displaySafe(id)).join(", ")}`,
      "AIH_CONFIG",
    );
  }
  return [...selected];
}

/**
 * The dry run available when the pinned source is NOT on disk. On the default
 * remote source the evidence pipeline returns after acquisition in dry run and
 * never reaches the plan builder (`baseline-evidence/pipeline.ts:126-135`), so
 * there is nothing to preview file-by-file. Saying so plainly is the whole point:
 * a dry run that reported nothing would let the first run that shows the plan be
 * the run that already wrote.
 */
function sourceAbsentPlan(
  catalog: BaselineCatalog,
  componentIds: readonly string[],
  targets: readonly EccMaterializationTarget[],
): Plan {
  const pinnedSource = `${catalog.owner}/${catalog.repo}@${catalog.pinnedSha}`;
  return plan(
    "ecc: governed framework materialization",
    digest(
      "governed ECC framework materialization (pinned source not present)",
      lines(
        `Governed ECC framework materialization would install from ${pinnedSource}.`,
        `Requested target(s): ${targets.map(eccMaterializationTargetName).join(", ")}.`,
        "",
        "Selected components, each still subject to the evidence gate at apply:",
        ...componentIds.map((id) => `  - ${id}`),
        "",
        "This is NOT a file-level preview: the pinned source is not on disk, so which",
        "files would land cannot be computed here. Pass `--ecc-path <dir>` to preview",
        "against a local checkout of the pin, or `--apply` to acquire the pin, run the",
        "evidence gate and materialize.",
        "",
        "Nothing has been written and nothing has been fetched.",
      ),
      {
        applied: false,
        sourcePresent: false,
        pinnedSource,
        componentIds: [...componentIds],
        targets: [...targets],
      },
    ),
  );
}

/**
 * Refusals, grouped under the target that made them, in the order the targets
 * were requested. Grouping is a rendering concern only: the machine payload
 * stays one flat list, each entry naming its own target, so a consumer never
 * has to reassemble it.
 */
function refusalRows(report: GovernedMaterializationReport): string[] {
  return report.targets.flatMap((target) => {
    const rows = report.refused.filter((entry) => entry.target === target);
    if (rows.length === 0) return [];
    return [
      "",
      `Evidence-passed, and refused by the ${eccMaterializationTargetName(target)} target:`,
      ...rows.map((entry) => `  [${entry.reason}] ${entry.id} - ${entry.detail}`),
    ];
  });
}

function reportBody(report: GovernedMaterializationReport): string {
  const verb = report.applied ? "wrote" : "would write";
  return lines(
    `Governed ECC framework materialization (${report.applied ? "applied" : "preview"}):`,
    ...report.write.map((file) => `  [${verb}] ${file.path} - ${file.componentId}`),
    // Neutral wording: a receipt entry the request no longer carries may be a
    // genuine deselection OR a component this run could not map, and this layer
    // cannot cheaply tell them apart. Naming it "deselected" would assert the
    // one it did not check.
    ...report.subtract.map(
      (file) =>
        `  [${report.applied ? "removed" : "would remove"}] ${file.path} - no longer part of this materialization`,
    ),
    ...(report.excluded.length > 0
      ? [
          "",
          "Selected, and not materialized - evidence is what admits a component:",
          ...report.excluded.map((entry) => `  [${entry.reason}] ${entry.id} - ${entry.detail}`),
        ]
      : []),
    ...refusalRows(report),
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
 * the requested targets, and preview or apply.
 *
 * Multi-target is a union in ONE materialization, not N of them: the adapter
 * returns each component's per-target destinations already merged, so the engine
 * sees one request against one root and `apply IS the reconcile` handles a later
 * run with a narrower target set by subtracting the dropped target's files as
 * stale ownership.
 */
function governedMaterializationPlan(
  ctx: PlanContext,
  policy: OrgPolicy,
  targets: readonly EccMaterializationTarget[],
  sourceRoot: string,
  authorizations: readonly BaselineAuthorization[],
  held: readonly BaselineHeldComponent[],
  onPrepared?: (request: EccMaterializationRequest, report: GovernedMaterializationReport) => void,
): Plan {
  const effective = resolveEffectiveOrgPolicy(policy);
  const selection = resolveEccMaterializationSelection(effective, {
    authorizations: [...authorizations],
    held: [...held],
  });
  const target = resolveEccTargetMaterialization({
    sourceRoot,
    targets,
    components: selection.included,
    evidence: { authorizations: [...authorizations], held: [...held] },
  });
  // Total refusal is ambiguity, and the engine cannot see it: an empty request
  // is byte-identical to "every component was deselected", on which `apply`
  // subtracts the whole prior install as stale ownership. Fail closed and name
  // every refusal instead of wiping an install on a reading nothing confirmed.
  // The gate spans the WHOLE requested target set: one target refusing
  // everything is not total refusal while another still materializes.
  if (selection.included.length > 0 && target.components.length === 0) {
    const named = `the ${targets.map(eccMaterializationTargetName).join(", ")} target${
      targets.length === 1 ? "" : "s"
    }`;
    throw new AihError(
      `refusing the governed ECC framework materialization: ${named} refused every evidence-passed component, which is indistinguishable from deselecting all of them — ${target.refused
        .map((entry) => `${displaySafe(entry.id)} (${entry.reason}: ${displaySafe(entry.detail)})`)
        .join("; ")}`,
      "AIH_TRUST",
    );
  }
  const request = { root: ctx.root, components: target.components };
  // Keep planning pure. The direct materializer runs later, inside its own
  // authority assertion/lease boundary, after the evidence pipeline accepted
  // this exact request.
  const outcome = previewEccMaterialization(request);
  const report: GovernedMaterializationReport = {
    root: ctx.root,
    applied: false,
    targets,
    write: outcome.write,
    subtract: outcome.subtract,
    advisories: outcome.advisories,
    excluded: selection.excluded,
    refused: target.refused,
  };
  onPrepared?.(request, report);
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
  // A remote pin in dry run: the evidence pipeline would return after the
  // unrun acquisition and never build a plan, so answer here instead of
  // reporting nothing. The quarantine that resolving the source created is
  // removed the way the sibling preview does it (`pipeline.ts:268-270`).
  if (!ctx.apply && input.source.kind === "github") {
    try {
      return await executePlan(
        sourceAbsentPlan(input.catalog, input.componentIds, input.targets),
        ctx,
      );
    } finally {
      cleanupQuarantine(input.source);
    }
  }
  const evidenceComponentIds = [...input.componentIds];
  if (
    input.targets.includes("kiro") &&
    input.componentIds.some(
      (id) => id === "baseline:rules" || id.startsWith("agent:") || id.startsWith("skill:"),
    ) &&
    !evidenceComponentIds.includes(ECC_KIRO_RUNTIME_COMPONENT_ID)
  ) {
    evidenceComponentIds.push(ECC_KIRO_RUNTIME_COMPONENT_ID);
  }
  let prepared:
    | { request: EccMaterializationRequest; report: GovernedMaterializationReport }
    | undefined;
  const result = await executeBaselineEvidencePipeline(
    ctx,
    {
      catalog: input.catalog,
      source: input.source,
      componentIds: evidenceComponentIds,
      policy: input.policy,
      // A governed selection is expected to carry components the vet blocked or
      // never recorded. Each is reported with its reason by the resolver; one of
      // them must not take the whole install down with it.
      allowPartial: true,
      buildInstallPlan: (sourceRoot, authorizations, held) =>
        governedMaterializationPlan(
          ctx,
          input.policy,
          input.targets,
          sourceRoot,
          authorizations,
          held,
          (request, report) => {
            prepared = { request, report };
          },
        ),
    },
    deps,
  );
  if (!ctx.apply || prepared === undefined) return result;

  const outcome = applyEccMaterialization(prepared.request, {}, input.transactionGuard);
  const report: GovernedMaterializationReport = {
    ...prepared.report,
    applied: true,
    write: outcome.written,
    subtract: outcome.removed,
    advisories: outcome.advisories,
  };
  const digestIndex = result.digests.findIndex((entry) =>
    entry.describe.includes("governed ECC framework materialization"),
  );
  if (digestIndex >= 0) {
    result.digests[digestIndex] = {
      describe: "governed ECC framework materialization",
      text: reportBody(report),
      data: report,
    };
  }
  return result;
}
