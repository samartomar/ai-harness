import { join } from "node:path";
import { z } from "zod";
import { readIfExists } from "../internals/fsxn.js";

/**
 * Committed skill approval lockfile at the repo ROOT (`aih-skills.lock.json`) —
 * the team-shared record of WHICH external skills are approved, at WHAT commit,
 * against WHICH evidence. Root-level and committed like `aih-org-policy.json`
 * (NOT the gitignored `.aih/`, which holds local evidence), so a fresh clone
 * reads the same approvals the reviewer made.
 */
export const AIH_SKILLS_LOCK_FILE = "aih-skills.lock.json";

export const SkillLockEntrySchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  commit: z.string().min(1),
  verdict: z.enum(["GREEN", "YELLOW"]),
  pack: z.string().min(1).optional(),
  scope: z.string().min(1),
  /** Repo-relative path of the committed skill card this entry approves. */
  card: z.string().min(1),
  /** sha256 of the local vet evidence file the approval was granted against. */
  evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  approvedBy: z.string().min(1).optional(),
  approvedAt: z.string().min(1),
});

export type SkillLockEntry = z.infer<typeof SkillLockEntrySchema>;

export interface SkillsLock {
  schemaVersion: 1;
  skills: SkillLockEntry[];
}

/**
 * Read the committed skills lockfile. Fail-SOFT per entry (mirrors
 * `readTrustLock`): a malformed file yields an empty lock and a malformed ENTRY
 * is dropped while valid siblings survive — so an upsert + rewrite never
 * crashes on hand-edited state, and never amplifies it either.
 */
export function readSkillsLock(root: string): SkillsLock {
  const raw = readIfExists(join(root, AIH_SKILLS_LOCK_FILE));
  if (raw === undefined) return { schemaVersion: 1, skills: [] };
  try {
    const parsed = JSON.parse(raw) as { skills?: unknown };
    const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
    return {
      schemaVersion: 1,
      skills: skills.flatMap((entry) => {
        const result = SkillLockEntrySchema.safeParse(entry);
        return result.success ? [result.data] : [];
      }),
    };
  } catch {
    return { schemaVersion: 1, skills: [] };
  }
}

/** Replace-or-append `entry` by skill name — immutable, name-sorted for stable committed diffs. */
export function upsertSkillLockEntry(lock: SkillsLock, entry: SkillLockEntry): SkillsLock {
  return {
    schemaVersion: 1,
    skills: [...lock.skills.filter((skill) => skill.name !== entry.name), entry].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  };
}
