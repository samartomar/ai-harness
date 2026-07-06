import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { postureFromContext } from "../config/posture.js";
import { AihError } from "../errors.js";
import {
  type CommandSpec,
  digest,
  type PlanContext,
  plan,
  structuredChecksProbe,
  writeJson,
} from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { AIH_ORG_POLICY_FILE } from "../org-policy/constants.js";
import { type OrgPolicy, readOrgPolicy } from "../org-policy/schema.js";
import { isSafeGitRefName, localFileHash, scrubFetchEnv } from "./fetch.js";
import { gradeTrustCheck } from "./grade.js";
import {
  SKILLSPECTOR_IMAGE,
  SKILLSPECTOR_IMAGE_DIGEST,
  SKILLSPECTOR_SOURCE_REVISION,
} from "./images.js";
import { readTrustLock, type TrustLockSource } from "./lock.js";

const OWNER_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const LOWER_FULL_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SKILLSPECTOR_UPSTREAM_REPO = "NVIDIA/SkillSpector";

export interface OwnerRepo {
  owner: string;
  repo: string;
}

export type ApprovedSource = NonNullable<
  NonNullable<OrgPolicy["trust"]>["approvedSources"]
>[number];

function parseOwnerRepo(raw: unknown): OwnerRepo {
  if (typeof raw !== "string") {
    throw new AihError("expected owner/repo", "AIH_TRUST");
  }
  const match = OWNER_REPO.exec(raw.trim());
  if (!match) throw new AihError("expected owner/repo", "AIH_TRUST");
  return { owner: match[1] ?? "", repo: match[2] ?? "" };
}

function optionPin(ctx: PlanContext, required = false): string | undefined {
  const raw = ctx.options.pin;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    if (required) throw new AihError("--pin is required", "AIH_TRUST");
    return undefined;
  }
  const pin = raw.trim();
  if (!LOWER_FULL_SHA.test(pin)) {
    throw new AihError("--pin must be a lowercase 40-character Git commit SHA", "AIH_TRUST");
  }
  return pin;
}

function optionCandidateRevision(ctx: PlanContext): string | undefined {
  const raw = ctx.options.candidateRevision;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new AihError(
      "--candidate-revision must be a lowercase 40-character Git commit SHA",
      "AIH_TRUST",
    );
  }
  const revision = raw.trim();
  if (!LOWER_FULL_SHA.test(revision)) {
    throw new AihError(
      "--candidate-revision must be a lowercase 40-character Git commit SHA",
      "AIH_TRUST",
    );
  }
  return revision;
}

function optionCandidateTag(ctx: PlanContext): string | undefined {
  const raw = ctx.options.candidateTag;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new AihError("--candidate-tag must be a non-empty image tag", "AIH_TRUST");
  }
  const tag = raw.trim();
  if (/\s/.test(tag)) {
    throw new AihError("--candidate-tag must not contain whitespace", "AIH_TRUST");
  }
  return tag;
}

function optionCandidateDigest(ctx: PlanContext): string | undefined {
  const raw = ctx.options.candidateDigest;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new AihError("--candidate-digest must be sha256:<64 lowercase hex chars>", "AIH_TRUST");
  }
  const imageDigest = raw.trim();
  if (!IMAGE_DIGEST.test(imageDigest)) {
    throw new AihError("--candidate-digest must be sha256:<64 lowercase hex chars>", "AIH_TRUST");
  }
  return imageDigest;
}

function emptyPolicy(ctx: PlanContext): OrgPolicy {
  return {
    schemaVersion: 1,
    minimumPosture: "vibe",
    references: { repoContract: `${ctx.contextDir}/project.json` },
  };
}

function policyForWrite(ctx: PlanContext): OrgPolicy {
  try {
    return readOrgPolicy(ctx.root, ctx.env) ?? emptyPolicy(ctx);
  } catch (err) {
    throw new AihError(
      `cannot update ${AIH_ORG_POLICY_FILE}: ${(err as Error).message}`,
      "AIH_TRUST",
    );
  }
}

function sameApprovedSource(source: OwnerRepo, approved: ApprovedSource): boolean {
  return (
    approved.owner.toLowerCase() === source.owner.toLowerCase() &&
    approved.repo.toLowerCase() === source.repo.toLowerCase()
  );
}

