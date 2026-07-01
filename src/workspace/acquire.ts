import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, posix } from "node:path";
import type { Command } from "commander";
import { readAihConfig } from "../config/marker.js";
import { postureFromContext, resolvePosture } from "../config/posture.js";
import { loadSettings } from "../config/settings.js";
import { AihError } from "../errors.js";
import { optionSource } from "../internals/commander-options.js";
import {
  executePlan,
  type PlanResult,
  summarizeResult,
  writeArtifact,
} from "../internals/execute.js";
import { readIfExists } from "../internals/fsxn.js";
import { aihIgnoreWrite } from "../internals/gitignore.js";
import type { Action, CommandSpec, Plan, PlanContext, WriteAction } from "../internals/plan.js";
import { plan, probe, writeJson, writeText } from "../internals/plan.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import type { Check, VerificationReport } from "../internals/verify.js";
import { makeHostAdapter } from "../platform/detect.js";
import { buildSupport, supportSummary } from "../support/integrate.js";
import { resolveInternalScopes } from "../trust/depnames.js";
import {
  assertTrustTreeSafe,
  localFileHash,
  readTrustFetchMetadata,
  resolveTrustSource,
  safeSourceRelative,
  type TrustFetchMetadata,
  type TrustSource,
} from "../trust/fetch.js";
import { scanTrustTree, trustScanPlanForSource } from "../trust/scan.js";

interface WorkspaceAddDeps {
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
  now?: () => Date;
  newRunId?: () => string;
}

interface PromotionFile {
  sourcePath: string;
  sourceRel: string;
  targetRel: string;
  hash: string;
}

interface PromotionPlan {
  writes: WriteAction[];
  promotedSkills: string[];
  artifactHashes: Array<{ path: string; sha256: string }>;
}

interface TrustSourceBinding {
  id: string;
  kind: TrustSource["kind"];
  source: string;
  ref?: string;
  pinnedSha?: string;
}

export interface ClearedWorkspaceAddTrustGate {
  source: TrustSourceBinding;
  artifactHashes: Array<{ path: string; sha256: string }>;
  report: VerificationReport;
  internalScopes: string[];
}

interface TrustLock {
  schemaVersion: 1;
  sources: TrustLockSource[];
}

interface TrustLockSource {
  id: string;
  kind: TrustSource["kind"];
  source: string;
  ref?: string;
  pinnedSha?: string;
  promotedAt: string;
  promotedSkills: string[];
  analyzersRun: string[];
  artifactHashes: Array<{ path: string; sha256: string }>;
  findings: Array<{
    name: string;
    verdict: string;
    code?: string;
    detail?: string;
    location?: Check["location"];
    fingerprint?: string;
  }>;
}

const SKIP_DIRS = new Set([".git", ".hg", ".svn", ".aih", "coverage", "dist", "node_modules"]);

export const workspaceAddCommand: CommandSpec = {
  name: "add",
  summary: "Fetch or scan an external skill source, then promote only after trust verification",
  options: [
    {
      flags: "--pin <sha>",
      description: "fetch exactly this Git commit SHA for owner/repo sources",
    },
    { flags: "--ref <ref>", description: "GitHub ref to resolve before downloading the tarball" },
  ],
  plan: workspaceAddPhase1Plan,
  alwaysVerify: true,
};

function optionString(ctx: PlanContext, key: string): string | undefined {
  const raw = ctx.options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}

function sourceFromContext(ctx: PlanContext): TrustSource {
  const source = optionString(ctx, "source");
  if (!source)
    throw new AihError("workspace add requires <owner/repo> or a local path", "AIH_TRUST");
  return resolveTrustSource(source, {
    root: ctx.root,
    ref: optionString(ctx, "ref"),
    pin: optionString(ctx, "pin"),
    skipDirs: SKIP_DIRS,
  });
}

export async function workspaceAddPhase1Plan(ctx: PlanContext): Promise<Plan> {
  const source = sourceFromContext(ctx);
  const scan = await trustScanPlanForSource(ctx, source);
  return plan("workspace add: fetch + scan", aihIgnoreWrite(ctx.root), ...scan.actions);
}

function collectSkillDirs(root: string): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    const st = lstatSync(abs);
    if (!st.isDirectory()) return;
    if (abs !== root && SKIP_DIRS.has(basename(abs))) return;
    if (existsSync(join(abs, "SKILL.md"))) out.push(abs);
    for (const entry of readdirSync(abs)) visit(join(abs, entry));
  };
  visit(root);
  return out.sort((a, b) => sourceDirSortKey(root, a).localeCompare(sourceDirSortKey(root, b)));
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    const st = lstatSync(abs);
    if (st.isDirectory()) {
      if (abs !== root && SKIP_DIRS.has(basename(abs))) return;
      for (const entry of readdirSync(abs)) visit(join(abs, entry));
      return;
    }
    if (st.isFile()) out.push(abs);
  };
  visit(root);
  return out.sort((a, b) => safeSourceRelative(root, a).localeCompare(safeSourceRelative(root, b)));
}

