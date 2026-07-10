import { resolve } from "node:path";
import type { BaselineCatalog } from "../baseline-evidence/catalog.js";
import { baselineCatalogById } from "../baseline-evidence/catalogs.js";
import {
  type ResolveOrgBaselineEvidenceResult,
  resolveOrgBaselineEvidence,
} from "../baseline-evidence/org.js";
import {
  BaselineEvidenceBlockedError,
  baselineInstallPhasePlan,
  captureClearedBaselineGate,
} from "../baseline-evidence/run.js";
import type { BaselineEvidenceLock } from "../baseline-evidence/schema.js";
import { readVendorBaselineLock, vendorBaselineLockSha256 } from "../baseline-evidence/vendor.js";
import { AihError } from "../errors.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import { type Plan, type PlanContext, plan, structuredChecksProbe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { readOrgPolicy } from "../org-policy/schema.js";
import {
  assertTrustTreeSafe,
  cleanupQuarantine,
  readTrustFetchMetadata,
  resolveTrustSource,
  type TrustSource,
  trustFetchExec,
} from "../trust/fetch.js";
import { eccEvidenceComponentIds } from "./evidence.js";
import { isAihDirectEccInstallTarget } from "./install.js";
import { type VerifiedEccRequest, verifiedEccInstallPlan } from "./verified.js";

const FULL_SHA = /^[a-f0-9]{40}$/;

export interface EccEvidencePipelineDeps {
  catalog?: BaselineCatalog;
  source?: TrustSource;
  vendorLock?: BaselineEvidenceLock;
  vendorLockSha256?: string;
  buildInstallPlan?: typeof verifiedEccInstallPlan;
  resolveOrgEvidence?: (
    input: Parameters<typeof resolveOrgBaselineEvidence>[0],
  ) => Promise<ResolveOrgBaselineEvidenceResult>;
}

function requestedCatalog(ctx: PlanContext): BaselineCatalog {
  const requestedPin = (ctx.env.AIH_ECC_REF ?? "").trim();
  if (requestedPin.length > 0 && !FULL_SHA.test(requestedPin)) {
    throw new AihError(
      "AIH_ECC_REF must be an exact lowercase 40-character commit SHA for evidence-gated installs",
      "AIH_CONFIG",
    );
  }
  return baselineCatalogById("ecc", requestedPin || undefined);
}

function requestedSource(ctx: PlanContext, catalog: BaselineCatalog): TrustSource {
  const local = typeof ctx.options.eccPath === "string" ? ctx.options.eccPath.trim() : "";
  if (local.length > 0) return resolveTrustSource(local, { root: ctx.root });
  return resolveTrustSource(`${catalog.owner}/${catalog.repo}`, {
    root: ctx.root,
    pin: catalog.pinnedSha,
  });
}

function componentIds(request: VerifiedEccRequest): string[] {
  const selected = new Set<string>();
  for (const cli of request.clis) {
    if (isAihDirectEccInstallTarget(cli) || cli === "codex") {
      for (const id of eccEvidenceComponentIds(request.profile, cli, request.packs)) {
        selected.add(id);
      }
    } else if (cli === "kiro") {
      selected.add("runtime:ecc-kiro");
    }
  }
  return [...selected];
}

function failed(checks: readonly Check[]): boolean {
  return checks.some((check) => check.verdict === "fail");
}

function failedExec(result: PlanResult): boolean {
  return result.execs.some((entry) => entry.ran && entry.ok === false);
}

function checksPlan(capability: string, checks: readonly Check[]): Plan {
  return plan(
    capability,
    structuredChecksProbe(capability, () => [...checks]),
  );
}

function sourceFailure(detail: string): Check {
  return {
    name: "ECC baseline source pin",
    verdict: "fail",
    code: "baseline.evidence-mismatch",
    detail,
  };
}

