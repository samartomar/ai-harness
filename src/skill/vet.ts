import { basename, isAbsolute, relative, resolve } from "node:path";
import { AihError } from "../errors.js";
import { writeArtifact } from "../internals/execute.js";
import type { Action, CommandSpec, Plan, PlanContext } from "../internals/plan.js";
import { dynamicDigest, plan, structuredChecksProbe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { resolveInternalScopes } from "../trust/depnames.js";
import {
  cleanupQuarantine,
  isFirstPartySource,
  readTrustFetchMetadata,
  resolveTrustSource,
  type TrustSource,
  trustFetchExec,
} from "../trust/fetch.js";
import {
  scanOptionsFromContext,
  scanTrustTreeWithAnalyzers,
  TRUST_SKIP_DIRS,
  type TrustScanResult,
  trustSourceOriginChecks,
} from "../trust/scan.js";
import {
  assertUniquePromotedSkillNames,
  collectSkillDirs,
  promotedSkillRel,
} from "../workspace/acquire.js";
import { licenseCheck } from "./license.js";
import { skillNameSchema } from "./lockfile.js";
import { type SkillShape, skillShape } from "./shape.js";
import { type SkillVerdict, type SkillVerdictResult, skillVerdict } from "./verdict.js";

/**
 * `aih skill vet` — slice 1 of the skill lifecycle: a READ-ONLY gate pipeline
 * (resolve → fetch-under-apply → shape → license → trust scan → verdict →
 * evidence artifact → digest). It NEVER installs anything; the exit code stays
 * binary through the existing VerificationReport, and the GREEN/YELLOW/RED/
 * UNKNOWN verdict rides the digest / `--json` only.
 */

interface SkillVetPlanOptions {
  cleanupQuarantine?: boolean;
  skillName?: string;
}

/** Evidence artifact schema written to `.aih/skill-reports/` under --apply. */
export interface SkillVetEvidence {
  schemaVersion: 1;
  source: string;
  pinnedSha?: string;
  /** Present when the evidence was scoped to one logical skill via `--name`. */
  skillName?: string;
  /** Absent when the remote source was not fetched (dry-run / fetch failure). */
  shape?: SkillShape;
  checks: Array<{
    name: string;
    verdict: Check["verdict"];
    code?: Check["code"];
    detail?: string;
  }>;
  analyzersRun: string[];
  verdict: SkillVerdict;
  reasons: string[];
}

interface GithubVetScan {
  scan: TrustScanResult;
  shape: SkillShape;
  license: Check;
  pinnedSha?: string;
}

interface SkillVetTarget {
  scanRoot: string;
  smokeShape: SkillShape;
  evidenceShape: SkillShape;
  skillName?: string;
  skillRoot?: string;
}

const FETCH_BLOCKED_SKIP: Check = {
  name: "skill vet scan",
  verdict: "skip",
  code: "trust.fetch-blocked",
  detail: "remote source fetch is skipped in dry-run; pass --apply to download into quarantine",
};

const VERDICT_ACTION: Record<SkillVerdict, string> = {
  GREEN: "install allowed under this policy (skill vet itself never installs)",
  YELLOW: "manual approval required before install",
  RED: "blocked — do not install",
  UNKNOWN: "do not install — evidence insufficient",
};

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function emptyShape(): SkillShape {
  return {
    skillDirs: [],
    installScripts: false,
    mcpConfig: false,
    packageManifests: [],
    fullCodebaseAnalysis: false,
  };
}

function isPinned(source: TrustSource): boolean {
  return source.kind !== "github" || source.pin !== undefined;
}

function fetchedPinnedSha(source: TrustSource): string | undefined {
  if (source.kind !== "github") return undefined;
  try {
    return readTrustFetchMetadata(source).pinnedSha.toLowerCase();
  } catch {
    return source.pin?.toLowerCase();
  }
}

function optionSkillName(ctx: PlanContext): string | undefined {
  const raw = ctx.options.name;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new AihError(
      "--name must be a safe skill name (path segments only; no .., absolute paths, backslashes, or control chars)",
      "AIH_TRUST",
    );
  }
  const result = skillNameSchema.safeParse(raw.trim());
  if (!result.success) {
    throw new AihError(
      "--name must be a safe skill name (path segments only; no .., absolute paths, backslashes, or control chars)",
      "AIH_TRUST",
    );
  }
  return result.data;
}

