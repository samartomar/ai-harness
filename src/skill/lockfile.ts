import { join } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import { readIfExists } from "../internals/fsxn.js";

/**
 * Committed skill approval lockfile at the repo ROOT (`aih-skills.lock.json`) —
 * the team-shared record of WHICH external skills are approved, at WHAT commit,
 * against WHICH evidence. Root-level and committed like `aih-org-policy.json`
 * (NOT the gitignored `.aih/`, which holds local evidence), so a fresh clone
 * reads the same approvals the reviewer made.
 */
export const AIH_SKILLS_LOCK_FILE = "aih-skills.lock.json";

/**
 * Skill names come from COMMITTED, hand-editable files (the lockfile, pack
 * manifests) and later feed PATH construction (`skillCardRelPath`, promoted-dir
 * resolution). A crafted name like `../../package-lock` would traverse out of the
 * card directory and let a destructive command archive an arbitrary in-repo file —
 * so names are validated at every parse boundary: forward-slash-separated segments
 * only, no empty/`.`/`..` segments, no absolute/drive/UNC forms, no backslashes or
 * control characters.
 */
export const skillNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) => {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
      if (/[\u0000-\u001f\u007f\\]/.test(name)) return false;
      if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
      return name.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
    },
    { message: "unsafe skill name (path segments only; no .., absolute paths, or control chars)" },
  );

export const sourceScopePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
      if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
      if (path.startsWith("/") || path.startsWith("//") || /^[A-Za-z]:/.test(path)) return false;
      if (path === ".") return true;
      return path.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
    },
    { message: "unsafe source scope path (relative POSIX path only; no .. or absolute paths)" },
  );

export const SkillLockEntrySchema = z.object({
  name: skillNameSchema,
  source: z.string().min(1),
  commit: z.string().min(1),
  verdict: z.enum(["GREEN", "YELLOW"]),
  pack: skillNameSchema.optional(),
  /** True when the approval is a first-party (repo-relative local) skill. */
  firstParty: z.boolean().optional(),
  scope: z.string().min(1),
  /** Repo-relative path of the committed skill card this entry approves. */
  card: z.string().min(1),
  /** sha256 of the local vet evidence file the approval was granted against. */
  evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Curated artifact boundary when approval came from scoped `skill vet --name`. */
  sourceScope: z
    .object({
      selectedSkillNames: z.array(skillNameSchema).nonempty(),
      includedPaths: z.array(sourceScopePathSchema).nonempty(),
      excludedSkillPaths: z.array(sourceScopePathSchema),
    })
    .optional(),
  approvedBy: z.string().min(1).optional(),
  approvedAt: z.string().min(1),
});

export type SkillLockEntry = z.infer<typeof SkillLockEntrySchema>;

export interface SkillsLock {
  schemaVersion: 1;
  skills: SkillLockEntry[];
}

const SkillsLockSchema = z
  .object({ schemaVersion: z.literal(1), skills: z.array(SkillLockEntrySchema) })
  .strict();

/**
 * Read the committed skills lockfile. Fail-SOFT per entry (mirrors
 * `readTrustLock`): a malformed file yields an empty lock and a malformed ENTRY
 * is dropped while valid siblings survive — so an upsert + rewrite never
 * crashes on hand-edited state, and never amplifies it either. Duplicate NAMES
 * are dropped the same way (first entry wins): every aih writer dedupes by name,
 * so a duplicate can only come from a hand-edited file — and letting it through
 * would make every by-name join downstream (inventory, packs, marketplace)
 * silently last-write-wins on which source/commit/pack a skill "has".
 */
export function readSkillsLock(root: string): SkillsLock {
  const raw = readIfExists(join(root, AIH_SKILLS_LOCK_FILE));
  if (raw === undefined) return { schemaVersion: 1, skills: [] };
  try {
    const parsed = JSON.parse(raw) as { skills?: unknown };
    const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
    const seen = new Set<string>();
    return {
      schemaVersion: 1,
      skills: skills.flatMap((entry) => {
        const result = SkillLockEntrySchema.safeParse(entry);
        if (!result.success || seen.has(result.data.name)) return [];
        seen.add(result.data.name);
        return [result.data];
      }),
    };
  } catch {
    return { schemaVersion: 1, skills: [] };
  }
}

export function readSkillsLockStrictForWrite(root: string): SkillsLock {
  const raw = readIfExists(join(root, AIH_SKILLS_LOCK_FILE));
  if (raw === undefined) return { schemaVersion: 1, skills: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AihError(
      `cannot update ${AIH_SKILLS_LOCK_FILE}: file is not valid JSON`,
      "AIH_TRUST",
    );
  }
  const result = SkillsLockSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where =
      issue === undefined ? "" : ` at ${issue.path.join(".") || "(root)"}: ${issue.message}`;
    throw new AihError(`cannot update ${AIH_SKILLS_LOCK_FILE}${where}`, "AIH_TRUST");
  }
  const seen = new Set<string>();
  for (const entry of result.data.skills) {
    if (seen.has(entry.name)) {
      throw new AihError(
        `cannot update ${AIH_SKILLS_LOCK_FILE}: duplicate skill entry ${entry.name}`,
        "AIH_TRUST",
      );
    }
    seen.add(entry.name);
  }
  return result.data;
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

/** Drop the entry for `name` — immutable, sibling order preserved (the mirror of {@link upsertSkillLockEntry}). */
export function removeSkillLockEntry(lock: SkillsLock, name: string): SkillsLock {
  return { schemaVersion: 1, skills: lock.skills.filter((skill) => skill.name !== name) };
}
