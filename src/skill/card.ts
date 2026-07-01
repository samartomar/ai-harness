import { join, posix } from "node:path";
import { z } from "zod";
import { readIfExists } from "../internals/fsxn.js";

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

export const SkillCardSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  source: z.string().min(1),
  commit: z.string().min(1),
  license: z.string().min(1),
  owner: z.string().min(1).optional(),
  pack: z.string().min(1).optional(),
  intendedUse: z.string().min(1).optional(),
  installScope: z.string().min(1),
  riskClass: RiskClassSchema,
  mode: z.string().min(1).optional(),
  requiresMcp: z.boolean(),
  requiresShell: z.boolean(),
  writesFiles: z.boolean().optional(),
  networkEgress: z.string().min(1).optional(),
  scanEvidence: z.array(z.string().min(1)),
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
  owner?: string;
  pack?: string;
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
    intendedUse: input.intendedUse,
    installScope: SKILL_INSTALL_SCOPE,
    riskClass: input.riskClass,
    mode: input.mode,
    requiresMcp: input.requiresMcp,
    requiresShell: input.requiresShell,
    scanEvidence: [...input.scanEvidence],
    approval: input.approval,
  };
}

/** Repo-relative committed card path for a skill name. */
export function skillCardRelPath(contextDir: string, name: string): string {
  return posix.join(contextDir, "skill-cards", `${name}.json`);
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
