import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { type ParseError, parse } from "jsonc-parser";
import type { AcceptanceTuple } from "../baseline-evidence/acceptance.js";
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
import type { BaselineAuthorization, BaselineHeldComponent } from "../baseline-evidence/verify.js";
import { postureFromContext } from "../config/posture.js";
import {
  type EccProfileLifecycleCommandDeps,
  executeEccProfileLifecycleCommand,
} from "../ecc-profile/command.js";
import { AihError } from "../errors.js";
import { detectFallbackNotice, resolveTargets } from "../internals/cli-detect.js";
import type { Cli } from "../internals/clis.js";
import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import { doc, type Plan, type PlanContext, plan } from "../internals/plan.js";
import { assertOrgPolicyMutationSource } from "../org-policy/drift.js";
import { readOrgPolicy } from "../org-policy/schema.js";
import type { RepoStack } from "../profile/scan.js";
import { scanRepo } from "../profile/scan.js";
import { cleanupQuarantine, resolveTrustSource, type TrustSource } from "../trust/fetch.js";
import type { EccComponentId, EccComponentSelection, EccMcpComponentId } from "./components.js";
import { selectEccComponents } from "./components.js";
import { eccEvidenceComponentIds, eccEvidenceComponentIdsForSelection } from "./evidence.js";
import {
  executeGovernedEccMaterialization,
  governedEccComponentIds,
} from "./governed-lifecycle.js";
import { eccActionsForCli, eccToolsDoc, isAihDirectEccInstallTarget } from "./install.js";
import {
  contingentEccInstallPreviewPlan,
  type EccInstallPreviewArtifact,
} from "./install-preview.js";
import { assertGovernedMaterializationTargets } from "./materialization-target.js";
import { orgAllowedEccMcpComponents } from "./mcp.js";
import {
  machineRegistrationUnion,
  mergeRegistrationLedger,
  type ProjectRegistration,
  type RegistrationLedger,
  readRegistrationLedger,
} from "./registration.js";
import { eccLanguages } from "./select.js";
import { type VerifiedEccRequest, verifiedEccInstallPlan } from "./verified.js";

const FULL_SHA = /^[a-f0-9]{40}$/;

/**
 * `verifiedEccInstallPlan`'s shape, plus the evidence records the gate held
 * back. Declared rather than derived so a builder that reports WHY a selected
 * component did not install — the governed materialization lifecycle — is
 * expressible without every existing four-parameter builder having to change.
 */
export type EccInstallPlanBuilder = (
  ctx: PlanContext,
  sourceRoot: string,
  request: VerifiedEccRequest,
  authorizations: readonly BaselineAuthorization[],
  held: readonly BaselineHeldComponent[],
) => Plan | Promise<Plan>;

export interface EccEvidencePipelineDeps extends BaselineEvidencePipelineDeps {
  catalog?: BaselineCatalog;
  source?: TrustSource;
  /** When set, only accepted-with-conditions decisions for this exact tuple apply. */
  acceptanceTuple?: AcceptanceTuple;
  vendorLock?: BaselineEvidenceLock;
  vendorLockSha256?: string;
  buildInstallPlan?: EccInstallPlanBuilder;
  resolveOrgEvidence?: (
    input: Parameters<typeof resolveOrgBaselineEvidence>[0],
  ) => Promise<ResolveOrgBaselineEvidenceResult>;
  installPreview?: EccInstallPreviewArtifact;
}

export interface EccCommandDeps extends EccEvidencePipelineDeps {
  executeProfileLifecycle?: (
    ctx: PlanContext,
    deps?: EccProfileLifecycleCommandDeps,
  ) => Promise<PlanResult>;
  profileLifecycle?: EccProfileLifecycleCommandDeps;
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
      const ids = request.selection
        ? eccEvidenceComponentIdsForSelection(cli, request.selection)
        : eccEvidenceComponentIds(request.profile, cli, request.packs);
      for (const id of ids) {
        selected.add(id);
      }
    } else if (cli === "kiro") {
      selected.add("runtime:ecc-kiro");
    }
  }
  return [...selected];
}