function verifiedGithubTree(
  source: Extract<TrustSource, { kind: "github" }>,
  catalog: BaselineCatalog,
): string | Check {
  let metadata: ReturnType<typeof readTrustFetchMetadata>;
  try {
    metadata = readTrustFetchMetadata(source);
  } catch (err) {
    return sourceFailure(`could not read quarantined fetch metadata: ${(err as Error).message}`);
  }
  if (
    metadata.kind !== "github" ||
    metadata.owner !== catalog.owner ||
    metadata.repo !== catalog.repo ||
    metadata.pinnedSha !== catalog.pinnedSha ||
    resolve(metadata.treePath) !== resolve(source.treePath)
  ) {
    return sourceFailure(
      `quarantined fetch metadata does not bind ${catalog.owner}/${catalog.repo}@${catalog.pinnedSha}`,
    );
  }
  try {
    return assertTrustTreeSafe(source.treePath);
  } catch (err) {
    return sourceFailure(`quarantined ECC tree is unsafe: ${(err as Error).message}`);
  }
}

/**
 * Acquire, authorize, re-hash, and only then construct ECC install actions.
 * The quarantine is removed after execution on every success/failure path.
 */
export async function executeEccEvidencePipeline(
  ctx: PlanContext,
  request: VerifiedEccRequest,
  deps: EccEvidencePipelineDeps = {},
): Promise<PlanResult> {
  const catalog = deps.catalog ?? requestedCatalog(ctx);
  const source = deps.source ?? requestedSource(ctx, catalog);
  const vendorLock = deps.vendorLock ?? readVendorBaselineLock();
  const lockSha256 = deps.vendorLockSha256 ?? vendorBaselineLockSha256();
  const buildInstallPlan = deps.buildInstallPlan ?? verifiedEccInstallPlan;
  const resolveOrgEvidence = deps.resolveOrgEvidence ?? resolveOrgBaselineEvidence;

  try {
    let sourceRoot: string;
    if (source.kind === "github") {
      const acquisition = await executePlan(
        plan("ecc: acquire exact baseline source", trustFetchExec(source, ctx)),
        ctx,
      );
      if (!ctx.apply || failedExec(acquisition) || (acquisition.report?.exitCode() ?? 0) !== 0) {
        return acquisition;
      }
      const verifiedTree = verifiedGithubTree(source, catalog);
      if (typeof verifiedTree !== "string") {
        return executePlan(checksPlan("ecc: validate baseline source", [verifiedTree]), ctx);
      }
      sourceRoot = verifiedTree;
    } else {
      sourceRoot = assertTrustTreeSafe(source.root);
    }

    const org = await resolveOrgEvidence({
      root: ctx.root,
      catalog,
      policy: readOrgPolicy(ctx.root, ctx.env),
      run: ctx.run,
    });
    if (failed(org.checks)) {
      return executePlan(checksPlan("ecc: validate org baseline evidence", org.checks), ctx);
    }

    const selected = componentIds(request);
    let gate: ReturnType<typeof captureClearedBaselineGate>;
    try {
      gate = captureClearedBaselineGate({
        ctx,
        sourceRoot,
        catalog,
        componentIds: selected,
        vendorLock,
        vendorLockSha256: lockSha256,
        orgEvidence: org.evidence,
      });
    } catch (err) {
      if (!(err instanceof BaselineEvidenceBlockedError)) throw err;
      return executePlan(checksPlan("ecc: baseline evidence gate", err.checks), ctx);
    }

    const install = await baselineInstallPhasePlan(
      ctx,
      gate,
      (authorizations) => buildInstallPlan(ctx, sourceRoot, request, authorizations).actions,
    );
    const actions =
      org.checks.length > 0
        ? [structuredChecksProbe("org baseline evidence", () => org.checks), ...install.actions]
        : install.actions;
    return executePlan(plan(install.capability, ...actions), ctx);
  } finally {
    cleanupQuarantine(source);
  }
}
