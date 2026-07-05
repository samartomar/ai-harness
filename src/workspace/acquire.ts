import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, posix, resolve } from "node:path";
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
import { readIfExists, readRegularFile } from "../internals/fsxn.js";
import { aihIgnoreWrite } from "../internals/gitignore.js";
import type { Action, CommandSpec, Plan, PlanContext, WriteAction } from "../internals/plan.js";
import { plan, structuredChecksProbe, writeJson, writeText } from "../internals/plan.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import type { Check, VerificationReport } from "../internals/verify.js";
import { AIH_ORG_POLICY_FILE } from "../org-policy/constants.js";
import { makeHostAdapter } from "../platform/detect.js";
import { readSkillsLock } from "../skill/lockfile.js";
import { buildSupport, supportSummary } from "../support/integrate.js";
import {
  acknowledgeCommandHint,
  acknowledgeReason,
  applyTrustAcknowledgements,
  hasAcknowledgementRequest,
} from "../trust/acknowledge.js";
import { policyWithApprovedSourceReason } from "../trust/commands.js";
import { resolveInternalScopes } from "../trust/depnames.js";
import {
  assertTrustTreeSafe,
  cleanupQuarantine,
  readTrustFetchMetadata,
  resolveTrustSource,
  safeSourceRelative,
  type TrustFetchMetadata,
  type TrustSource,
} from "../trust/fetch.js";
import { readTrustLock, type TrustLock, type TrustLockSource } from "../trust/lock.js";
import {
  scanOptionsFromContext,
  scanTrustTreeWithAnalyzers,
  type TrustScanResult,
  trustScanPlanForSource,
  trustSourceOriginChecks,
} from "../trust/scan.js";

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
  contents: string;
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
  analyzersRun: string[];
  internalScopes: string[];
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
    {
      flags: "--acknowledge <fingerprints>",
      description: "skip exact trust-origin fingerprint(s), comma-separated",
    },
    {
      flags: "--acknowledge-all",
      description: "skip every current trust-origin finding (requires --reason)",
    },
    { flags: "--reason <text>", description: "reason for a trust-origin acknowledgement" },
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

export async function workspaceAddPhase1Plan(
  ctx: PlanContext,
  resolvedSource?: TrustSource,
): Promise<Plan> {
  const source = resolvedSource ?? sourceFromContext(ctx);
  const scan = await trustScanPlanForSource(ctx, source);
  return plan("workspace add: fetch + scan", aihIgnoreWrite(ctx.root), ...scan.actions);
}