function previewRuntimeComponentIds(request: VerifiedEccRequest): string[] {
  return componentIds(request).filter(
    (id) => id !== "runtime:ecc-kiro" || request.selection === undefined,
  );
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function declaredMcpNames(root: string): string[] {
  const inspected = inspectContainedRelativePath(root, ".mcp.json");
  if (inspected.state === "absent") return [];
  if (inspected.state === "unsafe" || inspected.kind !== "file") {
    throw new AihError("refusing unsafe .mcp.json while selecting ECC MCP defaults", "AIH_CONFIG");
  }
  const errors: ParseError[] = [];
  const parsed = parse(readFileSync(inspected.realPath, "utf8"), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    throw new AihError("invalid .mcp.json while selecting ECC MCP defaults", "AIH_CONFIG");
  }
  const servers = objectRecord(objectRecord(parsed)?.mcpServers);
  return servers ? Object.keys(servers) : [];
}

function declarations(options: Record<string, unknown>): string[] {
  const raw = options.with;
  if (Array.isArray(raw) && raw.every((entry): entry is string => typeof entry === "string")) {
    return raw;
  }
  if (typeof raw === "string") return [raw];
  if (raw === undefined) return [];
  throw new AihError("--with declarations must be strings", "AIH_CONFIG");
}

export interface EccRegistrationRequest extends VerifiedEccRequest {
  selection: EccComponentSelection;
  project: ProjectRegistration;
  ledger: RegistrationLedger;
  /** Policy governance makes AIH the sole MCP/hook projector. */
  governance?: true;
}

export function buildEccRegistrationRequest(ctx: PlanContext, clis: Cli[]): EccRegistrationRequest {
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const language = eccLanguages(stack);
  const profile = String(ctx.options.profile ?? "minimal");
  const selected = selectEccComponents({
    stack,
    posture: postureFromContext(ctx),
    profile,
    declarations: declarations(ctx.options),
    declaredMcps: declaredMcpNames(ctx.root),
  });
  const policy = readOrgPolicy(ctx.root, ctx.env);
  const projectMcps = orgAllowedEccMcpComponents(selected.mcps, policy);
  const home = ctx.env.HOME || ctx.env.USERPROFILE || homedir();
  const ledger = readRegistrationLedger(home);
  const project: ProjectRegistration = {
    root: realpathSync(ctx.root),
    scope: selected.scope,
    components: [...selected.components],
    mcps: projectMcps,
    moduleIds: [...(selected.moduleIds ?? [])],
  };
  const preview = mergeRegistrationLedger(ledger, project, []);
  const union = machineRegistrationUnion(preview);
  return {
    clis,
    profile,
    packs: language.packs,
    stackSummary: repoStackSummary(stack),
    selection: {
      scope: preview.projects.some((entry) => entry.scope === "full") ? "full" : "scoped",
      components: union.components as EccComponentId[],
      mcps: orgAllowedEccMcpComponents(union.mcps as EccMcpComponentId[], policy),
      recommendations: [...selected.recommendations],
      moduleIds: [...union.moduleIds],
    },
    project,
    ledger,
    ...(policy?.governance !== undefined ? { governance: true } : {}),
  };
}

function repoStackSummary(stack: RepoStack): string {
  const parts: string[] = [];
  if (stack.languages.length > 0) parts.push(stack.languages.join(" + "));
  if (stack.frameworks.length > 0) parts.push(`using ${stack.frameworks.join(", ")}`);
  if (stack.cloud.length > 0) parts.push(`on ${stack.cloud.join("/")}`);
  return parts.length > 0 ? parts.join(" ") : "a new repository with no detected stack yet";
}

function isMutatingEccTarget(cli: VerifiedEccRequest["clis"][number]): boolean {
  return isAihDirectEccInstallTarget(cli) || cli === "codex";
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
  if (!ctx.apply && deps.source === undefined && typeof ctx.options.eccPath !== "string") {
    return executePlan(
      contingentEccInstallPreviewPlan({
        artifact: deps.installPreview,
        catalog,
        clis: request.clis,
        selection: request.selection,
        runtimeComponentIds: previewRuntimeComponentIds(request),
      }),
      ctx,
    );
  }
  const source = deps.source ?? requestedSource(ctx, catalog);
  if (!ctx.apply && source.kind === "github") {
    try {
      return await executePlan(
        contingentEccInstallPreviewPlan({
          artifact: deps.installPreview,
          catalog,
          clis: request.clis,
          selection: request.selection,
          runtimeComponentIds: previewRuntimeComponentIds(request),
        }),
        ctx,
      );
    } finally {
      cleanupQuarantine(source);
    }
  }
  const buildInstallPlan = deps.buildInstallPlan ?? verifiedEccInstallPlan;
  return executeBaselineEvidencePipeline(
    ctx,
    {
      catalog,
      source,
      componentIds: componentIds(request),
      allowPartial:
        request.selection?.scope !== "full" && (request.selection?.moduleIds?.length ?? 0) === 0,
      acceptanceTuple: deps.acceptanceTuple,
      buildInstallPlan: (sourceRoot, authorizations, held) =>
        buildInstallPlan(ctx, sourceRoot, request, authorizations, held),
    },
    deps,
  );
}

/** Resolve the ordinary ECC command inputs once, then route mutating targets through evidence. */
export async function executeEccCommand(
  ctx: PlanContext,
  deps: EccCommandDeps = {},
): Promise<PlanResult> {
  assertOrgPolicyMutationSource({ ...ctx, posture: postureFromContext(ctx) });
  if (ctx.options.lifecycle !== undefined) {
    const lifecycle = String(ctx.options.lifecycle);
    const policy = readOrgPolicy(ctx.root, ctx.env);
    if (policy?.governance !== undefined && lifecycle === "install") {
      // The governed framework lifecycle, reached by an operator. It replaces
      // the profile installer here rather than wrapping it: AIH-direct
      // materialization is what makes per-component governed control possible,
      // and the framework's own installer projects surfaces governance owns.
      const catalog = deps.catalog ?? requestedCatalog(ctx);
      // Validate the policy against the catalog BEFORE resolving a source:
      // resolving a remote source creates a quarantine directory, and an
      // invocation that refuses must create nothing at all.
      const componentIds = governedEccComponentIds(policy, catalog);
      // WHICH targets is the workstation CLI selection every other
      // target-scoped operation already uses — `--cli`, `--all-tools`, the
      // committed marker, else the `claude` default. No second flag and no
      // policy grammar for it: a governed repository does not get a private
      // notion of "which tool am I installing for". Narrowed here, before the
      // source, for the same reason the catalog check is here.
      const { clis } = await resolveTargets(ctx);
      const targets = assertGovernedMaterializationTargets(clis);
      return executeGovernedEccMaterialization(
        ctx,
        {
          catalog,
          componentIds,
          targets,
          source: deps.source ?? requestedSource(ctx, catalog),
          policy,
        },
        deps,
      );
    }
    if (
      policy?.governance !== undefined &&
      (lifecycle === "update" || lifecycle === "repair" || lifecycle === "rollback")
    ) {
      throw new AihError(
        `\`aih ecc --lifecycle ${lifecycle}\` drives the framework's own profile installer, which may register native MCPs that governance exclusively owns; the governed framework lifecycle is wired instead — \`aih ecc --lifecycle install\` materializes the policy's evidence-passed selection and \`aih uninstall\` removes it receipt-bound`,
        "AIH_CONFIG",
      );
    }
    return (deps.executeProfileLifecycle ?? executeEccProfileLifecycleCommand)(
      ctx,
      deps.profileLifecycle,
    );
  }
  const { clis, detectFellBack } = await resolveTargets(ctx);
  const request = buildEccRegistrationRequest(ctx, clis);
  if (clis.some(isMutatingEccTarget)) return executeEccEvidencePipeline(ctx, request, deps);

  const actions = clis.flatMap((cli) =>
    eccActionsForCli(cli, {
      profile: request.profile,
      stackSummary: request.stackSummary ?? "this repository",
      platform: ctx.host.platform,
      packs: request.packs,
    }),
  );
  actions.push(eccToolsDoc());
  if (detectFellBack) {
    actions.push(doc("no AI CLIs detected — defaulted to claude", detectFallbackNotice()));
  }
  return executePlan(plan("ecc: consult-only targets", ...actions), ctx);
}