function upsertApprovedSource(
  policy: OrgPolicy,
  source: OwnerRepo,
  update: Partial<ApprovedSource>,
): OrgPolicy {
  const existing = policy.trust?.approvedSources ?? [];
  const nextEntry: ApprovedSource = {
    ...(existing.find((approved) => sameApprovedSource(source, approved)) ?? {
      owner: source.owner,
      repo: source.repo,
    }),
    ...update,
  };
  return {
    ...policy,
    trust: {
      requireSignedSource: policy.trust?.requireSignedSource ?? false,
      internalScopes: policy.trust?.internalScopes ?? [],
      requiredDetectors: policy.trust?.requiredDetectors,
      requiredChecks: policy.trust?.requiredChecks,
      approvedSources: [
        ...existing.filter((approved) => !sameApprovedSource(source, approved)),
        nextEntry,
      ].sort(
        (a, b) =>
          a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()) ||
          a.repo.toLowerCase().localeCompare(b.repo.toLowerCase()),
      ),
    },
  };
}

/**
 * Committed policy body with `source` upserted into `trust.approvedSources` —
 * the same upsert `aih trust allow/pin` writes, reused by `aih skill approve`
 * so an approved GitHub skill source lands in org-policy through one code path.
 */
export function policyWithApprovedSource(
  ctx: PlanContext,
  source: OwnerRepo,
  update: Partial<ApprovedSource>,
): OrgPolicy {
  return upsertApprovedSource(policyForWrite(ctx), source, update);
}

export function policyWithApprovedSourceReason(
  ctx: PlanContext,
  source: OwnerRepo,
  reason: string,
  fingerprints: readonly string[],
): OrgPolicy {
  const ledger = `${reason} (acknowledged fingerprints: ${fingerprints.join(",")})`;
  return upsertApprovedSource(policyForWrite(ctx), source, { reason: ledger });
}

function approvedSourceLabel(source: ApprovedSource): string {
  const pin = source.pinnedSha ? ` @ ${source.pinnedSha}` : "";
  const reason = source.reason ? ` — ${source.reason}` : "";
  return `  - ${source.owner}/${source.repo}${pin}${reason}`;
}

function trustLockLabel(source: TrustLockSource): string {
  const pin = source.pinnedSha ? ` @ ${source.pinnedSha}` : "";
  const ref = source.ref ? ` (${source.ref})` : "";
  return `  - ${source.id}: ${source.source}${ref}${pin}`;
}

function trustListText(ctx: PlanContext): string {
  const policy = readOrgPolicy(ctx.root, ctx.env);
  const approved = policy?.trust?.approvedSources ?? [];
  const lock = readTrustLock(ctx.root);
  return [
    "Committed policy approved sources:",
    approved.length > 0 ? approved.map(approvedSourceLabel).join("\n") : "  (none)",
    "",
    "Local trust-lock evidence:",
    lock.sources.length > 0 ? lock.sources.map(trustLockLabel).join("\n") : "  (none)",
  ].join("\n");
}

function skillspectorCompareUrl(candidateRevision: string): string {
  return `https://github.com/${SKILLSPECTOR_UPSTREAM_REPO}/compare/${SKILLSPECTOR_SOURCE_REVISION}...${candidateRevision}`;
}

function skillspectorPinText(ctx: PlanContext): string {
  const candidateRevision = optionCandidateRevision(ctx);
  const candidateTag = optionCandidateTag(ctx);
  const candidateDigest = optionCandidateDigest(ctx);
  const lines = [
    "Pinned SkillSpector image:",
    `  Image tag: ${SKILLSPECTOR_IMAGE}`,
    `  Upstream commit: ${SKILLSPECTOR_SOURCE_REVISION}`,
    `  Image digest: ${SKILLSPECTOR_IMAGE_DIGEST}`,
  ];
  if (
    candidateRevision !== undefined ||
    candidateTag !== undefined ||
    candidateDigest !== undefined
  ) {
    lines.push("", "Candidate SkillSpector pin:");
    if (candidateTag !== undefined) lines.push(`  Image tag: ${candidateTag}`);
    if (candidateRevision !== undefined) lines.push(`  Upstream commit: ${candidateRevision}`);
    if (candidateDigest !== undefined) lines.push(`  Image digest: ${candidateDigest}`);
    if (candidateRevision !== undefined && candidateRevision !== SKILLSPECTOR_SOURCE_REVISION) {
      lines.push(`  Upstream diff: ${skillspectorCompareUrl(candidateRevision)}`);
    }
  }
  return lines.join("\n");
}

