import { isAbsolute, resolve } from "node:path";
import type { Command } from "commander";
import { type Posture, parsePostureInput } from "../config/posture.js";
import { AihError } from "../errors.js";
import { executePlan, summarizeResult } from "../internals/execute.js";
import { type CommandSpec, digest, type PlanContext, plan, writeText } from "../internals/plan.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import { makeHostAdapter } from "../platform/detect.js";
import {
  type AdminCatalogProvenanceV1,
  type ResolveOperationalAdminCatalogV1Input,
  resolveOperationalAdminCatalogV1,
} from "./admin-catalog-operations-v1.js";
import { policyStudioModel } from "./studio-model.js";
import { policyStudioHtml } from "./studio-template.js";

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
function policyGeneratePlan(ctx: PlanContext, catalogProvenance?: AdminCatalogProvenanceV1) {
  const path = outputPath(ctx);
  const model = policyStudioModel(catalogProvenance);
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
        mcpCandidates: model.catalog.mcp.map((candidate) => candidate.id),
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
    const catalogProvenance =
      deps.adminRoot === undefined
        ? undefined
        : await resolveOperationalAdminCatalogV1({
            adminRoot: adminRootArgument(root, deps.adminRoot),
            fetchHttps: deps.catalog?.fetchHttps,
            env,
            now: deps.catalog?.now ?? utcSecondNow(),
            platformAdminRoot: deps.catalog?.platformAdminRoot,
            posture: policyGeneratePosture(opts),
            run,
            tempRoot: deps.catalog?.tempRoot,
          });
    const result = await executePlan(policyGeneratePlan(ctx, catalogProvenance), ctx, {
      skipWorktreeGate: true,
    });
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
