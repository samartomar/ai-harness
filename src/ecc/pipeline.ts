import type { BaselineCatalog } from "../baseline-evidence/catalog.js";
import { baselineCatalogById } from "../baseline-evidence/catalogs.js";
import type {
  ResolveOrgBaselineEvidenceResult,
  resolveOrgBaselineEvidence,
} from "../baseline-evidence/org.js";
import {
  type BaselineEvidencePipelineDeps,
  executeBaselineEvidencePipeline,
} from "../baseline-evidence/pipeline.js";
import type { BaselineEvidenceLock } from "../baseline-evidence/schema.js";
import { AihError } from "../errors.js";
import { detectFallbackNotice, resolveTargets } from "../internals/cli-detect.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import { doc, type PlanContext, plan } from "../internals/plan.js";
import type { RepoStack } from "../profile/scan.js";
import { scanRepo } from "../profile/scan.js";
import { resolveTrustSource, type TrustSource } from "../trust/fetch.js";
import { eccEvidenceComponentIds } from "./evidence.js";
import { eccActionsForCli, eccToolsDoc, isAihDirectEccInstallTarget } from "./install.js";
import { eccLanguages } from "./select.js";
import { type VerifiedEccRequest, verifiedEccInstallPlan } from "./verified.js";

const FULL_SHA = /^[a-f0-9]{40}$/;

export interface EccEvidencePipelineDeps extends BaselineEvidencePipelineDeps {
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

function repoStackSummary(stack: RepoStack): string {
  const parts: string[] = [];
  if (stack.languages.length > 0) parts.push(stack.languages.join(" + "));
  if (stack.frameworks.length > 0) parts.push(`using ${stack.frameworks.join(", ")}`);
  if (stack.cloud.length > 0) parts.push(`on ${stack.cloud.join("/")}`);
  return parts.length > 0 ? parts.join(" ") : "a new repository with no detected stack yet";
}

function isMutatingEccTarget(cli: VerifiedEccRequest["clis"][number]): boolean {
  return isAihDirectEccInstallTarget(cli) || cli === "codex" || cli === "kiro";
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
  const buildInstallPlan = deps.buildInstallPlan ?? verifiedEccInstallPlan;
  return executeBaselineEvidencePipeline(
    ctx,
    {
      catalog,
      source,
      componentIds: componentIds(request),
      buildInstallPlan: (sourceRoot, authorizations) =>
        buildInstallPlan(ctx, sourceRoot, request, authorizations),
    },
    deps,
  );
}

/** Resolve the ordinary ECC command inputs once, then route mutating targets through evidence. */
export async function executeEccCommand(ctx: PlanContext): Promise<PlanResult> {
  const { clis, detectFellBack } = await resolveTargets(ctx);
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const language = eccLanguages(stack);
  const profile = String(ctx.options.profile ?? "core");
  const stackSummary = repoStackSummary(stack);
  const request: VerifiedEccRequest = {
    clis,
    profile,
    packs: language.packs,
    stackSummary,
  };
  if (clis.some(isMutatingEccTarget)) return executeEccEvidencePipeline(ctx, request);

  const actions = clis.flatMap((cli) =>
    eccActionsForCli(cli, {
      profile,
      stackSummary,
      platform: ctx.host.platform,
      packs: language.packs,
    }),
  );
  actions.push(eccToolsDoc());
  if (detectFellBack) {
    actions.push(doc("no AI CLIs detected — defaulted to claude", detectFallbackNotice()));
  }
  return executePlan(plan("ecc: consult-only targets", ...actions), ctx);
}
