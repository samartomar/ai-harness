import { isAbsolute, resolve } from "node:path";
import type { Command } from "commander";
import { type Posture, parsePostureInput } from "../config/posture.js";
import { AihError } from "../errors.js";
import { executePlan, summarizeResult } from "../internals/execute.js";
import { readRegularFile } from "../internals/fsxn.js";
import { type CommandSpec, digest, type PlanContext, plan, writeText } from "../internals/plan.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import { makeHostAdapter } from "../platform/detect.js";
import { parseArtifactIntakeV1Text } from "../trust/artifact-intake.js";
import { scanExactArtifactIntakeOperationalV1 } from "../trust/scan.js";
import {
  type AdminBaselineEvidenceProvenanceV1,
  type ResolvedAdminBaselineEvidenceV1,
  type ResolveOperationalAdminBaselineEvidenceV1Input,
  resolveOperationalAdminBaselineEvidenceV1,
} from "./admin-baseline-evidence-operations-v1.js";
import {
  type AdminCatalogProvenanceV1,
  type ResolveOperationalAdminCatalogV1Input,
  resolveOperationalAdminCatalogV1,
} from "./admin-catalog-operations-v1.js";
import { policyStudioModel } from "./studio-model.js";
import { policyStudioHtml } from "./studio-template.js";
import { compileOrganizationManifestV1 } from "./workbench/compilers/organization-manifest.js";
import {
  type FreshOrganizationPreparationV1,
  prepareOrganizationManifestWithFreshScanV1,
} from "./workbench/core/organization-preparation.js";

export const DEFAULT_POLICY_WORKBENCH_PATH = "aih-policy-workbench.html";

function outputPath(ctx: PlanContext): string {
  const raw = ctx.options.out;
  if (raw === undefined) return DEFAULT_POLICY_WORKBENCH_PATH;
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.includes("\0")) {
    throw new AihError("--out must be a non-empty file path", "AIH_POLICY_GENERATE");
  }
  return raw.trim();
}

/**
 * Generate a portable, self-contained Policy Workbench. It has no repository
 * scan, policy-floor, runtime projection, or authority-verification dependency.
 *
 * `catalogProvenance` is supplied ONLY by the administrator route, and only
 * after that route has fully resolved and verified the supported catalog — so
 * no rendering can precede resolution.
 */
function policyGeneratePlan(
  ctx: PlanContext,
  catalogProvenance?: AdminCatalogProvenanceV1,
  baselineEvidenceProvenance?: AdminBaselineEvidenceProvenanceV1,
  verifiedBaseline?: { resolved: ResolvedAdminBaselineEvidenceV1; now: string },
  organizationManifestBytes: readonly string[] = [],
  freshOrganizationPreparations: readonly FreshOrganizationPreparationV1[] = [],
) {
  const path = outputPath(ctx);
  const model = policyStudioModel(catalogProvenance, baselineEvidenceProvenance, {
    verifiedBaseline,
    ...(organizationManifestBytes.length === 0 ? {} : { organizationManifestBytes }),
    ...(freshOrganizationPreparations.length === 0 ? {} : { freshOrganizationPreparations }),
  });
  return plan(
    "policy generate",
    writeText(
      path,
      policyStudioHtml(model),
      `portable Policy Workbench → ${path.replace(/\\/g, "/")}`,
      { external: isAbsolute(path) },
    ),
    digest(
      "Policy Workbench — portable authoring artifact",
      [
        "A self-contained policy authoring artifact is planned.",
        "It does not scan a repository, verify authority receipts, or project runtime controls.",
        "Its browser preflight is distinct from target-repository policy evaluation.",
        ...(catalogProvenance === undefined
          ? []
          : [
              `A verified supported catalog was resolved from the ${catalogProvenance.tier} tier before rendering.`,
            ]),
      ].join("\n"),
      {
        output: path.replace(/\\/g, "/"),
        frameworks: model.catalog.frameworks.map((framework) => framework.id),
        mcpCandidates: Object.values(model.workbenchBundle.assets)
          .filter((asset) => asset.kind === "mcp" && asset.authoring.action === "select-control")
          .map((asset) => asset.id)
          .sort(),
        ...(catalogProvenance === undefined ? {} : { catalogTier: catalogProvenance.tier }),
      },
    ),
  );
}

export const policyGenerateCommand: CommandSpec = {
  name: "generate",
  summary: "Generate a portable self-contained Policy Workbench without scanning a repository",
  skipOrgPolicyFloor: true,
  skipWorktreeGate: true,
  options: [
    {
      flags: "--out <path>",
      description: `workbench HTML output path (default ${DEFAULT_POLICY_WORKBENCH_PATH})`,
      default: DEFAULT_POLICY_WORKBENCH_PATH,
    },
    {
      flags: "--organization-manifest <path>",
      description:
        "bounded offline organization authoring manifest to prepare (repeatable; unverified declaration input)",
      repeatable: true,
    },
    {
      flags: "--fresh-organization-manifest <path>",
      description:
        "manifest for explicit applied administrator fresh preparation (repeatable; pairs with --fresh-artifact-intake)",
      repeatable: true,
    },
    {
      flags: "--fresh-artifact-intake <path>",
      description:
        "exact artifact intake for one fresh organization manifest (repeatable; pairs in order)",
      repeatable: true,
    },
  ],
  plan: policyGeneratePlan,
};