function skillspectorPinChecks(ctx: PlanContext): Check[] {
  const candidateRevision = optionCandidateRevision(ctx);
  const candidateTag = optionCandidateTag(ctx);
  const candidateDigest = optionCandidateDigest(ctx);
  const checks: Check[] = [
    {
      name: "trust skillspector pin",
      verdict: "pass",
      detail: `pinned ${SKILLSPECTOR_IMAGE} at ${SKILLSPECTOR_SOURCE_REVISION} (${SKILLSPECTOR_IMAGE_DIGEST})`,
    },
  ];

  if (candidateRevision !== undefined && candidateRevision !== SKILLSPECTOR_SOURCE_REVISION) {
    checks.push({
      name: "trust skillspector upstream diff",
      verdict: "fail",
      code: "trust.source-drift",
      detail: `candidate SkillSpector upstream commit ${candidateRevision} differs from pinned ${SKILLSPECTOR_SOURCE_REVISION}; review upstream diff before accepting pin bump: ${skillspectorCompareUrl(candidateRevision)}`,
      fingerprint: `trust-skillspector-pin:bump:${candidateRevision.slice(0, 12)}`,
    });
  }

  const existingTagReused = candidateTag === SKILLSPECTOR_IMAGE;
  const revisionChanged =
    candidateRevision !== undefined && candidateRevision !== SKILLSPECTOR_SOURCE_REVISION;
  const digestChanged =
    candidateDigest !== undefined && candidateDigest !== SKILLSPECTOR_IMAGE_DIGEST;
  if (existingTagReused && (revisionChanged || digestChanged)) {
    const changes = [
      revisionChanged ? `upstream commit ${candidateRevision}` : undefined,
      digestChanged ? `digest ${candidateDigest}` : undefined,
    ].filter((change): change is string => change !== undefined);
    checks.push({
      name: "trust skillspector retag",
      verdict: "fail",
      code: "trust.source-changed",
      detail: `retagging existing SkillSpector image tag ${SKILLSPECTOR_IMAGE} with ${changes.join(" and ")} is not accepted; use a new tag after reviewing the upstream diff`,
      fingerprint: `trust-skillspector-pin:retag:${SKILLSPECTOR_IMAGE}`,
    });
  }

  return checks;
}

function lockSourcesFor(ctx: PlanContext): TrustLockSource[] {
  const id = typeof ctx.options.id === "string" ? ctx.options.id.trim() : "";
  const sources = readTrustLock(ctx.root).sources;
  return id.length > 0 ? sources.filter((source) => source.id === id) : sources;
}

function artifactTarget(ctx: PlanContext, source: TrustLockSource, artifactPath: string): string {
  const normalized = artifactPath.replace(/\\/g, "/");
  const sortedSkills = [...source.promotedSkills].sort((a, b) => b.length - a.length);
  for (const skill of sortedSkills) {
    for (const prefix of [`skills/${skill}/`, `${skill}/`]) {
      if (normalized.startsWith(prefix)) {
        return join(
          ctx.root,
          ctx.contextDir,
          "skills",
          source.id,
          skill,
          normalized.slice(prefix.length),
        );
      }
    }
  }
  const fallbackSkill = sortedSkills[0] ?? basename(source.id);
  return join(ctx.root, ctx.contextDir, "skills", source.id, fallbackSkill, normalized);
}