function evidenceRelPath(
  source: TrustSource,
  pinnedSha: string | undefined,
  skillName?: string,
): string {
  const tag = source.kind === "local" ? "local" : (pinnedSha?.slice(0, 8) ?? "unfetched");
  const base = `.aih/skill-reports/${source.id}-${tag}`;
  return skillName === undefined ? `${base}.json` : `${base}/${skillName}.json`;
}

function prefixRel(prefix: string, rel: string): string {
  if (prefix.length === 0) return rel;
  if (rel.length === 0) return prefix;
  return `${prefix}/${rel}`;
}

function scopedEvidenceShape(
  sourceRoot: string,
  selectedRoot: string,
  skillName: string,
  scopedShape: SkillShape,
): SkillShape {
  const selectedRel = toPosix(relative(sourceRoot, selectedRoot));
  const rootLabel = basename(selectedRoot);
  const scopedSkillDirs = scopedShape.skillDirs.map((dir) =>
    dir === rootLabel ? skillName : prefixRel(skillName, dir),
  );
  return {
    skillDirs: scopedSkillDirs,
    installScripts: scopedShape.installScripts,
    ...(scopedShape.installScriptFiles !== undefined
      ? {
          installScriptFiles: scopedShape.installScriptFiles.map((rel) =>
            prefixRel(selectedRel, rel),
          ),
        }
      : {}),
    mcpConfig: scopedShape.mcpConfig,
    ...(scopedShape.mcpConfigFiles !== undefined
      ? { mcpConfigFiles: scopedShape.mcpConfigFiles.map((rel) => prefixRel(selectedRel, rel)) }
      : {}),
    packageManifests: scopedShape.packageManifests.map((rel) => prefixRel(selectedRel, rel)),
    fullCodebaseAnalysis: scopedShape.fullCodebaseAnalysis,
  };
}

function skillVetTarget(sourceRoot: string, skillName: string | undefined): SkillVetTarget {
  if (skillName === undefined) {
    const shape = skillShape(sourceRoot);
    return { scanRoot: sourceRoot, smokeShape: shape, evidenceShape: shape };
  }
  const skills = collectSkillDirs(sourceRoot).map((dir) => ({
    dir,
    name: promotedSkillRel(sourceRoot, dir),
  }));
  assertUniquePromotedSkillNames(
    sourceRoot,
    skills.map((skill) => skill.dir),
    new Set([skillName]),
  );
  const selected = skills.find((skill) => skill.name === skillName);
  if (selected === undefined) {
    throw new AihError(
      `--name ${skillName} does not match a skill in the source — available skills: ${
        skills.map((skill) => skill.name).join(", ") || "(none)"
      }`,
      "AIH_TRUST",
    );
  }
  const smokeShape = skillShape(selected.dir);
  return {
    scanRoot: selected.dir,
    smokeShape,
    evidenceShape: scopedEvidenceShape(sourceRoot, selected.dir, skillName, smokeShape),
    skillName,
    skillRoot: selected.dir,
  };
}

function buildEvidence(
  source: TrustSource,
  pinnedSha: string | undefined,
  shape: SkillShape | undefined,
  checks: readonly Check[],
  analyzersRun: readonly string[],
  graded: SkillVerdictResult,
  skillName?: string,
): SkillVetEvidence {
  return {
    schemaVersion: 1,
    source: source.display,
    pinnedSha,
    ...(skillName !== undefined ? { skillName } : {}),
    shape,
    checks: checks.map((check) => ({
      name: check.name,
      verdict: check.verdict,
      code: check.code,
      detail: check.detail,
    })),
    analyzersRun: [...analyzersRun],
    verdict: graded.verdict,
    reasons: graded.reasons,
  };
}

function digestData(evidence: SkillVetEvidence): unknown {
  return {
    source: evidence.source,
    pinnedSha: evidence.pinnedSha,
    skillName: evidence.skillName,
    shape: evidence.shape,
    verdict: evidence.verdict,
    reasons: evidence.reasons,
    analyzersRun: evidence.analyzersRun,
  };
}

