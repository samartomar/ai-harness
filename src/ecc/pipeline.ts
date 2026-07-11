import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { type ParseError, parse } from "jsonc-parser";
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
import { postureFromContext } from "../config/posture.js";
import { AihError } from "../errors.js";
import { detectFallbackNotice, resolveTargets } from "../internals/cli-detect.js";
import type { Cli } from "../internals/clis.js";
import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import { doc, type PlanContext, plan } from "../internals/plan.js";
import type { RepoStack } from "../profile/scan.js";
import { scanRepo } from "../profile/scan.js";
import { cleanupQuarantine, resolveTrustSource, type TrustSource } from "../trust/fetch.js";
import type { EccComponentId, EccComponentSelection, EccMcpComponentId } from "./components.js";
import { selectEccComponents } from "./components.js";
import { eccEvidenceComponentIds, eccEvidenceComponentIdsForSelection } from "./evidence.js";
import { eccActionsForCli, eccToolsDoc, isAihDirectEccInstallTarget } from "./install.js";
import {
  contingentEccInstallPreviewPlan,
  type EccInstallPreviewArtifact,
} from "./install-preview.js";
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

export interface EccEvidencePipelineDeps extends BaselineEvidencePipelineDeps {
  catalog?: BaselineCatalog;
  source?: TrustSource;
  vendorLock?: BaselineEvidenceLock;
  vendorLockSha256?: string;
  buildInstallPlan?: typeof verifiedEccInstallPlan;
  resolveOrgEvidence?: (
    input: Parameters<typeof resolveOrgBaselineEvidence>[0],
  ) => Promise<ResolveOrgBaselineEvidenceResult>;
  installPreview?: EccInstallPreviewArtifact;
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
}

export function buildEccRegistrationRequest(ctx: PlanContext, clis: Cli[]): EccRegistrationRequest {
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const language = eccLanguages(stack);
  const profile = String(ctx.options.profile ?? "core");
  const selected = selectEccComponents({
    stack,
    posture: postureFromContext(ctx),
    profile,
    declarations: declarations(ctx.options),
    declaredMcps: declaredMcpNames(ctx.root),
  });
  const home = ctx.env.HOME || ctx.env.USERPROFILE || homedir();
  const ledger = readRegistrationLedger(home);
  const project: ProjectRegistration = {
    root: realpathSync(ctx.root),
    scope: selected.scope,
    components: [...selected.components],
    mcps: [...selected.mcps],
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
      mcps: union.mcps as EccMcpComponentId[],
      recommendations: [...selected.recommendations],
    },
    project,
    ledger,
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
      allowPartial: true,
      buildInstallPlan: (sourceRoot, authorizations) =>
        buildInstallPlan(ctx, sourceRoot, request, authorizations),
    },
    deps,
  );
}

/** Resolve the ordinary ECC command inputs once, then route mutating targets through evidence. */
export async function executeEccCommand(ctx: PlanContext): Promise<PlanResult> {
  const { clis, detectFellBack } = await resolveTargets(ctx);
  const request = buildEccRegistrationRequest(ctx, clis);
  if (clis.some(isMutatingEccTarget)) return executeEccEvidencePipeline(ctx, request);

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