export function collectSkillDirs(root: string): string[] {
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
    if (st.isSymbolicLink()) {
      if (statSync(abs).isFile()) out.push(abs);
      return;
    }
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

export function promotedSkillRel(sourceRoot: string, skillDir: string): string {
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

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function promotionFileBytes(sourceRoot: string, sourcePath: string): Buffer {
  const st = lstatSync(sourcePath);
  const readPath = st.isSymbolicLink() ? realpathSync(sourcePath) : sourcePath;
  if (st.isSymbolicLink()) safeSourceRelative(sourceRoot, readPath);
  const bytes = readRegularFile(readPath);
  if (bytes === undefined) {
    throw new AihError(
      `refusing unreadable or non-regular promotion file: ${sourcePath}`,
      "AIH_TRUST",
    );
  }
  return bytes;
}

/**
 * `selectSkills` (pack installs) narrows the promotion to the skill dirs whose
 * {@link promotedSkillRel} name is in the set — writes, `promotedSkills`, and
 * `artifactHashes` are all filtered. A selected name the source does not ship is
 * a fail-closed refusal: silently promoting fewer skills than the pack curates
 * would leave a half-installed pack that reports success. Default (no set) is
 * byte-identical to the original promote-everything behavior.
 */
function buildPromotion(
  ctx: PlanContext,
  source: TrustSource,
  selectSkills?: ReadonlySet<string>,
): PromotionPlan {
  const sourceRoot = assertTrustTreeSafe(source.kind === "local" ? source.root : source.treePath, {
    skipDirs: SKIP_DIRS,
  });
  const discovered = collectSkillDirs(sourceRoot);
  if (discovered.length === 0) {
    throw new AihError(`no SKILL.md files found in trust source: ${source.display}`, "AIH_TRUST");
  }
  if (selectSkills !== undefined) {
    const available = new Set(discovered.map((skillDir) => promotedSkillRel(sourceRoot, skillDir)));
    const missing = [...selectSkills].filter((name) => !available.has(name)).sort();
    if (missing.length > 0) {
      throw new AihError(
        `pack ref ${missing.join(", ")} not found in source ${source.display}`,
        "AIH_TRUST",
      );
    }
  }
  const skills =
    selectSkills === undefined
      ? discovered
      : discovered.filter((skillDir) => selectSkills.has(promotedSkillRel(sourceRoot, skillDir)));
  if (skills.length === 0) {
    throw new AihError(
      `no skills selected for promotion from trust source: ${source.display}`,
      "AIH_TRUST",
    );
  }
  // NESTED-CHILD guard under a subset: a selected skill's directory can CONTAIN
  // another discovered skill (parent/ and parent/child/ are both valid roots).
  // `collectFiles` descends the whole subtree, so an UNSELECTED nested skill's
  // content would ride along under the parent — promoted without appearing in
  // `promotedSkills`, invisible to the approval gate. Fail closed: every nested
  // skill root under a selected skill must itself be selected (and thus approved).
  if (selectSkills !== undefined) {
    const smuggled: string[] = [];
    for (const skillDir of skills) {
      const parentPrefix = `${skillDir.replace(/\\/g, "/")}/`;
      for (const other of discovered) {
        const otherPosix = other.replace(/\\/g, "/");
        const otherName = promotedSkillRel(sourceRoot, other);
        if (otherPosix.startsWith(parentPrefix) && !selectSkills.has(otherName)) {
          smuggled.push(
            `${promotedSkillRel(sourceRoot, skillDir)} contains nested skill ${otherName}`,
          );
        }
      }
    }
    if (smuggled.length > 0) {
      throw new AihError(
        `refusing subset promotion — unselected nested skill(s) would ride along unapproved:\n` +
          `${smuggled.map((line) => `  - ${line}`).join("\n")}\n` +
          "select (and approve) the nested skill(s) too, or restructure the source",
        "AIH_TRUST",
      );
    }
  }

  const files: PromotionFile[] = skills.flatMap((skillDir) => {
    const skillRel = promotedSkillRel(sourceRoot, skillDir);
    const targetBase = posix.join(ctx.contextDir, "skills", source.id, skillRel);
    return collectFiles(skillDir)
      .filter(isTextPromotionFile)
      .map((sourcePath) => {
        const fileRel = safeSourceRelative(skillDir, sourcePath);
        const sourceRel = safeSourceRelative(sourceRoot, sourcePath);
        const bytes = promotionFileBytes(sourceRoot, sourcePath);
        return {
          sourcePath,
          sourceRel,
          targetRel: posix.join(targetBase, fileRel),
          hash: sha256Bytes(bytes),
          contents: bytes.toString("utf8"),
        };
      });
  });

  return {
    writes: files.map((file) =>
      writeText(file.targetRel, file.contents, `promote trusted skill file ${file.sourceRel}`),
    ),
    promotedSkills: skills.map((skillDir) => promotedSkillRel(sourceRoot, skillDir)),
    artifactHashes: files.map((file) => ({ path: file.sourceRel, sha256: file.hash })),
  };
}

function existingLock(root: string): TrustLock {
  return readTrustLock(root);
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

/**
 * Union-merge guard for repeat promotions of the SAME source content: when the
 * existing lock entry shares the entry's kind + origin AND (for github) the same
 * pinned SHA — i.e. two subset promotions of one identical tree, the pack-install
 * case — replacing it would clobber the earlier promotion's receipts. Merge
 * instead: `promotedSkills` = sorted union, `artifactHashes` = union by path
 * (the NEW promotion wins on a shared path), findings / analyzersRun /
 * promotedAt from the LATEST promotion. A different pinned SHA is a different
 * tree ⇒ replace (the pre-existing behavior); an undefined SHA on either side
 * never merges (fail-closed).
 */
function mergedLockEntry(
  existing: TrustLockSource | undefined,
  entry: TrustLockSource,
): TrustLockSource {
  const sameOrigin =
    existing !== undefined &&
    existing.kind === entry.kind &&
    existing.source === entry.source &&
    (entry.kind !== "github" ||
      (existing.pinnedSha !== undefined && existing.pinnedSha === entry.pinnedSha));
  if (existing === undefined || !sameOrigin) return entry;
  const newPaths = new Set(entry.artifactHashes.map((item) => item.path));
  const carried = existing.artifactHashes.filter((item) => !newPaths.has(item.path));
  return {
    ...entry,
    promotedSkills: [...new Set([...existing.promotedSkills, ...entry.promotedSkills])].sort(
      (a, b) => a.localeCompare(b),
    ),
    artifactHashes: [...carried, ...entry.artifactHashes],
  };
}

/**
 * `subset` = this promotion installed a SELECTED slice of the source (a pack
 * install). Only then do receipts UNION-MERGE with the prior entry — two packs
 * sharing a source must not clobber each other's promotedSkills. A DEFAULT
 * (whole-source) promotion keeps the original replace semantics: it re-promoted
 * everything the source currently ships, so carrying old receipts forward would
 * let a mutable local source's REMOVED skills linger as stale trust-lock evidence.
 */
function lockWithSource(
  ctx: PlanContext,
  source: TrustSource,
  gate: ClearedWorkspaceAddTrustGate,
  promotion: PromotionPlan,
  subset: boolean,
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
    analyzersRun: [...gate.analyzersRun],
    artifactHashes: promotion.artifactHashes,
    findings: gate.report.checks.map((check) => ({
      name: check.name,
      verdict: check.verdict,
      code: check.code,
      detail: check.detail,
      location: check.location,
      fingerprint: check.fingerprint,
    })),
  };
  const existing = current.sources.find((item) => item.id === source.id);
  return {
    schemaVersion: 1,
    sources: [
      ...current.sources.filter((item) => item.id !== source.id),
      subset ? mergedLockEntry(existing, entry) : entry,
    ],
  };
}

function probesForChecks(checks: Check[]): Action[] {
  return checks.map((check) => structuredChecksProbe(check.detail ?? check.name, () => [check]));
}

function acceptedAcknowledgementFingerprints(report: VerificationReport | undefined): string[] {
  return (
    report?.checks
      .filter(
        (check) =>
          check.verdict === "skip" &&
          check.fingerprint !== undefined &&
          (check.detail ?? "").startsWith("acknowledged by"),
      )
      .map((check) => check.fingerprint as string) ?? []
  );
}

async function persistAcknowledgeLedger(
  ctx: PlanContext,
  source: TrustSource,
  report: VerificationReport | undefined,
): Promise<void> {
  if (!ctx.apply || source.kind !== "github") return;
  const fingerprints = acceptedAcknowledgementFingerprints(report);
  const reason = acknowledgeReason(ctx);
  if (fingerprints.length === 0 || reason === undefined) return;
  await executePlan(
    plan(
      "trust acknowledgement ledger",
      writeJson(
        AIH_ORG_POLICY_FILE,
        policyWithApprovedSourceReason(
          ctx,
          { owner: source.owner, repo: source.repo },
          reason,
          fingerprints,
        ),
        "record trust-origin acknowledgement reason in org-policy",
      ),
    ),
    ctx,
  );
}

async function currentTrustScan(
  ctx: PlanContext,
  source: TrustSource,
  internalScopes: readonly string[],
): Promise<TrustScanResult> {
  const scan = await scanTrustTreeWithAnalyzers(sourceRootFor(source), {
    ...scanOptionsFromContext(ctx),
    internalScopes,
    posture: postureFromContext(ctx),
  });
  const checks = [...trustSourceOriginChecks(ctx, source), ...scan.checks];
  return {
    analyzersRun: scan.analyzersRun,
    checks: applyTrustAcknowledgements(checks, ctx).checks,
  };
}

/** Control characters replaced for display — raw names are used only for matching. */
function safeSkillLabel(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "?");
  return cleaned.length > 120 ? `${cleaned.slice(0, 117)}...` : cleaned;
}

/**
 * Posture-gated INSTALL enforcement (#102): every skill this promotion would land
 * must carry a committed `aih-skills.lock.json` approval FOR THIS SOURCE. Matching
 * is content-addressed, not name-only (a same-named skill from an unrelated,
 * never-vetted source must not inherit another source's approval): a GitHub
 * promotion matches only an entry whose `commit` equals the fetched pinned SHA —
 * which also rejects a STALE approval (approved at X, installing Y — re-vet and
 * re-approve); a local promotion matches only a `commit: "local"` entry (local
 * approvals are name-scoped by design — a developer-loop convenience whose recorded
 * path string is not stable across invocation contexts).
 *
 * A missing approval emits a `trust.unapproved-skill` check — ADVISORY at `vibe`
 * (pass with the standard warning-only detail), a promotion-blocking FAIL at
 * `team`/`enterprise`. Graded locally rather than through the shared trust-origin
 * ladder: that ladder denies only at enterprise, but an install-time approval gate
 * is the committed lockfile's teeth and #102 specs team as enforcing too — and
 * widening the shared ladder would harden four already-released origin codes as a
 * side effect. The DENIAL lives in {@link workspaceAddPhase2Plan}'s probes-only
 * path (never a bare throw), so a refusal carries coded checks into the report —
 * SARIF, support tickets, and the run ledger all see it. Pure fs.
 */
function unapprovedSkillChecks(
  ctx: PlanContext,
  source: TrustSource,
  promotedSkills: readonly string[],
): Check[] {
  const entries = readSkillsLock(ctx.root).skills;
  const pinned =
    source.kind === "github" ? metadataFor(source)?.pinnedSha?.toLowerCase() : undefined;
  const isApproved = (name: string): boolean =>
    entries.some(
      (entry) =>
        entry.name === name &&
        (source.kind === "github"
          ? pinned !== undefined && entry.commit.toLowerCase() === pinned
          : entry.commit === "local"),
    );
  const posture = postureFromContext(ctx);
  const at = source.kind === "github" ? ` at commit ${(pinned ?? "unknown").slice(0, 12)}` : "";
  return promotedSkills
    .filter((name) => !isApproved(name))
    .map((name) => {
      const label = safeSkillLabel(name);
      const detail = `skill ${label} has no committed approval in aih-skills.lock.json for this source${at} — run \`aih skill vet <source> --apply\` then \`aih skill approve <source> --pin <sha> --owner <team> --apply\``;
      if (posture === "vibe") {
        return {
          name: `trust.unapproved-skill ${label}`,
          verdict: "pass" as const,
          detail: `warning-only (vibe posture): ${detail}`,
        };
      }
      return {
        name: `trust.unapproved-skill ${label}`,
        verdict: "fail" as const,
        code: "trust.unapproved-skill" as const,
        detail,
      };
    });
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
  resolvedSource?: TrustSource,
  selectSkills?: ReadonlySet<string>,
): Promise<ClearedWorkspaceAddTrustGate> {
  if (!report) throw new AihError("workspace add phase 2 requires a phase 1 report", "AIH_TRUST");
  if (!report.ok) {
    throw new AihError("workspace add failed trust scan; source was not promoted", "AIH_TRUST");
  }
  const source = resolvedSource ?? sourceFromContext(ctx);
  const internalScopes = resolveInternalScopes(ctx);
  const currentScan = await currentTrustScan(ctx, source, internalScopes);
  if (currentScan.checks.some((check) => check.verdict === "fail")) {
    throw new AihError("workspace add source changed after phase 1 scan", "AIH_TRUST");
  }
  const promotion = buildPromotion(ctx, source, selectSkills);
  return {
    source: sourceBinding(source),
    artifactHashes: promotion.artifactHashes,
    report,
    analyzersRun: currentScan.analyzersRun,
    internalScopes,
  };
}

export async function workspaceAddPhase2Plan(
  ctx: PlanContext,
  gate: ClearedWorkspaceAddTrustGate | undefined,
  resolvedSource?: TrustSource,
  selectSkills?: ReadonlySet<string>,
): Promise<Plan> {
  if (!gate) throw new AihError("workspace add phase 2 requires a cleared trust gate", "AIH_TRUST");

  const source = resolvedSource ?? sourceFromContext(ctx);
  const currentBinding = sourceBinding(source);
  if (!sameSourceBinding(gate.source, currentBinding)) {
    return plan(
      "workspace add: promote",
      structuredChecksProbe("trust source binding", () => [
        sourceChangedCheck("trust source identity changed after phase 1 clearance"),
      ]),
    );
  }
  const currentScan = await currentTrustScan(ctx, source, gate.internalScopes);
  if (currentScan.checks.some((check) => check.verdict === "fail")) {
    return plan("workspace add: promote", ...probesForChecks(currentScan.checks));
  }
  const promotion = buildPromotion(ctx, source, selectSkills);
  const approvalChecks = unapprovedSkillChecks(ctx, source, promotion.promotedSkills);
  if (approvalChecks.some((check) => check.verdict === "fail")) {
    return plan("workspace add: promote", ...probesForChecks(approvalChecks));
  }
  if (!sameArtifactHashes(gate.artifactHashes, promotion.artifactHashes)) {
    return plan(
      "workspace add: promote",
      structuredChecksProbe("trust source artifact hashes", () => [
        sourceChangedCheck("trusted source artifacts changed after phase 1 clearance"),
      ]),
    );
  }
  const lock = lockWithSource(ctx, source, gate, promotion, selectSkills !== undefined);
  const actions: Action[] = [
    ...probesForChecks(approvalChecks),
    ...promotion.writes,
    writeJson(".aih/trust-lock.json", lock, "trusted external skill acquisition lock"),
    structuredChecksProbe("trust promotion guard", () => [
      {
        name: "trust promotion guard",
        verdict: "pass",
        detail: "phase 1 trust scan passed before promotion writes were planned",
      },
    ]),
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
  const resolvedRoot = resolve((opts.root as string | undefined) ?? env.AIH_ROOT ?? process.cwd());
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
      acknowledge: opts.acknowledge,
      acknowledgeAll: opts.acknowledgeAll,
      reason: opts.reason,
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
  let source: TrustSource | undefined;
  try {
    const ctx = contextFromCommand(command, deps);
    json = ctx.json;
    source = sourceFromContext(ctx);

    const phase1 = await workspaceAddPhase1Plan(ctx, source);
    const phase1Result = await executePlan(phase1, ctx);
    const phase1Code = phase1Result.report?.exitCode() ?? 0;
    if (phase1Code !== 0 || hasFailedExec(phase1Result)) {
      if (json) write(`${JSON.stringify({ phase1: phase1Result }, null, 2)}\n`);
      else {
        write(`${summarizeResult(phase1Result)}\n`);
        const sourceText = typeof ctx.options.source === "string" ? ctx.options.source : "";
        const hint =
          phase1Result.report && !hasAcknowledgementRequest(ctx)
            ? acknowledgeCommandHint("workspace add", sourceText, phase1Result.report.checks)
            : undefined;
        if (hint) write(`${hint}\n`);
        if (phase1Result.report) {
          saveSupport(ctx, phase1Result.report, opts, env, write, runId, startedAt.toISOString());
        }
      }
      return 1;
    }
    if (!ctx.apply && source.kind === "github") {
      if (json) write(`${JSON.stringify({ phase1: phase1Result }, null, 2)}\n`);
      else write(`${summarizeResult(phase1Result)}\n`);
      return 0;
    }
    await persistAcknowledgeLedger(ctx, source, phase1Result.report);

    const gate = await captureClearedWorkspaceAddTrustGate(ctx, phase1Result.report, source);
    const phase2 = await workspaceAddPhase2Plan(ctx, gate, source);
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
  } finally {
    cleanupQuarantine(source);
  }
}