function sourceDirSortKey(sourceRoot: string, skillDir: string): string {
  return skillDir === sourceRoot ? "." : safeSourceRelative(sourceRoot, skillDir);
}

function promotedSkillRel(sourceRoot: string, skillDir: string): string {
  if (skillDir === sourceRoot) return basename(sourceRoot);
  const rel = safeSourceRelative(sourceRoot, skillDir);
  const parts = rel.split("/");
  const skillIndex = parts.indexOf("skills");
  const logical = skillIndex >= 0 ? parts.slice(skillIndex + 1) : parts;
  return logical.length > 0 ? logical.join("/") : basename(skillDir);
}

function isTextPromotionFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === "" || [".md", ".txt", ".json", ".yaml", ".yml", ".toml"].includes(ext);
}

function buildPromotion(ctx: PlanContext, source: TrustSource): PromotionPlan {
  const sourceRoot = assertTrustTreeSafe(source.kind === "local" ? source.root : source.treePath, {
    skipDirs: SKIP_DIRS,
  });
  const skills = collectSkillDirs(sourceRoot);
  if (skills.length === 0) {
    throw new AihError(`no SKILL.md files found in trust source: ${source.display}`, "AIH_TRUST");
  }

  const files: PromotionFile[] = skills.flatMap((skillDir) => {
    const skillRel = promotedSkillRel(sourceRoot, skillDir);
    const targetBase = posix.join(ctx.contextDir, "skills", source.id, skillRel);
    return collectFiles(skillDir)
      .filter(isTextPromotionFile)
      .map((sourcePath) => {
        const fileRel = safeSourceRelative(skillDir, sourcePath);
        const sourceRel = safeSourceRelative(sourceRoot, sourcePath);
        return {
          sourcePath,
          sourceRel,
          targetRel: posix.join(targetBase, fileRel),
          hash: localFileHash(sourcePath),
        };
      });
  });

  return {
    writes: files.map((file) =>
      writeText(
        file.targetRel,
        readFileSync(file.sourcePath, "utf8"),
        `promote trusted skill file ${file.sourceRel}`,
      ),
    ),
    promotedSkills: skills.map((skillDir) => promotedSkillRel(sourceRoot, skillDir)),
    artifactHashes: files.map((file) => ({ path: file.sourceRel, sha256: file.hash })),
  };
}

function existingLock(root: string): TrustLock {
  const existing = readIfExists(join(root, ".aih", "trust-lock.json"));
  if (existing === undefined) return { schemaVersion: 1, sources: [] };
  let parsed: Partial<TrustLock>;
  try {
    parsed = JSON.parse(existing) as Partial<TrustLock>;
  } catch {
    return { schemaVersion: 1, sources: [] };
  }
  return {
    schemaVersion: 1,
    sources: Array.isArray(parsed.sources) ? parsed.sources : [],
  };
}

function metadataFor(source: TrustSource): TrustFetchMetadata | undefined {
  return source.kind === "github" ? readTrustFetchMetadata(source) : undefined;
}

function sourceBinding(source: TrustSource): TrustSourceBinding {
  const meta = metadataFor(source);
  return {
    id: source.id,
    kind: source.kind,
    source: source.kind === "github" ? source.source : source.root,
    ref: source.kind === "github" ? source.ref : undefined,
    pinnedSha: meta?.pinnedSha,
  };
}

function sameSourceBinding(left: TrustSourceBinding, right: TrustSourceBinding): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.source === right.source &&
    left.ref === right.ref &&
    left.pinnedSha === right.pinnedSha
  );
}