export interface PolicyGenerateRunDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
  write?: (text: string) => void;
  /**
   * The `<admin-root>` positional. Absent keeps the rootless portable route,
   * which performs no acquisition, process, or cache work at all.
   */
  adminRoot?: string;
  /** Injected operational boundaries; production uses the module defaults. */
  catalog?: Partial<
    Pick<
      ResolveOperationalAdminCatalogV1Input,
      "fetchHttps" | "now" | "platformAdminRoot" | "tempRoot"
    >
  >;
  /** Administrator-only verified baseline stage; never constructed for portable/dry routes. */
  baseline?: () => Promise<AdminBaselineEvidenceProvenanceV1>;
  /** Test-only operational boundary overrides; production leaves every field unset. */
  baselineOperational?: Partial<
    Pick<
      ResolveOperationalAdminBaselineEvidenceV1Input,
      "fetchHttps" | "now" | "platformAdminRoot" | "tempRoot"
    >
  >;
}

const ORGANIZATION_MANIFEST_MAX_BYTES = 1_000_000;

/**
 * Reads declared organization manifests through the same no-follow regular-file
 * boundary used for other Core inputs. These local declarations are compiled
 * before planning an output, but do not establish scanner evidence, approval,
 * authority, or effect.
 */
function repeatableInputPaths(
  opts: Record<string, unknown>,
  property: string,
  flag: string,
): string[] {
  const raw = opts[property];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 64) {
    throw new AihError(
      `${flag} must be supplied at most 64 times as file paths`,
      "AIH_POLICY_GENERATE",
    );
  }
  return raw.map((value, index) => {
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value !== value.trim() ||
      value.includes("\0")
    ) {
      throw new AihError(
        `${flag} ${index + 1} must be a non-empty path without surrounding whitespace`,
        "AIH_POLICY_GENERATE",
      );
    }
    return value;
  });
}

