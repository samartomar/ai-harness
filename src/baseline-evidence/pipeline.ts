import { resolve } from "node:path";
import { postureFromContext } from "../config/posture.js";
import { AihError } from "../errors.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import { type Plan, type PlanContext, plan, structuredChecksProbe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { readOrgPolicy } from "../org-policy/schema.js";
import {
  assertTrustTreeSafe,
  cleanupQuarantine,
  readTrustFetchMetadata,
  type TrustSource,
  trustFetchExec,
} from "../trust/fetch.js";
import type { AcceptanceTuple } from "./acceptance.js";
import type { BaselineCatalog } from "./catalog.js";
import { type ResolveOrgBaselineEvidenceResult, resolveOrgBaselineEvidence } from "./org.js";
import {
  BaselineEvidenceBlockedError,
  baselineInstallPhasePlan,
  captureBaselineGate,
} from "./run.js";
import type { BaselineEvidenceLock } from "./schema.js";
import { readVendorBaselineLock, vendorBaselineLockSha256 } from "./vendor.js";
import type { BaselineAuthorization, BaselineHeldComponent } from "./verify.js";

export interface BaselineEvidencePipelineInput {
  catalog: BaselineCatalog;
  source: TrustSource;
  componentIds: readonly string[];
  allowPartial?: boolean;
  /** When set, only accepted-with-conditions decisions for this exact tuple apply. */
  acceptanceTuple?: AcceptanceTuple;
  /** Exact protected-policy custody pins carried into the target-local install transaction. */
  transactionPins?: Pick<Plan, "fileAssertions" | "commitNotAfter" | "commitLock">;
  /**
   * `held` rides alongside `authorizations` because a caller that reports WHY a
   * requested component did not install needs the evidence state that held it
   * back, and re-deriving it downstream would be a second verification whose
   * verdict could differ from the one this gate acted on.
   */
  buildInstallPlan: (
    sourceRoot: string,
    authorizations: readonly BaselineAuthorization[],
    held: readonly BaselineHeldComponent[],
  ) => Plan | Promise<Plan>;
}

export interface BaselineEvidencePipelineDeps {
  vendorLock?: BaselineEvidenceLock;
  vendorLockSha256?: string;
  resolveOrgEvidence?: (
    input: Parameters<typeof resolveOrgBaselineEvidence>[0],
  ) => Promise<ResolveOrgBaselineEvidenceResult>;
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

function sourceFailure(catalog: BaselineCatalog, detail: string): Check {
  return {
    name: `${catalog.id} baseline source pin`,
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
    return sourceFailure(
      catalog,
      `could not read quarantined fetch metadata: ${(err as Error).message}`,
    );
  }
  if (
    metadata.kind !== "github" ||
    metadata.owner !== catalog.owner ||
    metadata.repo !== catalog.repo ||
    metadata.pinnedSha !== catalog.pinnedSha ||
    resolve(metadata.treePath) !== resolve(source.treePath)
  ) {
    return sourceFailure(
      catalog,
      `quarantined fetch metadata does not bind ${catalog.owner}/${catalog.repo}@${catalog.pinnedSha}`,
    );
  }
  try {
    return assertTrustTreeSafe(source.treePath);
  } catch (err) {
    return sourceFailure(catalog, `quarantined source tree is unsafe: ${(err as Error).message}`);
  }
}

/** Acquire, authorize, re-hash, then and only then construct baseline install actions. */
export async function executeBaselineEvidencePipeline(
  ctx: PlanContext,
  input: BaselineEvidencePipelineInput,
  deps: BaselineEvidencePipelineDeps = {},
): Promise<PlanResult> {
  if (input.componentIds.length === 0) {
    throw new AihError("baseline evidence pipeline requires at least one component", "AIH_CONFIG");
  }
  const resolveOrgEvidence = deps.resolveOrgEvidence ?? resolveOrgBaselineEvidence;

  try {
    const org = await resolveOrgEvidence({
      root: ctx.root,
      catalog: input.catalog,
      policy: readOrgPolicy(ctx.root, ctx.env),
      run: ctx.run,
      posture: postureFromContext(ctx),
    });
    if (failed(org.checks)) {
      return executePlan(
        checksPlan(`${input.catalog.id}: validate org baseline evidence`, org.checks),
        ctx,
      );
    }

    const vendorLock = deps.vendorLock ?? readVendorBaselineLock();
    const lockSha256 = deps.vendorLockSha256 ?? vendorBaselineLockSha256();
    let sourceRoot: string;
    if (input.source.kind === "github") {
      const acquisition = await executePlan(
        plan(
          `${input.catalog.id}: acquire exact baseline source`,
          trustFetchExec(input.source, ctx),
        ),
        ctx,
      );
      if (!ctx.apply || failedExec(acquisition) || (acquisition.report?.exitCode() ?? 0) !== 0) {
        return acquisition;
      }
      const verifiedTree = verifiedGithubTree(input.source, input.catalog);
      if (typeof verifiedTree !== "string") {
        return executePlan(
          checksPlan(`${input.catalog.id}: validate baseline source`, [verifiedTree]),
          ctx,
        );
      }
      sourceRoot = verifiedTree;
    } else {
      sourceRoot = assertTrustTreeSafe(input.source.root);
    }

    let gate: ReturnType<typeof captureBaselineGate>;
    try {
      gate = captureBaselineGate({
        ctx,
        allowPartial: input.allowPartial,
        sourceRoot,
        catalog: input.catalog,
        componentIds: input.componentIds,
        vendorLock,
        vendorLockSha256: lockSha256,
        orgEvidence: org.evidence,
        acceptanceTuple: input.acceptanceTuple,
      });
    } catch (err) {
      if (!(err instanceof BaselineEvidenceBlockedError)) throw err;
      return executePlan(
        checksPlan(`${input.catalog.id}: baseline evidence gate`, err.checks),
        ctx,
      );
    }

    const install = await baselineInstallPhasePlan(
      ctx,
      gate,
      async (authorizations, held) =>
        (await input.buildInstallPlan(sourceRoot, authorizations, held)).actions,
    );
    const actions =
      org.checks.length > 0
        ? [structuredChecksProbe("org baseline evidence", () => org.checks), ...install.actions]
        : install.actions;
    return executePlan({ ...plan(install.capability, ...actions), ...input.transactionPins }, ctx);
  } finally {
    cleanupQuarantine(input.source);
  }
}
