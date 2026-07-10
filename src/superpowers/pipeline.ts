import { baselineCatalogById } from "../baseline-evidence/catalogs.js";
import { executeBaselineEvidencePipeline } from "../baseline-evidence/pipeline.js";
import { AihError } from "../errors.js";
import { resolveTargets } from "../internals/cli-detect.js";
import type { PlanResult } from "../internals/execute.js";
import type { PlanContext } from "../internals/plan.js";
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
  const { clis } = await resolveTargets(ctx);
  const catalog = catalogFromContext(ctx);
  const source = resolveTrustSource(`${catalog.owner}/${catalog.repo}`, {
    root: ctx.root,
    pin: catalog.pinnedSha,
  });
  return executeBaselineEvidencePipeline(ctx, {
    catalog,
    source,
    componentIds: superpowersEvidenceComponentIds(),
    buildInstallPlan: (sourceRoot, authorizations) =>
      verifiedSuperpowersInstallPlan(ctx, sourceRoot, clis, authorizations),
  });
}
