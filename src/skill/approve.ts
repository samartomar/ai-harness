import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import { readIfExists } from "../internals/fsxn.js";
import type { Action, CommandSpec, Plan, PlanContext } from "../internals/plan.js";
import { digest, plan, probe, writeJson } from "../internals/plan.js";
import { AIH_ORG_POLICY_FILE } from "../org-policy/constants.js";
import { readOrgPolicy } from "../org-policy/schema.js";
import { policyWithApprovedSource } from "../trust/commands.js";
import {
  cleanupQuarantine,
  isFirstPartySource,
  localFileHash,
  resolveTrustSource,
  type TrustSource,
} from "../trust/fetch.js";
import { TRUST_SKIP_DIRS } from "../trust/scan.js";
import {
  buildCard,
  SKILL_INSTALL_SCOPE,
  type SkillCard,
  type SkillCardApproval,
  skillCardRelPath,
} from "./card.js";
import {
  AIH_SKILLS_LOCK_FILE,
  readSkillsLockStrictForWrite,
  type SkillLockEntry,
  skillNameSchema,
  upsertSkillLockEntry,
} from "./lockfile.js";
import type { SkillShape } from "./shape.js";

/**
 * `aih skill card` + `aih skill approve` — slice 2 of the skill lifecycle: turn
 * a vet EVIDENCE artifact into committed governance state. Both are WRITE
 * commands (dry-run previews, `--apply` executes) that read the evidence at
 * plan time (pure fs — no spawns) and REFUSE when the evidence chain is broken:
 * no approval without a pin, without evidence, on a RED/UNKNOWN verdict, or
 * without a recorded license. YELLOW *is* approvable — approve IS the manual
 * review the verdict asked for. `approve` writes the card (with approval
 * block), the root `aih-skills.lock.json` entry, and — for GitHub sources —
 * the org-policy approvedSources upsert, in one plan.
 */

const APPROVED_AT_PLACEHOLDER = "(set at apply)";
const LICENSE_MISSING_CODE = "trust.license-missing";
/** Where `skill vet --apply` lands its evidence artifacts (gitignored, content-addressed at approve). */
export const EVIDENCE_DIR = ".aih/skill-reports";

const EvidenceShapeSchema = z.object({
  skillDirs: z.array(z.string()),
  installScripts: z.boolean(),
  installScriptFiles: z.array(z.string()).optional(),
  mcpConfig: z.boolean(),
  mcpConfigFiles: z.array(z.string()).optional(),
  packageManifests: z.array(z.string()),
  fullCodebaseAnalysis: z.boolean(),
});

const EvidenceCheckSchema = z.object({
  name: z.string(),
  verdict: z.enum(["pass", "fail", "skip"]),
  code: z.string().optional(),
  detail: z.string().optional(),
});

/**
 * Runtime mirror of vet.ts's `SkillVetEvidence` artifact, validated on read.
 * Deliberately WIDER on `checks[].code` (any string, not the closed CheckCode
 * union): approve only compares codes for equality, so every vet-authored
 * artifact parses and an unknown code can never crash the gate.
 */
const SkillVetEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.string(),
  pinnedSha: z.string().optional(),
  skillName: skillNameSchema.optional(),
  shape: EvidenceShapeSchema.optional(),
  checks: z.array(EvidenceCheckSchema),
  analyzersRun: z.array(z.string()),
  verdict: z.enum(["GREEN", "YELLOW", "RED", "UNKNOWN"]),
  reasons: z.array(z.string()),
});

type VetEvidence = z.infer<typeof SkillVetEvidenceSchema>;

interface SkillFlagInputs {
  owner?: string;
  pack?: string;
  intendedUse?: string;
  mode?: string;
}

/** Everything the evidence chain proved, resolved once and shared by card/approve. */
interface SkillApprovalGate {
  source: TrustSource;
  evidenceRel: string;
  evidenceSha256: string;
  evidence: VetEvidence;
  shape: SkillShape;
  verdict: "GREEN" | "YELLOW";
  name: string;
  commit: string;
  license: string;
  firstParty: boolean;
  flags: SkillFlagInputs;
}

function refuse(message: string): AihError {
  return new AihError(message, "AIH_TRUST");
}