export function localDriftChecks(ctx: PlanContext, source: TrustLockSource): Check[] {
  return source.artifactHashes.map((artifact) => {
    const target = artifactTarget(ctx, source, artifact.path);
    if (!existsSync(target)) {
      return {
        name: "trust local drift",
        verdict: "fail",
        code: "trust.source-changed",
        detail: `${source.id}: local drift — promoted artifact missing at ${artifact.path}`,
        location: { uri: artifact.path },
        fingerprint: `trust-local-drift:${source.id}:${artifact.path}`,
      };
    }
    const current = localFileHash(target);
    if (current === artifact.sha256) {
      return {
        name: "trust local drift",
        verdict: "pass",
        detail: `${source.id}: ${artifact.path} matches trust-lock hash`,
      };
    }
    return {
      name: "trust local drift",
      verdict: "fail",
      code: "trust.source-changed",
      detail: `${source.id}: local drift — promoted artifact ${artifact.path} hash changed after acquisition`,
      location: { uri: artifact.path },
      fingerprint: `trust-local-drift:${source.id}:${artifact.path}:${current.slice(0, 8)}`,
    };
  });
}

export function trustLockLocalDriftChecks(ctx: PlanContext): Check[] {
  const lockPath = join(ctx.root, ".aih", "trust-lock.json");
  if (!existsSync(lockPath)) {
    return [
      {
        name: "trust local drift",
        verdict: "skip",
        detail: "no .aih/trust-lock.json — no promoted trust artifacts to re-hash",
      },
    ];
  }
  const sources = readTrustLock(ctx.root).sources;
  if (sources.length === 0) {
    return [
      {
        name: "trust local drift",
        verdict: "skip",
        detail: ".aih/trust-lock.json has no valid promoted sources to re-hash",
      },
    ];
  }
  const checks = sources.flatMap((source) => localDriftChecks(ctx, source));
  return checks.length > 0
    ? checks
    : [
        {
          name: "trust local drift",
          verdict: "pass",
          detail: "trust-lock contains no promoted artifact hashes",
        },
      ];
}

function isFullSha(value: string | undefined): boolean {
  return value !== undefined && LOWER_FULL_SHA.test(value);
}

function parseLsRemoteSha(stdout: string): string | undefined {
  const first = stdout.trim().split(/\s+/)[0];
  return first && LOWER_FULL_SHA.test(first) ? first : undefined;
}

async function upstreamDriftCheck(ctx: PlanContext, source: TrustLockSource): Promise<Check> {
  if (source.kind !== "github") {
    return { name: "trust upstream drift", verdict: "pass", detail: `${source.id}: local source` };
  }
  if (source.pinnedSha === undefined) {
    return {
      name: "trust upstream drift",
      verdict: "skip",
      code: "trust.fetch-blocked",
      detail: `${source.id}: no recorded pinned SHA in trust-lock`,
    };
  }
  if (isFullSha(source.ref) && source.ref === source.pinnedSha) {
    return {
      name: "trust upstream drift",
      verdict: "pass",
      detail: `${source.id}: pinned SHA source cannot drift upstream`,
    };
  }
  if (!ctx.apply) {
    return {
      name: "trust upstream drift",
      verdict: "skip",
      code: "trust.fetch-blocked",
      detail: "git ls-remote is skipped in dry-run; pass --apply to verify upstream drift",
    };
  }
  const ref = source.ref ?? "HEAD";
  if (!isSafeGitRefName(ref)) {
    return {
      name: "trust upstream drift",
      verdict: "skip",
      code: "trust.fetch-blocked",
      detail: `${source.id}: unsafe Git ref in trust-lock (${ref}); refusing git ls-remote`,
    };
  }
  const result = await ctx.run(
    ["git", "ls-remote", `https://github.com/${source.source}.git`, ref],
    {
      env: scrubFetchEnv(ctx.env),
      timeoutMs: 30_000,
    },
  );
  if (result.spawnError || result.code !== 0) {
    return {
      name: "trust upstream drift",
      verdict: "skip",
      code: "trust.fetch-blocked",
      detail: `${source.id}: git ls-remote ${ref} could not run (${result.stderr || result.stdout || `exit ${result.code}`})`,
    };
  }
  const current = parseLsRemoteSha(result.stdout);
  if (current === undefined) {
    return gradeTrustCheck(
      {
        name: "trust upstream drift",
        verdict: "fail",
        code: "trust.source-drift",
        detail: `${source.id}: ${ref} no longer resolves upstream`,
        fingerprint: `trust-source-drift:${source.id}:${ref}:missing`,
      },
      postureFromContext(ctx),
    );
  }
  if (current === source.pinnedSha) {
    return {
      name: "trust upstream drift",
      verdict: "pass",
      detail: `${source.id}: ${ref} still resolves to recorded SHA`,
    };
  }
  return gradeTrustCheck(
    {
      name: "trust upstream drift",
      verdict: "fail",
      code: "trust.source-drift",
      detail: `${source.id}: ${ref} now resolves to ${current}; trust-lock recorded ${source.pinnedSha}`,
      fingerprint: `trust-source-drift:${source.id}:${ref}:${current.slice(0, 8)}`,
    },
    postureFromContext(ctx),
  );
}