function sameArtifactHashes(
  left: Array<{ path: string; sha256: string }>,
  right: Array<{ path: string; sha256: string }>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function lockWithSource(
  ctx: PlanContext,
  source: TrustSource,
  report: VerificationReport,
  promotion: PromotionPlan,
): TrustLock {
  const meta = metadataFor(source);
  const current = existingLock(ctx.root);
  const entry: TrustLockSource = {
    id: source.id,
    kind: source.kind,
    source: source.kind === "github" ? source.source : source.root,
    ref: source.kind === "github" ? source.ref : undefined,
    pinnedSha: meta?.pinnedSha,
    promotedAt: new Date().toISOString(),
    promotedSkills: promotion.promotedSkills,
    analyzersRun: ["aih-native"],
    artifactHashes: promotion.artifactHashes,
    findings: report.checks.map((check) => ({
      name: check.name,
      verdict: check.verdict,
      code: check.code,
      detail: check.detail,
      location: check.location,
      fingerprint: check.fingerprint,
    })),
  };
  return {
    schemaVersion: 1,
    sources: [...current.sources.filter((item) => item.id !== source.id), entry],
  };
}

function probesForChecks(checks: Check[]): Action[] {
  return checks.map((check) => probe(check.detail ?? check.name, () => check));
}

function sourceChangedCheck(detail: string): Check {
  return {
    name: "trust.source-changed",
    verdict: "fail",
    code: "trust.source-changed",
    detail,
  };
}

function sourceRootFor(source: TrustSource): string {
  return source.kind === "local" ? source.root : source.treePath;
}

export async function captureClearedWorkspaceAddTrustGate(
  ctx: PlanContext,
  report: VerificationReport | undefined,
): Promise<ClearedWorkspaceAddTrustGate> {
  if (!report) throw new AihError("workspace add phase 2 requires a phase 1 report", "AIH_TRUST");
  if (!report.ok) {
    throw new AihError("workspace add failed trust scan; source was not promoted", "AIH_TRUST");
  }
  const source = sourceFromContext(ctx);
  const internalScopes = resolveInternalScopes(ctx);
  const currentChecks = await scanTrustTree(sourceRootFor(source), {
    internalScopes,
    posture: postureFromContext(ctx),
  });
  if (currentChecks.some((check) => check.verdict === "fail")) {
    throw new AihError("workspace add source changed after phase 1 scan", "AIH_TRUST");
  }
  const promotion = buildPromotion(ctx, source);
  return {
    source: sourceBinding(source),
    artifactHashes: promotion.artifactHashes,
    report,
    internalScopes,
  };
}

export async function workspaceAddPhase2Plan(
  ctx: PlanContext,
  gate: ClearedWorkspaceAddTrustGate | undefined,
): Promise<Plan> {
  if (!gate) throw new AihError("workspace add phase 2 requires a cleared trust gate", "AIH_TRUST");

  const source = sourceFromContext(ctx);
  const currentBinding = sourceBinding(source);
  if (!sameSourceBinding(gate.source, currentBinding)) {
    return plan(
      "workspace add: promote",
      probe("trust source binding", () =>
        sourceChangedCheck("trust source identity changed after phase 1 clearance"),
      ),
    );
  }
  const currentChecks = await scanTrustTree(sourceRootFor(source), {
    internalScopes: gate.internalScopes,
    posture: postureFromContext(ctx),
  });
  if (currentChecks.some((check) => check.verdict === "fail")) {
    return plan("workspace add: promote", ...probesForChecks(currentChecks));
  }
  const promotion = buildPromotion(ctx, source);
  if (!sameArtifactHashes(gate.artifactHashes, promotion.artifactHashes)) {
    return plan(
      "workspace add: promote",
      probe("trust source artifact hashes", () =>
        sourceChangedCheck("trusted source artifacts changed after phase 1 clearance"),
      ),
    );
  }
  const lock = lockWithSource(ctx, source, gate.report, promotion);
  const actions: Action[] = [
    ...promotion.writes,
    writeJson(".aih/trust-lock.json", lock, "trusted external skill acquisition lock"),
    probe("trust promotion guard", () => ({
      name: "trust promotion guard",
      verdict: "pass",
      detail: "phase 1 trust scan passed before promotion writes were planned",
    })),
  ];
  return plan("workspace add: promote", ...actions);
}

function hasFailedExec(result: PlanResult): boolean {
  return result.execs.some((item) => item.ran && item.ok === false);
}

function readSetupText(root: string): string | undefined {
  for (const rel of ["SETUP.md", "docs/SETUP.md", ".aih/SETUP.md"]) {
    const text = readIfExists(join(root, rel));
    if (text !== undefined) return text;
  }
  return undefined;
}

function saveSupport(
  ctx: PlanContext,
  report: VerificationReport,
  opts: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  write: (text: string) => void,
  runId: string,
  timestamp: string,
): void {
  if (report.checks.length === 0) return;
  const support = buildSupport({
    capability: "workspace add",
    checks: report.checks,
    projectName: basename(ctx.root) || "this project",
    root: ctx.root,
    command: "aih workspace add --verify",
    contextDir: ctx.contextDir,
    targets: (readAihConfig(ctx.root)?.targets ?? []).join(", ") || "none",
    platform: ctx.host.platform,
    runId,
    timestamp,
    setupText: readSetupText(ctx.root),
    env,
  });
  let saved: Record<string, string> | undefined;
  const supportOut = opts.supportOut;
  if (typeof supportOut === "string" && supportOut.length > 0) {
    saved = {};
    for (const template of support.templates) {
      const rel = `${supportOut}/${template.code.replace(/[^a-z0-9.-]/gi, "_")}.md`;
      writeArtifact(ctx, rel, `${template.subject}\n\n${template.body}`);
      saved[template.code] = rel;
    }
  }
  write(supportSummary(support, saved));
}

function contextFromCommand(command: Command, deps: WorkspaceAddDeps): PlanContext {
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRunner;
  const opts = command.optsWithGlobals() as Record<string, unknown>;
  const resolvedRoot = (opts.root as string | undefined) ?? env.AIH_ROOT ?? process.cwd();
  const marker = readAihConfig(resolvedRoot);
  const contextDirSource = optionSource(command, "contextDir");
  const contextDirFromFlag = contextDirSource === "cli" ? (opts.contextDir as string) : undefined;
  const contextDirFromMarker = contextDirFromFlag === undefined ? marker?.contextDir : undefined;
  const postureFlagSource = optionSource(command, "posture") === "cli" ? "cli" : undefined;
  const resolvedPosture = resolvePosture({
    root: resolvedRoot,
    env,
    flag: opts.posture,
    flagSource: postureFlagSource,
    marker,
  });
  const settings = loadSettings(env, {
    apply: opts.apply as boolean | undefined,
    verify: true,
    json: opts.json as boolean | undefined,
    contextDir: contextDirFromFlag ?? contextDirFromMarker,
    root: resolvedRoot,
  });
  const host = makeHostAdapter({ run, env });
  return {
    root: settings.root,
    contextDir: settings.contextDir,
    posture: resolvedPosture.posture,
    postureSource: resolvedPosture.postureSource,
    apply: settings.apply,
    verify: true,
    json: settings.json,
    run,
    host,
    env,
    options: {
      source: command.processedArgs[0],
      pin: opts.pin,
      ref: opts.ref,
      force: opts.force,
    },
  };
}

export async function runWorkspaceAdd(
  command: Command,
  deps: WorkspaceAddDeps = {},
): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const env = deps.env ?? process.env;
  const opts = command.optsWithGlobals() as Record<string, unknown>;
  const runId = (deps.newRunId ?? (() => `run_${randomUUID().slice(0, 8)}`))();
  const startedAt = (deps.now ?? (() => new Date()))();
  let json = false;
  try {
    const ctx = contextFromCommand(command, deps);
    json = ctx.json;

    const phase1 = await workspaceAddPhase1Plan(ctx);
    const phase1Result = await executePlan(phase1, ctx);
    const phase1Code = phase1Result.report?.exitCode() ?? 0;
    if (phase1Code !== 0 || hasFailedExec(phase1Result)) {
      if (json) write(`${JSON.stringify({ phase1: phase1Result }, null, 2)}\n`);
      else {
        write(`${summarizeResult(phase1Result)}\n`);
        if (phase1Result.report) {
          saveSupport(ctx, phase1Result.report, opts, env, write, runId, startedAt.toISOString());
        }
      }
      return 1;
    }
    const source = sourceFromContext(ctx);
    if (!ctx.apply && source.kind === "github") {
      if (json) write(`${JSON.stringify({ phase1: phase1Result }, null, 2)}\n`);
      else write(`${summarizeResult(phase1Result)}\n`);
      return 0;
    }

    const gate = await captureClearedWorkspaceAddTrustGate(ctx, phase1Result.report);
    const phase2 = await workspaceAddPhase2Plan(ctx, gate);
    const phase2Result = await executePlan(phase2, ctx);
    const execFailed = hasFailedExec(phase1Result) || hasFailedExec(phase2Result);
    const phase2Code = phase2Result.report?.exitCode() ?? 0;
    const exitCode = phase2Code || (execFailed ? 1 : 0);

    if (json) {
      write(`${JSON.stringify({ phase1: phase1Result, phase2: phase2Result }, null, 2)}\n`);
    } else {
      write(`${summarizeResult(phase1Result)}\n${summarizeResult(phase2Result)}\n`);
      if (phase2Result.report) {
        saveSupport(ctx, phase2Result.report, opts, env, write, runId, startedAt.toISOString());
      }
    }
    return exitCode;
  } catch (err) {
    const code = err instanceof AihError ? err.code : "AIH_ERROR";
    const message = err instanceof Error ? err.message : String(err);
    if (json) write(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
    else write(`error [${code}]: ${message}\n`);
    return 1;
  }
}