function optionString(ctx: PlanContext, key: string): string | undefined {
  const raw = ctx.options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function optionPathSafeName(ctx: PlanContext, key: string, label: string): string | undefined {
  const value = optionString(ctx, key);
  if (value === undefined) return undefined;
  const result = skillNameSchema.safeParse(value);
  if (!result.success) {
    throw refuse(
      `--${key} must be a safe ${label} name (path segments only; no .., absolute paths, backslashes, or control chars)`,
    );
  }
  return result.data;
}

function resolveSource(ctx: PlanContext, command: string): { source: TrustSource; raw: string } {
  const raw = optionString(ctx, "source");
  if (raw === undefined) {
    throw refuse(`skill ${command} requires a path or owner/repo source`);
  }
  const source = resolveTrustSource(raw, {
    root: ctx.root,
    pin: optionString(ctx, "pin"),
    skipDirs: TRUST_SKIP_DIRS,
  });
  // card/approve never fetch — drop the quarantine dir resolveTrustSource
  // pre-creates for GitHub sources so a refused approval leaves no tmp litter.
  cleanupQuarantine(source);
  return { source, raw };
}

/** Mirrors vet.ts's private `evidenceRelPath` for an already-pinned/local source. */
function evidenceRelFor(source: TrustSource, skillName?: string): string {
  const tag = source.kind === "local" ? "local" : (source.pin ?? "").slice(0, 8);
  const base = `${EVIDENCE_DIR}/${source.id}-${tag}`;
  return skillName === undefined ? `${base}.json` : `${base}/${skillName}.json`;
}

function vetHint(source: TrustSource, raw: string, skillName?: string): string {
  const pin = source.kind === "github" && source.pin !== undefined ? ` --pin ${source.pin}` : "";
  const scoped = skillName !== undefined ? ` --name ${skillName}` : "";
  return `run \`aih skill vet ${raw}${pin}${scoped} --apply\` first`;
}

function reasonLines(reasons: readonly string[]): string {
  return reasons.length > 0 ? reasons.map((reason) => `  - ${reason}`).join("\n") : "  (none)";
}

function readEvidenceOrRefuse(
  ctx: PlanContext,
  source: TrustSource,
  raw: string,
  skillName?: string,
): { rel: string; evidence: VetEvidence; sha256: string } {
  const rel = evidenceRelFor(source, skillName);
  const abs = join(ctx.root, rel);
  const text = readIfExists(abs);
  if (text === undefined) {
    const subject =
      skillName === undefined ? source.display : `${source.display} --name ${skillName}`;
    throw refuse(`no vet evidence at ${rel} for ${subject}; ${vetHint(source, raw, skillName)}`);
  }
  let evidence: VetEvidence;
  try {
    evidence = SkillVetEvidenceSchema.parse(JSON.parse(text));
  } catch {
    throw refuse(
      `vet evidence at ${rel} is unreadable; ${vetHint(source, raw, skillName)} to regenerate it`,
    );
  }
  if (source.kind === "github" && evidence.pinnedSha?.toLowerCase() !== source.pin) {
    throw refuse(
      `vet evidence at ${rel} records commit ${evidence.pinnedSha ?? "(none)"}, not --pin ${source.pin}; ${vetHint(source, raw, skillName)}`,
    );
  }
  if (skillName !== undefined && evidence.skillName !== skillName) {
    throw refuse(
      `vet evidence at ${rel} is ${
        evidence.skillName === undefined ? "source-wide" : `scoped to --name ${evidence.skillName}`
      }, not --name ${skillName}; ${vetHint(source, raw, skillName)}`,
    );
  }
  if (skillName === undefined && evidence.skillName !== undefined) {
    throw refuse(
      `vet evidence at ${rel} is scoped to --name ${evidence.skillName}; ${vetHint(
        source,
        raw,
      )} for source-wide evidence`,
    );
  }
  // Hash the evidence BYTES so the committed lockfile entry pins the exact
  // local evidence content this approval was granted against.
  return { rel, evidence, sha256: localFileHash(abs) };
}

function assertLocalEvidenceSourceMatches(
  ctx: PlanContext,
  source: TrustSource,
  raw: string,
  rel: string,
  evidence: VetEvidence,
): void {
  if (source.kind !== "local") return;
  try {
    const evidenceRoot = realpathSync(resolve(ctx.root, evidence.source));
    const requestedRoot = realpathSync(source.root);
    if (evidenceRoot === requestedRoot) return;
  } catch {
    // Fall through to the fail-closed error below.
  }
  throw refuse(
    `vet evidence at ${rel} records source ${evidence.source}, not ${raw}; ${vetHint(
      source,
      raw,
    )} to regenerate it`,
  );
}

function hasLicenseMissing(evidence: VetEvidence): boolean {
  return evidence.checks.some(
    (check) => check.verdict === "fail" && check.code === LICENSE_MISSING_CODE,
  );
}

/** The detected license name from vet's `skill license` pass check detail. */
function licenseFromEvidence(evidence: VetEvidence): string | undefined {
  const check = evidence.checks.find(
    (item) => item.name === "skill license" && item.verdict === "pass",
  );
  if (check?.detail === undefined) return undefined;
  const sep = check.detail.indexOf(": ");
  return sep >= 0 ? check.detail.slice(sep + 2) : check.detail;
}

function skillNameFrom(shape: SkillShape, override: string | undefined, display: string): string {
  if (override !== undefined) {
    // An arbitrary override would commit an approval no promotion can ever match
    // (workspace add binds by the PROMOTED name) — validate it names a real skill.
    if (!shape.skillDirs.includes(override)) {
      throw refuse(
        `--name ${override} does not match a skill in ${display} — evidence records: ${
          shape.skillDirs.join(", ") || "(none)"
        }`,
      );
    }
    return override;
  }
  const dirs = shape.skillDirs;
  const sole = dirs[0];
  if (dirs.length === 1 && sole !== undefined) return sole;
  if (dirs.length === 0) {
    throw refuse(`vet evidence for ${display} records no skill directories — nothing to approve`);
  }
  throw refuse(
    `${display} holds ${dirs.length} skills — pass --name to pick one of: ${dirs.join(", ")}`,
  );
}

/**
 * Enforce the evidence chain ("no approval without …") and resolve the shared
 * card/approve inputs. Throws `AIH_TRUST` on any broken link; `approve` layers
 * the --owner requirement and org-policy requiredChecks on top.
 */
function skillApprovalGate(ctx: PlanContext, command: string): SkillApprovalGate {
  const { source, raw } = resolveSource(ctx, command);
  const selectedName = optionPathSafeName(ctx, "name", "skill");
  // Rule 1 — no approval without a pinned commit for remote sources.
  let commit = "local";
  if (source.kind === "github") {
    if (source.pin === undefined) {
      throw refuse(
        `skill ${command} requires --pin <full-sha> for owner/repo sources — pin exactly the commit that was vetted`,
      );
    }
    commit = source.pin;
  }
  // Rule 2 — no approval without a matching vet evidence artifact.
  const { rel, evidence, sha256 } = readEvidenceOrRefuse(ctx, source, raw, selectedName);
  assertLocalEvidenceSourceMatches(ctx, source, raw, rel, evidence);
  // Rule 3 — RED is blocked outright; UNKNOWN means the evidence is insufficient.
  if (evidence.verdict === "RED") {
    throw refuse(
      `vet verdict for ${source.display} is RED — blocked, do not install:\n${reasonLines(evidence.reasons)}`,
    );
  }
  if (evidence.verdict === "UNKNOWN") {
    throw refuse(
      `vet verdict for ${source.display} is UNKNOWN — evidence insufficient:\n${reasonLines(evidence.reasons)}`,
    );
  }
  const shape = evidence.shape;
  if (shape === undefined) {
    throw refuse(`vet evidence at ${rel} has no shape record; ${vetHint(source, raw)}`);
  }
  // Rule 4 — no approval without a recorded license (UNKNOWN already covers a
  // trust.license-missing fail; keep the explicit check anyway).
  const license = hasLicenseMissing(evidence) ? undefined : licenseFromEvidence(evidence);
  if (license === undefined) {
    throw refuse(
      `no license recorded in vet evidence for ${source.display}; a license is required before a card or approval`,
    );
  }
  const name = skillNameFrom(shape, selectedName, source.display);
  return {
    source,
    evidenceRel: rel,
    evidenceSha256: sha256,
    evidence,
    shape,
    verdict: evidence.verdict,
    name,
    commit,
    license,
    firstParty: isFirstPartySource(ctx.root, source),
    flags: {
      owner: optionString(ctx, "owner"),
      pack: optionPathSafeName(ctx, "pack", "pack"),
      intendedUse: optionString(ctx, "intendedUse"),
      mode: optionString(ctx, "mode"),
    },
  };
}

/**
 * Evaluate org-policy `trust.requiredChecks` against the gate. Built-in names:
 * "license", "pin", "no-exec", "no-mcp"; any OTHER name is a detector that must
 * appear in the evidence's analyzersRun — so a typo'd check name fails closed.
 */
function unmetRequiredChecks(required: readonly string[], gate: SkillApprovalGate): string[] {
  const unmet: string[] = [];
  for (const check of required) {
    if (check === "license") {
      if (hasLicenseMissing(gate.evidence)) {
        unmet.push("license — evidence records trust.license-missing");
      }
    } else if (check === "pin") {
      if (gate.source.kind === "github" && gate.source.pin === undefined) {
        unmet.push("pin — GitHub source is not pinned to a commit");
      }
    } else if (check === "no-exec") {
      if (gate.shape.installScripts) unmet.push("no-exec — shape records install scripts");
    } else if (check === "no-mcp") {
      if (gate.shape.mcpConfig) unmet.push("no-mcp — shape records an MCP config");
    } else if (
      !gate.evidence.analyzersRun.some(
        (analyzer) => analyzer === check || analyzer.startsWith(`${check}@`),
      )
    ) {
      unmet.push(
        `${check} — detector missing from evidence (ran: ${gate.evidence.analyzersRun.join(", ") || "none"})`,
      );
    }
  }
  return unmet;
}

function cardFor(gate: SkillApprovalGate, approval?: SkillCardApproval): SkillCard {
  return buildCard({
    name: gate.name,
    source: gate.evidence.source,
    commit: gate.commit,
    license: gate.license,
    riskClass: gate.verdict === "GREEN" ? "green" : "yellow",
    requiresMcp: gate.shape.mcpConfig,
    requiresShell: gate.shape.installScripts,
    scanEvidence: [gate.evidenceRel],
    firstParty: gate.firstParty || undefined,
    owner: gate.flags.owner,
    pack: gate.flags.pack,
    intendedUse: gate.flags.intendedUse,
    mode: gate.flags.mode,
    approval,
  });
}

function enforcementLines(gate: SkillApprovalGate, required: readonly string[]): string[] {
  return [
    "Enforcement:",
    `  - pinned commit: ${gate.commit === "local" ? "n/a (local source)" : gate.commit}`,
    `  - vet evidence: ${gate.evidenceRel} (sha256 ${gate.evidenceSha256.slice(0, 12)}…)`,
    `  - verdict approvable: ${gate.verdict}${
      gate.verdict === "YELLOW" ? " (this approval IS the manual review)" : ""
    }`,
    `  - license recorded: ${gate.license}`,
    `  - owner: ${gate.flags.owner ?? "(none)"}`,
    `  - org-policy required checks: ${
      required.length > 0 ? `${required.join(", ")} — all met` : "(none required)"
    }`,
  ];
}

function approveDigestText(
  gate: SkillApprovalGate,
  required: readonly string[],
  cardRel: string,
  approvedAt: string,
): string {
  return [
    `Skill: ${gate.name}`,
    `Source: ${gate.evidence.source}`,
    `Commit: ${gate.commit}`,
    `Verdict: ${gate.verdict} → riskClass ${gate.verdict === "GREEN" ? "green" : "yellow"}`,
    `Owner: ${gate.flags.owner ?? "(none)"}`,
    `Pack: ${gate.flags.pack ?? "(none)"}`,
    `Card: ${cardRel}`,
    `Lockfile: ${AIH_SKILLS_LOCK_FILE}`,
    `Approved at: ${approvedAt}`,
    ...enforcementLines(gate, required),
  ].join("\n");
}

function skillApprovePlan(ctx: PlanContext): Plan {
  const gate = skillApprovalGate(ctx, "approve");
  // Rule 5 — approvals carry accountability.
  const owner = gate.flags.owner;
  if (owner === undefined) {
    throw refuse(
      "skill approve requires --owner <team> — every approval names an accountable owner",
    );
  }
  const required = readOrgPolicy(ctx.root, ctx.env)?.trust?.requiredChecks ?? [];
  const unmet = unmetRequiredChecks(required, gate);
  if (unmet.length > 0) {
    throw refuse(
      `org-policy requiredChecks are unmet for ${gate.source.display}:\n${unmet
        .map((item) => `  - ${item}`)
        .join("\n")}`,
    );
  }
  // The committed artifacts carry a real timestamp only under --apply; the
  // dry-run preview stays byte-stable (no clock) — trust-lock's promotedAt
  // precedent (workspace/acquire.ts).
  const approvedAt = ctx.apply ? new Date().toISOString() : APPROVED_AT_PLACEHOLDER;
  const cardRel = skillCardRelPath(ctx.contextDir, gate.name);
  const card = cardFor(gate, { verdict: gate.verdict, approvedBy: owner, approvedAt });
  const entry: SkillLockEntry = {
    name: gate.name,
    source: gate.evidence.source,
    commit: gate.commit,
    verdict: gate.verdict,
    pack: gate.flags.pack,
    ...(gate.firstParty ? { firstParty: true } : {}),
    scope: SKILL_INSTALL_SCOPE,
    card: cardRel,
    evidenceSha256: gate.evidenceSha256,
    approvedBy: owner,
    approvedAt,
  };
  const actions: Action[] = [
    writeJson(cardRel, card, `committed skill card for ${gate.name} (approval recorded)`),
    writeJson(
      AIH_SKILLS_LOCK_FILE,
      upsertSkillLockEntry(readSkillsLockStrictForWrite(ctx.root), entry),
      `record ${gate.name} in the committed skill approval lockfile`,
    ),
  ];
  if (gate.source.kind === "github") {
    actions.push(
      writeJson(
        AIH_ORG_POLICY_FILE,
        policyWithApprovedSource(
          ctx,
          { owner: gate.source.owner, repo: gate.source.repo },
          { pinnedSha: gate.commit },
        ),
        "record the approved skill source in committed org-policy",
      ),
    );
  }
  actions.push(
    probe("skill approve gate", () => ({
      name: "skill approve gate",
      verdict: "pass",
      detail: `${gate.name} (${gate.verdict}) approved by ${owner} against ${gate.evidenceRel}`,
    })),
    digest("skill approve summary", approveDigestText(gate, required, cardRel, approvedAt), {
      name: gate.name,
      source: gate.evidence.source,
      commit: gate.commit,
      verdict: gate.verdict,
      riskClass: gate.verdict === "GREEN" ? "green" : "yellow",
      owner,
      pack: gate.flags.pack,
      card: cardRel,
      lockfile: AIH_SKILLS_LOCK_FILE,
      evidence: gate.evidenceRel,
      evidenceSha256: gate.evidenceSha256,
      requiredChecks: [...required],
    }),
  );
  return plan("skill approve", ...actions);
}

function skillCardPlan(ctx: PlanContext): Plan {
  const gate = skillApprovalGate(ctx, "card");
  const cardRel = skillCardRelPath(ctx.contextDir, gate.name);
  const card = cardFor(gate);
  return plan(
    "skill card",
    writeJson(cardRel, card, `committed skill card for ${gate.name}`),
    probe("skill card gate", () => ({
      name: "skill card gate",
      verdict: "pass",
      detail: `${gate.name} card derives from ${gate.evidenceRel} (${gate.verdict})`,
    })),
    digest("skill card", `Card: ${cardRel}\n${JSON.stringify(card, null, 2)}`, {
      path: cardRel,
      card,
    }),
  );
}

const SKILL_CARD_OPTIONS: NonNullable<CommandSpec["options"]> = [
  {
    flags: "--pin <sha>",
    description:
      "the vetted lowercase 40-character Git commit SHA (required for owner/repo sources)",
  },
  {
    flags: "--owner <team>",
    description: "owning team recorded on the card (required to approve)",
  },
  { flags: "--pack <pack>", description: "skill pack the card belongs to" },
  { flags: "--intended-use <text>", description: "intended-use statement recorded on the card" },
  { flags: "--mode <mode>", description: "operating mode recorded on the card (e.g. review-only)" },
  {
    flags: "--name <skill>",
    description: "skill name override when the source holds several skills",
  },
];

export const skillCardCommand: CommandSpec = {
  name: "card",
  summary:
    "Render the committed skill card for a vetted source (no approval block; --apply writes it)",
  options: SKILL_CARD_OPTIONS,
  plan: skillCardPlan,
};

export const skillApproveCommand: CommandSpec = {
  name: "approve",
  summary:
    "Approve a vetted skill — writes the committed card, aih-skills.lock.json entry, and org-policy source",
  options: SKILL_CARD_OPTIONS,
  plan: skillApprovePlan,
};