export const trustAllowCommand: CommandSpec = {
  name: "allow",
  summary: "Allow a reviewed GitHub owner/repo in org-policy trust.approvedSources",
  options: [{ flags: "--pin <sha>", description: "record a lowercase 40-character pinned SHA" }],
  plan: (ctx) => {
    const source = parseOwnerRepo(ctx.options.source);
    const pin = optionPin(ctx);
    return plan(
      "trust allow",
      writeJson(
        AIH_ORG_POLICY_FILE,
        upsertApprovedSource(policyForWrite(ctx), source, pin ? { pinnedSha: pin } : {}),
        "update committed trust approved sources",
      ),
      structuredChecksProbe("trust allow policy", () => [
        {
          name: "trust allow policy",
          verdict: "pass",
          detail: `${source.owner}/${source.repo} is present in ${AIH_ORG_POLICY_FILE}`,
        },
      ]),
    );
  },
  alwaysVerify: true,
};

export const trustPinCommand: CommandSpec = {
  name: "pin",
  summary: "Record or refresh the approved pinned SHA for a GitHub owner/repo",
  options: [{ flags: "--pin <sha>", description: "lowercase 40-character pinned SHA" }],
  plan: (ctx) => {
    const source = parseOwnerRepo(ctx.options.source);
    const pin = optionPin(ctx, true);
    return plan(
      "trust pin",
      writeJson(
        AIH_ORG_POLICY_FILE,
        upsertApprovedSource(policyForWrite(ctx), source, { pinnedSha: pin }),
        "pin committed trust approved source",
      ),
      structuredChecksProbe("trust pin policy", () => [
        {
          name: "trust pin policy",
          verdict: "pass",
          detail: `${source.owner}/${source.repo} pinned to ${pin}`,
        },
      ]),
    );
  },
  alwaysVerify: true,
};

export const trustListCommand: CommandSpec = {
  name: "list",
  summary: "List committed trust policy sources and local trust-lock evidence",
  plan: (ctx) => plan("trust list", digest("trust sources", trustListText(ctx))),
};

export const trustSkillspectorPinCommand: CommandSpec = {
  name: "skillspector-pin",
  summary: "Report and review the pinned SkillSpector analyzer image",
  options: [
    {
      flags: "--candidate-revision <sha>",
      description:
        "proposed upstream SkillSpector commit SHA to compare before accepting a pin bump",
    },
    {
      flags: "--candidate-tag <tag>",
      description: "proposed SkillSpector image tag",
    },
    {
      flags: "--candidate-digest <digest>",
      description: "proposed SkillSpector image digest as sha256:<64 lowercase hex chars>",
    },
  ],
  plan: (ctx) =>
    plan(
      "trust skillspector-pin",
      digest("skillspector pin", skillspectorPinText(ctx)),
      structuredChecksProbe("trust skillspector pin", () => skillspectorPinChecks(ctx)),
    ),
  alwaysVerify: true,
};

export const trustVerifyCommand: CommandSpec = {
  name: "verify",
  summary: "Verify promoted trust-lock artifacts and upstream source refs",
  options: [
    {
      flags: "--sarif <file>",
      description: "write verification results as SARIF (or - for stdout)",
    },
  ],
  plan: (ctx) => {
    const sources = lockSourcesFor(ctx);
    const checks = sources.flatMap((source) => localDriftChecks(ctx, source));
    return plan(
      "trust verify",
      ...checks.map((check) => structuredChecksProbe(check.detail ?? check.name, () => [check])),
      ...sources.map((source) =>
        structuredChecksProbe(`trust upstream drift: ${source.id}`, async (probeCtx) => [
          await upstreamDriftCheck(probeCtx, source),
        ]),
      ),
    );
  },
  alwaysVerify: true,
};
