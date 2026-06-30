import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { AihError } from "../errors.js";
import type { Action, CommandSpec, PlanContext, ProbeAction } from "../internals/plan.js";
import { plan, probe, probeMany } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import {
  assertTrustTreeSafe,
  resolveTrustSource,
  type TrustSource,
  trustFetchExec,
} from "./fetch.js";
import { scanTrustDocument } from "./lint.js";

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".aih",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);
const ROOT_TRUST_DOCS = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function shouldScanTrustDoc(root: string, absPath: string): boolean {
  const rel = toPosix(relative(root, absPath));
  const parts = rel.split("/");
  const name = parts.at(-1) ?? "";
  if (name === "SKILL.md") return true;
  if (parts.length === 1 && ROOT_TRUST_DOCS.has(name)) return true;
  if (extname(name).toLowerCase() !== ".md") return false;
  return parts.includes("skills") || parts.includes("agents") || parts.includes("commands");
}

function collectTrustDocs(root: string): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      if (abs !== root && SKIP_DIRS.has(basename(abs))) return;
      for (const entry of readdirSync(abs)) visit(join(abs, entry));
      return;
    }
    if (st.isFile() && shouldScanTrustDoc(root, abs)) out.push(abs);
  };
  visit(root);
  return out.sort((a, b) => toPosix(relative(root, a)).localeCompare(toPosix(relative(root, b))));
}

function passCheck(root: string, scanned: number): Check {
  return {
    name: "trust scan",
    verdict: "pass",
    detail: `scanned ${scanned} trust document(s) in ${root}`,
  };
}

export async function scanTrustTree(root: string): Promise<Check[]> {
  const safeRoot = assertTrustTreeSafe(root);
  const docs = collectTrustDocs(safeRoot);
  const checks = docs.flatMap((abs) =>
    scanTrustDocument(toPosix(relative(safeRoot, abs)), readFileSync(abs, "utf8")),
  );
  return checks.length > 0 ? checks : [passCheck(safeRoot, docs.length)];
}

function probesForStaticChecks(checks: Check[]): ProbeAction[] {
  return checks.map((check) => probe(check.detail ?? check.name, () => check));
}

export async function trustScanProbes(source: TrustSource): Promise<ProbeAction[]> {
  if (source.kind === "local") {
    return probesForStaticChecks(await scanTrustTree(source.root));
  }
  return [
    probeMany(`trust scan ${source.display}`, async (probeCtx) => {
      if (!probeCtx.apply) {
        return [
          {
            name: "trust scan",
            verdict: "skip",
            detail:
              "remote source fetch is skipped in dry-run; pass --apply to download into quarantine",
          },
        ];
      }
      return scanTrustTree(source.treePath);
    }),
  ];
}

export async function trustScanPlanForSource(
  ctx: PlanContext,
  source: TrustSource,
): Promise<ReturnType<typeof plan>> {
  const actions: Action[] = [];
  if (source.kind === "github") actions.push(trustFetchExec(source, ctx));
  actions.push(...(await trustScanProbes(source)));
  return plan("trust scan", ...actions);
}

async function trustScanPlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const target = ctx.options.target;
  if (typeof target !== "string" || target.trim().length === 0) {
    throw new AihError("trust scan requires a path or owner/repo target", "AIH_TRUST");
  }
  const source = resolveTrustSource(target, {
    root: ctx.root,
    ref: typeof ctx.options.ref === "string" ? ctx.options.ref : undefined,
    pin: typeof ctx.options.pin === "string" ? ctx.options.pin : undefined,
  });
  if (source.kind === "local" && !isAbsolute(target)) {
    return trustScanPlanForSource(ctx, {
      ...source,
      display: toPosix(relative(ctx.root, resolve(ctx.root, target))) || source.display,
    });
  }
  return trustScanPlanForSource(ctx, source);
}

export const trustScanCommand: CommandSpec = {
  name: "scan",
  summary: "Scan a local trust source or GitHub owner/repo before promotion",
  options: [
    {
      flags: "--pin <sha>",
      description: "fetch exactly this Git commit SHA for owner/repo sources",
    },
    { flags: "--ref <ref>", description: "GitHub ref to resolve before downloading the tarball" },
    {
      flags: "--sarif <file>",
      description: "write verification results as SARIF (or - for stdout)",
    },
  ],
  plan: trustScanPlan,
  alwaysVerify: true,
};
