import { join, posix } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import { readIfExists } from "../internals/fsxn.js";
import { skillNameSchema, sourceScopePathSchema } from "./lockfile.js";

/**
 * Committed skill card (docs/security/skill-trust-gate.md) — the one-page,
 * human-auditable record of WHAT a vetted external skill is and WHY it may run
 * here. Derived fields (commit / license / riskClass / requiresMcp /
 * requiresShell / scanEvidence) come from the vet EVIDENCE artifact + shape;
 * owner / pack / intendedUse / mode are operator intent captured at card or
 * approve time. Cards live at `<contextDir>/skill-cards/<name>.json` and are
 * COMMITTED (unlike the gitignored `.aih/skill-reports/` evidence they cite).
 */

/** Approvable risk classes — RED/UNKNOWN sources never get a card. */
const RiskClassSchema = z.enum(["green", "yellow"]);

const SkillCardApprovalSchema = z.object({
  verdict: z.enum(["GREEN", "YELLOW"]),
  approvedBy: z.string().min(1),
  approvedAt: z.string().min(1),
});

const SkillSourceScopeSchema = z.object({
  selectedSkillNames: z.array(skillNameSchema).nonempty(),
  includedPaths: z.array(sourceScopePathSchema).nonempty(),
  excludedSkillPaths: z.array(sourceScopePathSchema),
});

export type SkillSourceScope = z.infer<typeof SkillSourceScopeSchema>;

export const SkillCardSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  source: z.string().min(1),
  commit: z.string().min(1),
  license: z.string().min(1),
  owner: z.string().min(1).optional(),
  pack: z.string().min(1).optional(),
  firstParty: z.boolean().optional(),
  intendedUse: z.string().min(1).optional(),
  installScope: z.string().min(1),
  riskClass: RiskClassSchema,
  mode: z.string().min(1).optional(),
  requiresMcp: z.boolean(),
  requiresShell: z.boolean(),
  writesFiles: z.boolean().optional(),
  networkEgress: z.string().min(1).optional(),
  scanEvidence: z.array(z.string().min(1)),
  sourceScope: SkillSourceScopeSchema.optional(),
  approval: SkillCardApprovalSchema.optional(),
});

export type SkillCard = z.infer<typeof SkillCardSchema>;
export type SkillCardApproval = z.infer<typeof SkillCardApprovalSchema>;
export type SkillRiskClass = z.infer<typeof RiskClassSchema>;

/** The only install scope slice 2 issues; wider scopes arrive with delegation. */
export const SKILL_INSTALL_SCOPE = "repo";

export interface BuildCardInput {
  name: string;
  source: string;
  commit: string;
  license: string;
  riskClass: SkillRiskClass;
  requiresMcp: boolean;
  requiresShell: boolean;
  scanEvidence: string[];
  sourceScope?: SkillSourceScope;
  owner?: string;
  pack?: string;
  firstParty?: boolean;
  intendedUse?: string;
  mode?: string;
  approval?: SkillCardApproval;
}

/** Assemble a card body; JSON rendering drops the unset optional fields. */
export function buildCard(input: BuildCardInput): SkillCard {
  return {
    schemaVersion: 1,
    name: input.name,
    source: input.source,
    commit: input.commit,
    license: input.license,
    owner: input.owner,
    pack: input.pack,
    firstParty: input.firstParty,
    intendedUse: input.intendedUse,
    installScope: SKILL_INSTALL_SCOPE,
    riskClass: input.riskClass,
    mode: input.mode,
    requiresMcp: input.requiresMcp,
    requiresShell: input.requiresShell,
    scanEvidence: [...input.scanEvidence],
    sourceScope: input.sourceScope,
    approval: input.approval,
  };
}

/** Repo-relative committed skill-cards directory (POSIX) — the one place the segment is spelled. */
export function skillCardsDir(contextDir: string): string {
  return posix.join(contextDir, "skill-cards");
}

/** Repo-relative committed card path for a skill name. */
export function skillCardRelPath(contextDir: string, name: string): string {
  const rel = posix.join(skillCardsDir(contextDir), `${name}.json`);
  // DEFENSE IN DEPTH behind the schema-boundary name validation: a traversal name
  // (`../../x`) would normalize OUT of the card directory and steer a destructive
  // consumer (skill remove / pack uninstall) at an arbitrary in-repo file.
  if (!rel.startsWith(`${contextDir}/skill-cards/`)) {
    throw new AihError(`unsafe skill name for card path: ${name}`, "AIH_TRUST");
  }
  return rel;
}

/**
 * Read a committed skill card, or `undefined` when it is absent, unreadable, or
 * fails validation. Fail-SOFT by design (like `readAihConfig`): a hand-edited
 * card must never crash a command — callers treat it as "no card yet".
 */
export function readSkillCard(
  root: string,
  contextDir: string,
  name: string,
): SkillCard | undefined {
  const raw = readIfExists(join(root, skillCardRelPath(contextDir, name)));
  if (raw === undefined) return undefined;
  try {
    return SkillCardSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