function shapeLines(shape: SkillShape | undefined): string[] {
  if (shape === undefined) {
    return ["Shape: (not fetched; pass --apply to inspect the quarantined tree)"];
  }
  return [
    "Shape:",
    `  Skill directories: ${shape.skillDirs.length > 0 ? shape.skillDirs.join(", ") : "none"}`,
    `  Install scripts: ${yesNo(shape.installScripts)}`,
    `  MCP config: ${yesNo(shape.mcpConfig)}`,
    `  Package manifests: ${
      shape.packageManifests.length > 0 ? shape.packageManifests.join(", ") : "none"
    }`,
    `  Full-codebase analysis: ${yesNo(shape.fullCodebaseAnalysis)}`,
  ];
}

function checkCounts(checks: SkillVetEvidence["checks"]): string {
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const check of checks) counts[check.verdict] += 1;
  return `${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip`;
}

function renderVetDigest(
  source: TrustSource,
  evidence: SkillVetEvidence,
  evidenceRel?: string,
): string {
  const commit =
    evidence.pinnedSha ?? (source.kind === "local" ? "(local source)" : "(not fetched)");
  const lines = [
    `Source: ${evidence.source}`,
    `Commit: ${commit}`,
    ...(evidence.skillName !== undefined ? [`Skill: ${evidence.skillName}`] : []),
    ...shapeLines(evidence.shape),
    `Checks: ${checkCounts(evidence.checks)}`,
    `Verdict: ${evidence.verdict}`,
    `Action: ${VERDICT_ACTION[evidence.verdict]}`,
    "Reasons:",
    ...(evidence.reasons.length > 0
      ? evidence.reasons.map((reason) => `  - ${reason}`)
      : ["  (none)"]),
  ];
  if (evidenceRel !== undefined) lines.push(`Evidence: ${evidenceRel}`);
  return lines.join("\n");
}

function vetDigestResult(
  ctx: PlanContext,
  source: TrustSource,
  evidence: SkillVetEvidence,
): { text: string; data?: unknown } {
  if (!ctx.apply || evidence.shape === undefined) {
    return { text: renderVetDigest(source, evidence), data: digestData(evidence) };
  }
  const rel = evidenceRelPath(source, evidence.pinnedSha, evidence.skillName);
  writeArtifact(ctx, rel, JSON.stringify(evidence, null, 2));
  return { text: renderVetDigest(source, evidence, rel), data: digestData(evidence) };
}

