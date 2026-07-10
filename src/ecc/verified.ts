import { join } from "node:path";
import process from "node:process";
import type { BaselineAuthorization } from "../baseline-evidence/verify.js";
import type { Cli } from "../internals/clis.js";
import {
  type Action,
  digest,
  doc,
  type ExecAction,
  exec,
  type Plan,
  type PlanContext,
  plan,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { execArgv } from "../tools/install.js";
import { codexMcpCollisionActions } from "./codex.js";
import { codexEccActions, type EccRepoCheckout, kiroEccActions } from "./index.js";
import { eccActionsForCli, eccToolsDoc, isAihDirectEccInstallTarget } from "./install.js";
import type { EccLanguagePack } from "./select.js";

export interface VerifiedEccRequest {
  clis: Cli[];
  profile: string;
  packs: EccLanguagePack[];
  stackSummary?: string;
}

interface VerifiedInstallStep {
  argv: string[];
  cwd: string;
}

const VERIFIED_ECC_INSTALL_DRIVER = String.raw`
const child = require("node:child_process");
const steps = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
for (const step of steps) {
  if (!step || !Array.isArray(step.argv) || typeof step.cwd !== "string" || step.argv.length === 0) {
    process.stderr.write("invalid verified ECC install step\n");
    process.exit(1);
  }
  const result = child.spawnSync(step.argv[0], step.argv.slice(1), {
    cwd: step.cwd,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) {
    process.stderr.write(result.error.message + "\n");
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
`;

function checkout(sourceRoot: string, pin: string | undefined): EccRepoCheckout {
  return {
    dir: sourceRoot,
    posix: sourceRoot.replace(/\\/g, "/"),
    explicit: true,
    hasCache: false,
    ref: pin,
  };
}

function step(action: ExecAction, fallbackCwd: string): VerifiedInstallStep {
  return { argv: [...action.argv], cwd: action.cwd ?? fallbackCwd };
}

function evidenceDigest(authorizations: readonly BaselineAuthorization[]): Action {
  const summary = authorizations.map(
    (receipt) =>
      `- ${receipt.componentId} — ${receipt.tier} · ${receipt.pinnedSha.slice(0, 12)} · ${receipt.treeSha256.slice(0, 12)}`,
  );
  return digest(
    "ECC baseline evidence authorizations",
    lines("ECC install authorized by signed component evidence:", ...summary),
    { authorizations: [...authorizations] },
  );
}

function driverAction(steps: readonly VerifiedInstallStep[]): Action {
  const encoded = Buffer.from(JSON.stringify(steps), "utf8").toString("base64");
  return exec(
    "Install from the evidence-verified ECC checkout — sequential fail-closed driver",
    [process.execPath, "-e", VERIFIED_ECC_INSTALL_DRIVER, encoded],
    {
      timeoutMs: 180_000,
      failureCheck: (result) => ({
        name: "verified ECC install",
        verdict: "fail",
        detail: `verified ECC install step failed (exit ${result.code ?? "signal"})`,
      }),
    },
  );
}

export function verifiedEccInstallPlan(
  ctx: PlanContext,
  sourceRoot: string,
  request: VerifiedEccRequest,
  authorizations: readonly BaselineAuthorization[],
): Plan {
  const pin = authorizations[0]?.pinnedSha;
  const repo = checkout(sourceRoot, pin);
  const pre: Action[] = [];
  const post: Action[] = [];
  const steps: VerifiedInstallStep[] = [];
  const needsNodeRuntime = request.clis.some(
    (cli) => isAihDirectEccInstallTarget(cli) || cli === "codex",
  );
  if (needsNodeRuntime) {
    steps.push({
      argv: execArgv(ctx.host.platform, [
        "npm",
        "ci",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ]),
      cwd: sourceRoot,
    });
  }

  for (const cli of request.clis) {
    if (isAihDirectEccInstallTarget(cli)) {
      steps.push({
        argv: [
          process.execPath,
          join(sourceRoot, "scripts", "install-apply.js"),
          "--target",
          cli,
          "--profile",
          request.profile,
          ...request.packs,
        ],
        cwd: ctx.root,
      });
      continue;
    }
    if (cli === "codex") {
      const blockers = codexMcpCollisionActions(ctx);
      if (blockers.length > 0) {
        pre.push(...blockers);
        continue;
      }
      for (const action of codexEccActions(ctx, repo, request.profile)) {
        if (action.kind === "exec") {
          if (!action.describe.includes("Node dependencies")) steps.push(step(action, sourceRoot));
        } else if (action.kind === "doc" || action.kind === "digest") post.push(action);
        else pre.push(action);
      }
      continue;
    }
    if (cli === "kiro") {
      for (const action of kiroEccActions(ctx, repo)) {
        if (action.kind === "exec") steps.push(step(action, sourceRoot));
        else if (action.kind === "doc" || action.kind === "digest") post.push(action);
        else pre.push(action);
      }
      continue;
    }
    post.push(
      ...eccActionsForCli(cli, {
        profile: request.profile,
        stackSummary: request.stackSummary ?? "this repository",
        platform: ctx.host.platform,
        packs: request.packs,
      }),
    );
  }

  post.push(eccToolsDoc());

  return plan(
    "ecc: verified install",
    ...pre,
    ...(steps.length > 0 ? [driverAction(steps)] : []),
    ...post,
    doc(
      "ECC verified source",
      `Every mutating ECC step above uses ${sourceRoot.replace(/\\/g, "/")} after component hash verification.`,
    ),
    evidenceDigest(authorizations),
  );
}
