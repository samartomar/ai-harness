import { join } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import { readIfExists } from "../internals/fsxn.js";
import { skillNameSchema } from "../skill/lockfile.js";

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
    /** Must match a lock entry / promoted skill name (path-safe segments only). */
    name: skillNameSchema,
    /** Cross-check vs the lock entry's source (the lock stays the pin authority). */
    source: z.string().min(1),
    /** Cross-check vs the lock entry's commit (full SHA or "local"). */
    commit: z.string().min(1),
  })
  .strict();

export const PackSchema = z
  .object({
    // Pack names surface in digests/report labels and CLI messages — same safety rule.
    name: skillNameSchema,
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

/**
 * Read the manifest for a WRITE path (authoring) — fail-CLOSED, the inverse of
 * {@link readPacksFile}'s fail-soft. A read→modify→rewrite cycle built on the
 * fail-soft read would silently DELETE any sibling pack the schema dropped, so
 * authoring refuses unless the raw file parses AND the WHOLE file survives
 * strict validation — aih never silently destroys operator data it cannot
 * faithfully round-trip. An absent file is a fresh start (zero packs).
 */
export function readPacksFileStrictForWrite(root: string): PacksFile {
  const raw = readIfExists(join(root, AIH_PACKS_FILE));
  if (raw === undefined) return { schemaVersion: 1, packs: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AihError(
      `${AIH_PACKS_FILE} is not valid JSON — fix it by hand first (rewriting it would destroy what is there)`,
      "AIH_TRUST",
    );
  }
  const result = PacksFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new AihError(
      `${AIH_PACKS_FILE} contains entries aih cannot parse — fix them by hand first (a rewrite would silently drop them)`,
      "AIH_TRUST",
    );
  }
  return result.data;
}
