import {
  type BaselineCatalog,
  defineBaselineCatalog,
  resolveCatalogComponents,
} from "../baseline-evidence/catalog.js";
import {
  type BaselineEvidencePipelineDeps,
  executeBaselineEvidencePipeline,
} from "../baseline-evidence/pipeline.js";
import { AihError } from "../errors.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import type { Plan, PlanContext } from "../internals/plan.js";
import type { OrgPolicy } from "../org-policy/schema.js";
import { sanitizeLabel } from "../plugins/registry.js";
import { resolveTrustSource } from "../trust/fetch.js";
import type {
  FrameworkEvidenceGatedInstallRequestV1,
  FrameworkHostServicesV1,
  FrameworkIdV1,
} from "./contract-v1.js";

/** Policy custody pins carried into every transaction a framework command commits. */
export type FrameworkTransactionPinsV1 = Pick<
  Plan,
  "fileAssertions" | "commitNotAfter" | "commitLock"
>;

export interface FrameworkHostServicesInputV1 {
  readonly frameworkId: FrameworkIdV1;
  /** The invocation's plan context, with `targets` already resolved by Core. */
  readonly ctx: PlanContext;
  /** The one verified policy observation this invocation acts under. */
  readonly policy: OrgPolicy | undefined;
  readonly transactionPins: FrameworkTransactionPinsV1;
  /** Every result these services return is recorded here. */
  readonly produced: WeakSet<object>;
  /** Test seam for the evidence pipeline's vendor lock and organization evidence. */
  readonly pipelineDeps?: BaselineEvidencePipelineDeps;
}

function invalidRequest(frameworkId: FrameworkIdV1, detail: string): AihError {
  return new AihError(
    `the ${frameworkId} framework plugin requested invalid evidence (${sanitizeLabel(detail, 240)})`,
    "AIH_FRAMEWORK_PLUGIN",
  );
}

/**
 * The plugin names components; Core decides what the evidence catalog is. Its
 * id is always the plugin's own framework id, so a plugin can never verify or
 * install under another framework's evidence.
 */
function evidenceCatalog(
  frameworkId: FrameworkIdV1,
  request: FrameworkEvidenceGatedInstallRequestV1,
): BaselineCatalog {
  let catalog: BaselineCatalog;
  try {
    catalog = defineBaselineCatalog({
      id: frameworkId,
      owner: request.source.owner,
      repo: request.source.repo,
      pinnedSha: request.source.commit,
      components: request.components.map((component) => ({
        id: component.id,
        paths: [...component.paths],
        ...(component.skillContent === true ? { skillContent: true } : {}),
      })),
    });
  } catch (error) {
    const issue = (error as { issues?: Array<{ path: unknown[]; message: string }> }).issues?.[0];
    throw invalidRequest(
      frameworkId,
      issue === undefined ? String(error) : `${issue.path.join(".")}: ${issue.message}`,
    );
  }
  if (request.componentIds.length === 0) throw invalidRequest(frameworkId, "no component ids");
  try {
    resolveCatalogComponents(catalog, request.componentIds);
  } catch (error) {
    throw invalidRequest(frameworkId, (error as Error).message);
  }
  return catalog;
}

/** Effectful services bound to one framework invocation. */
export function frameworkHostServicesV1(
  input: FrameworkHostServicesInputV1,
): FrameworkHostServicesV1 {
  const { ctx, frameworkId, policy, transactionPins, produced } = input;
  const record = (result: PlanResult): PlanResult => {
    produced.add(result);
    return result;
  };
  return Object.freeze({
    async runEvidenceGatedInstall(request: FrameworkEvidenceGatedInstallRequestV1) {
      const catalog = evidenceCatalog(frameworkId, request);
      const source = resolveTrustSource(`${catalog.owner}/${catalog.repo}`, {
        root: ctx.root,
        pin: catalog.pinnedSha,
      });
      return record(
        await executeBaselineEvidencePipeline(
          ctx,
          {
            catalog,
            source,
            componentIds: [...request.componentIds],
            ...(policy === undefined ? {} : { policy }),
            buildInstallPlan: (sourceRoot, authorizations, held) =>
              request.buildInstallPlan(
                Object.freeze({
                  sourceRoot,
                  authorizations: Object.freeze([...authorizations]),
                  held: Object.freeze([...held]),
                }),
              ),
            transactionPins,
          },
          input.pipelineDeps,
        ),
      );
    },
    async executePlan(plan: Plan) {
      return record(await executePlan({ ...plan, ...transactionPins }, ctx));
    },
    progress(message: string) {
      ctx.progress?.(sanitizeLabel(message, 240));
    },
  });
}
