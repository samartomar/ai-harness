import { join } from "node:path";
import { z } from "zod";
import { readIfExists } from "../internals/fsxn.js";

/**
 * Committed pack manifest at the repo ROOT (`aih-packs.json`) — a NAMED curation
 * over the shipped per-skill lifecycle. A pack groups approved skills so a team
 * can reason about "the docs-quality set" instead of N individual names. The
 * committed `aih-skills.lock.json` stays the PIN AUTHORITY: each ref's
 * `{source, commit}` here is only a fail-closed CROSS-CHECK against the lock
 * entry (a disagreement is a `pack.pin-mismatch` finding, never a second pin).
 * No parallel lockfile; approval stays per-skill. Root-level and committed like
 * `aih-skills.lock.json`, so a fresh clone reads the same curation.
 */
export const AIH_PACKS_FILE = "aih-packs.json";

/** One skill reference inside a pack — a cross-check against the lock entry of the same name. */
export const PackSkillRefSchema = z
  .object({
    /** Must match a lock entry / promoted skill name. */
    name: z.string().min(1),
    /** Cross-check vs the lock entry's source (the lock stays the pin authority). */
    source: z.string().min(1),
    /** Cross-check vs the lock entry's commit (full SHA or "local"). */
    commit: z.string().min(1),
  })
  .strict();

export const PackSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    /**
     * Per-pack TIGHTENING of org-policy's required-check list (superset
     * semantics; evaluated at install time in a later slice).
     */
    requiredChecks: z.array(z.string().min(1)).optional(),
    skills: z.array(PackSkillRefSchema).min(1),
  })
  .strict();

export const PacksFileSchema = z
  .object({ schemaVersion: z.literal(1), packs: z.array(PackSchema) })
  .strict();

export type PackSkillRef = z.infer<typeof PackSkillRefSchema>;
export type Pack = z.infer<typeof PackSchema>;

export interface PacksFile {
  schemaVersion: 1;
  packs: Pack[];
}

/**
 * Read the committed pack manifest. Fail-SOFT per PACK (mirrors `readSkillsLock`):
 * a malformed file yields an empty manifest and a malformed pack ENTRY is dropped
 * while valid siblings survive — hand-edited state never crashes a read-only
 * status, and never gets amplified either. An absent file is simply zero packs;
 * "present but zero valid packs" is the caller's `pack.unknown-manifest` signal.
 */
export function readPacksFile(root: string): PacksFile {
  const raw = readIfExists(join(root, AIH_PACKS_FILE));
  if (raw === undefined) return { schemaVersion: 1, packs: [] };
  try {
    const parsed = JSON.parse(raw) as { packs?: unknown };
    const packs = Array.isArray(parsed.packs) ? parsed.packs : [];
    return {
      schemaVersion: 1,
      packs: packs.flatMap((entry) => {
        const result = PackSchema.safeParse(entry);
        return result.success ? [result.data] : [];
      }),
    };
  } catch {
    return { schemaVersion: 1, packs: [] };
  }
}
