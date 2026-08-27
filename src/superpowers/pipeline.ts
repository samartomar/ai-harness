import { baselineCatalogById } from "../baseline-evidence/catalogs.js";
import { executeBaselineEvidencePipeline } from "../baseline-evidence/pipeline.js";
import { AihError } from "../errors.js";
import type { PlanResult } from "../internals/execute.js";
import type { PlanContext } from "../internals/plan.js";
import { verifiedOrgPolicyTargets } from "../org-policy/project.js";
import { resolveTrustSource } from "../trust/fetch.js";
import { superpowersEvidenceComponentIds, verifiedSuperpowersInstallPlan } from "./verified.js";

const FULL_SHA = /^[a-f0-9]{40}$/;

function catalogFromContext(ctx: PlanContext) {
  const requestedPin = (ctx.env.AIH_SUPERPOWERS_REF ?? "").trim();
  if (requestedPin.length > 0 && !FULL_SHA.test(requestedPin)) {
    throw new AihError(
      "AIH_SUPERPOWERS_REF must be an exact lowercase 40-character commit SHA for evidence-gated installs",
      "AIH_CONFIG",
    );
  }
  return baselineCatalogById("superpowers", requestedPin || undefined);
}

export async function executeSuperpowersCommand(ctx: PlanContext): Promise<PlanResult> {
  const policyTargets = await verifiedOrgPolicyTargets(ctx);
  const { clis } = policyTargets.resolution;
  const targetCtx: PlanContext = { ...ctx, targets: clis };
  const catalog = catalogFromContext(ctx);
  const source = resolveTrustSource(`${catalog.owner}/${catalog.repo}`, {
    root: targetCtx.root,
    pin: catalog.pinnedSha,
  });
  return executeBaselineEvidencePipeline(targetCtx, {
    catalog,
    source,
    componentIds: superpowersEvidenceComponentIds(),
    buildInstallPlan: (sourceRoot, authorizations) =>
      verifiedSuperpowersInstallPlan(targetCtx, sourceRoot, clis, authorizations),
    transactionPins: {
      ...(policyTargets.fileAssertions === undefined
        ? {}
        : { fileAssertions: policyTargets.fileAssertions }),
      ...(policyTargets.commitNotAfter === undefined
        ? {}
        : { commitNotAfter: policyTargets.commitNotAfter }),
      ...(policyTargets.commitLock === undefined ? {} : { commitLock: policyTargets.commitLock }),
    },
  });
}