export async function skillVetPlanForSource(
  ctx: PlanContext,
  source: TrustSource,
  options: SkillVetPlanOptions = {},
): Promise<Plan> {
  const actions: Action[] = [];
  const scanOptions = { internalScopes: resolveInternalScopes(ctx) };
  if (source.kind === "github") actions.push(trustFetchExec(source, ctx));
  actions.push(
    structuredChecksProbe("trust source origin", (probeCtx) =>
      trustSourceOriginChecks(probeCtx, source),
    ),
  );
  if (source.kind === "local") {
    const target = skillVetTarget(source.root, options.skillName);
    const scan = await scanTrustTreeWithAnalyzers(
      target.scanRoot,
      scanOptionsFromContext(ctx, { ...scanOptions, sandboxSmokeShape: target.smokeShape }),
    );
    const staticChecks = [
      ...scan.checks,
      licenseCheck(source.root, { skillRoot: target.skillRoot }),
    ];
    actions.push(
      ...staticChecks.map((check) =>
        structuredChecksProbe(check.detail ?? check.name, () => [check]),
      ),
      dynamicDigest("skill vet verdict", (digestCtx) => {
        const checks = [...trustSourceOriginChecks(digestCtx, source), ...staticChecks];
        const firstParty = isFirstPartySource(digestCtx.root, source);
        const graded = skillVerdict(checks, target.evidenceShape, {
          pinned: true,
          fetched: true,
          firstParty,
        });
        return vetDigestResult(
          digestCtx,
          source,
          buildEvidence(
            source,
            undefined,
            target.evidenceShape,
            checks,
            scan.analyzersRun,
            graded,
            target.skillName,
          ),
        );
      }),
    );
  } else {
    let githubScan: Promise<GithubVetScan> | undefined;
    const scanGithubSource = (probeCtx: PlanContext): Promise<GithubVetScan> => {
      githubScan ??= (async () => {
        const target = skillVetTarget(source.treePath, options.skillName);
        const scan = await scanTrustTreeWithAnalyzers(
          target.scanRoot,
          scanOptionsFromContext(probeCtx, {
            ...scanOptions,
            sandboxSmokeShape: target.smokeShape,
          }),
        );
        return {
          scan,
          shape: target.evidenceShape,
          license: licenseCheck(source.treePath, { skillRoot: target.skillRoot }),
          pinnedSha: fetchedPinnedSha(source),
        };
      })();
      return githubScan;
    };
    const unfetchedEvidence = (digestCtx: PlanContext): SkillVetEvidence => {
      const checks = [...trustSourceOriginChecks(digestCtx, source), FETCH_BLOCKED_SKIP];
      const graded = skillVerdict(checks, emptyShape(), {
        pinned: isPinned(source),
        fetched: false,
        firstParty: false,
      });
      return buildEvidence(
        source,
        source.pin?.toLowerCase(),
        undefined,
        checks,
        [],
        graded,
        options.skillName,
      );
    };
    actions.push(
      structuredChecksProbe(`skill vet scan ${source.display}`, async (probeCtx) => {
        if (!probeCtx.apply) return [FETCH_BLOCKED_SKIP];
        const vetted = await scanGithubSource(probeCtx);
        return [...vetted.scan.checks, vetted.license];
      }),
      dynamicDigest("skill vet verdict", async (digestCtx) => {
        try {
          if (!digestCtx.apply) {
            return vetDigestResult(digestCtx, source, unfetchedEvidence(digestCtx));
          }
          const vetted = await scanGithubSource(digestCtx);
          const checks = [
            ...trustSourceOriginChecks(digestCtx, source),
            ...vetted.scan.checks,
            vetted.license,
          ];
          const graded = skillVerdict(checks, vetted.shape, {
            pinned: isPinned(source),
            fetched: true,
            firstParty: false,
          });
          return vetDigestResult(
            digestCtx,
            source,
            buildEvidence(
              source,
              vetted.pinnedSha,
              vetted.shape,
              checks,
              vetted.scan.analyzersRun,
              graded,
              options.skillName,
            ),
          );
        } catch {
          // A blocked fetch or unreadable quarantine tree degrades to UNKNOWN
          // evidence — the fetch exec's failureCheck already failed the report.
          return vetDigestResult(digestCtx, source, unfetchedEvidence(digestCtx));
        } finally {
          if (options.cleanupQuarantine) cleanupQuarantine(source);
        }
      }),
    );
  }
  return plan("skill vet", ...actions);
}

async function skillVetPlan(ctx: PlanContext): Promise<Plan> {
  const raw = ctx.options.source;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new AihError("skill vet requires a path or owner/repo source", "AIH_TRUST");
  }
  const source = resolveTrustSource(raw, {
    root: ctx.root,
    ref: typeof ctx.options.ref === "string" ? ctx.options.ref : undefined,
    pin: typeof ctx.options.pin === "string" ? ctx.options.pin : undefined,
    skipDirs: TRUST_SKIP_DIRS,
  });
  const skillName = optionSkillName(ctx);
  if (source.kind === "local" && !isAbsolute(raw)) {
    return skillVetPlanForSource(
      ctx,
      {
        ...source,
        display: toPosix(relative(ctx.root, resolve(ctx.root, raw))) || source.display,
      },
      { skillName },
    );
  }
  return skillVetPlanForSource(ctx, source, {
    cleanupQuarantine: source.kind === "github",
    skillName,
  });
}

export const skillVetCommand: CommandSpec = {
  name: "vet",
  summary:
    "Vet an external skill source — shape, license, trust scan, GREEN/YELLOW/RED/UNKNOWN verdict (never installs)",
  options: [
    {
      flags: "--pin <sha>",
      description: "fetch exactly this Git commit SHA for owner/repo sources",
    },
    { flags: "--ref <ref>", description: "GitHub ref to resolve before downloading the tarball" },
    {
      flags: "--name <skill>",
      description: "scope vet evidence to one skill in a multi-skill source",
    },
  ],
  plan: skillVetPlan,
  alwaysVerify: true,
};