function boundedUtf8Input(root: string, path: string, flag: string, index: number): string {
  const bytes = readRegularFile(resolve(root, path), {
    maxBytes: ORGANIZATION_MANIFEST_MAX_BYTES,
  });
  if (bytes === undefined) {
    throw new AihError(
      `${flag} ${index + 1} must name a readable non-symlink regular file no larger than 1 MiB`,
      "AIH_POLICY_GENERATE",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AihError(`${flag} ${index + 1} must contain valid UTF-8`, "AIH_POLICY_GENERATE");
  }
}
function organizationManifestBytes(opts: Record<string, unknown>, root: string): string[] {
  const paths = repeatableInputPaths(opts, "organizationManifest", "--organization-manifest");
  return paths.map((path, index) => {
    const manifest = boundedUtf8Input(root, path, "--organization-manifest", index);
    try {
      compileOrganizationManifestV1(manifest);
    } catch (error) {
      throw new AihError(
        `--organization-manifest ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        "AIH_POLICY_GENERATE",
      );
    }
    return manifest;
  });
}

async function freshOrganizationPreparations(
  opts: Record<string, unknown>,
  ctx: PlanContext,
  adminRoot: string | undefined,
  posture: Posture,
): Promise<FreshOrganizationPreparationV1[]> {
  const manifestPaths = repeatableInputPaths(
    opts,
    "freshOrganizationManifest",
    "--fresh-organization-manifest",
  );
  const intakePaths = repeatableInputPaths(opts, "freshArtifactIntake", "--fresh-artifact-intake");
  if (manifestPaths.length === 0 && intakePaths.length === 0) return [];
  if (adminRoot === undefined || !ctx.apply) {
    throw new AihError(
      "fresh organization preparation requires <admin-root> and --apply",
      "AIH_POLICY_GENERATE",
    );
  }
  if (manifestPaths.length === 0 || manifestPaths.length !== intakePaths.length) {
    throw new AihError(
      "--fresh-organization-manifest and --fresh-artifact-intake must be supplied in equal non-empty pairs",
      "AIH_POLICY_GENERATE",
    );
  }
  const scanContext: Omit<PlanContext, "apply" | "run"> = {
    root: adminRoot,
    contextDir: ctx.contextDir,
    verify: ctx.verify,
    json: ctx.json,
    host: ctx.host,
    env: ctx.env,
    posture,
    options: { ...ctx.options, posture },
  };
  const preparations: FreshOrganizationPreparationV1[] = [];
  for (const [index, manifestPath] of manifestPaths.entries()) {
    const intakePath = intakePaths[index];
    if (intakePath === undefined) throw new Error("fresh preparation input pairing was lost");
    const manifest = boundedUtf8Input(
      ctx.root,
      manifestPath,
      "--fresh-organization-manifest",
      index,
    );
    const intake = boundedUtf8Input(ctx.root, intakePath, "--fresh-artifact-intake", index);
    try {
      compileOrganizationManifestV1(manifest);
      parseArtifactIntakeV1Text(intake);
      const witness = await scanExactArtifactIntakeOperationalV1(scanContext, intake);
      preparations.push(
        prepareOrganizationManifestWithFreshScanV1(manifest, witness, new Date().toISOString()),
      );
    } catch (error) {
      throw new AihError(
        `fresh organization preparation ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        "AIH_POLICY_GENERATE",
      );
    }
  }
  return preparations;
}
/** UTC second precision — the only clock granularity the contracts accept. */
function utcSecondNow(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

/**
 * Posture comes from the explicit flag alone. `policy generate` resolves no
 * repository, so no marker, org floor, or environment variable can promote a
 * run to enterprise and steer which canonical bootstrap is trusted.
 */
function policyGeneratePosture(opts: Record<string, unknown>): Posture {
  return opts.posture === undefined ? "vibe" : parsePostureInput(opts.posture, "--posture");
}

function adminRootArgument(root: string, raw: string): string {
  if (raw.trim().length === 0 || raw.includes("\0")) {
    throw new AihError("<admin-root> must be a non-empty path", "AIH_POLICY_GENERATE");
  }
  if (raw.trim() !== raw) {
    throw new AihError(
      "<admin-root> must not contain leading or trailing whitespace",
      "AIH_POLICY_GENERATE",
    );
  }
  return resolve(root, raw);
}

/**
 * Standalone execution route for `aih policy generate`.
 *
 * The workbench is an operator-authored portable artifact, not a repository
 * capability. Deliberately do not call the generic command runner: that path
 * resolves a repository root, reads its marker/settings/policy, and may append
 * its run ledger. Here cwd is used only as containment for a relative --out;
 * --root and AIH_ROOT are parsed compatibility flags with no effect.
 */
export async function runPolicyGenerate(
  command: Command,
  deps: PolicyGenerateRunDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRunner;
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const opts = command.optsWithGlobals() as Record<string, unknown>;
  const json = opts.json === true;
  const root = resolve(deps.cwd ?? process.cwd());
  const ctx: PlanContext = {
    root,
    contextDir: "ai-coding",
    apply: opts.apply === true,
    verify: false,
    json,
    run,
    host: makeHostAdapter({ run, env }),
    env,
    options: typeof opts.out === "string" ? { out: opts.out } : {},
  };
  try {
    if (deps.adminRoot !== undefined && !ctx.apply) {
      throw new AihError(
        "<admin-root> catalog resolution requires --apply; omit <admin-root> for a portable dry run",
        "AIH_POLICY_GENERATE",
      );
    }
    // Resolution happens BEFORE any plan is built, so a fatal catalog outcome
    // can never leave a rendered workbench behind.
    const adminRoot =
      deps.adminRoot === undefined ? undefined : adminRootArgument(root, deps.adminRoot);
    const posture = policyGeneratePosture(opts);
    const manifests = organizationManifestBytes(opts, root);
    const freshPreparations = await freshOrganizationPreparations(opts, ctx, adminRoot, posture);
    const evidenceNow = deps.baselineOperational?.now ?? utcSecondNow();
    const resolvedBaselineEvidence =
      adminRoot === undefined || deps.baseline !== undefined
        ? undefined
        : await resolveOperationalAdminBaselineEvidenceV1({
            adminRoot,
            env,
            fetchHttps: deps.baselineOperational?.fetchHttps,
            now: evidenceNow,
            platformAdminRoot: deps.baselineOperational?.platformAdminRoot,
            posture,
            run,
            tempRoot: deps.baselineOperational?.tempRoot,
          });
    const baselineEvidenceProvenance =
      adminRoot === undefined
        ? undefined
        : deps.baseline !== undefined
          ? await deps.baseline()
          : resolvedBaselineEvidence?.provenance;
    const catalogProvenance =
      adminRoot === undefined
        ? undefined
        : await resolveOperationalAdminCatalogV1({
            adminRoot,
            fetchHttps: deps.catalog?.fetchHttps,
            env,
            now: deps.catalog?.now ?? utcSecondNow(),
            platformAdminRoot: deps.catalog?.platformAdminRoot,
            posture,
            run,
            tempRoot: deps.catalog?.tempRoot,
          });
    const result = await executePlan(
      policyGeneratePlan(
        ctx,
        catalogProvenance,
        baselineEvidenceProvenance,
        resolvedBaselineEvidence === undefined
          ? undefined
          : { resolved: resolvedBaselineEvidence, now: evidenceNow },
        manifests,
        freshPreparations,
      ),
      ctx,
      {
        skipWorktreeGate: true,
      },
    );
    if (json) write(`${JSON.stringify(result, null, 2)}\n`);
    else write(`${summarizeResult(result)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof AihError ? error.code : "AIH_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    if (json) write(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
    else write(`error [${code}]: ${message}\n`);
    return 1;
  }
}
