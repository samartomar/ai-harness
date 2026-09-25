import { join } from "node:path";
import { z } from "zod";
import { readIfExists } from "../internals/fsxn.js";
import { skillNameSchema } from "../skill/lockfile.js";

/**
 * Marketplace manifest (`marketplace.json`) at the root of a built marketplace
 * ARTIFACT — a reproducible, verifiable DISTRIBUTION directory packaged from the
 * approval evidence aih already emits, never a registry or server. The committed
 * `aih-skills.lock.json` stays the APPROVAL AUTHORITY: `marketplace build` only
 * packages what the lock approves (skill files + committed cards + vet evidence),
 * and every entry here is a receipt of that packaging, never a second approval.
 * Consumers keep using the existing `aih workspace add` channel — the vet gate
 * still runs at consume time, so a hosted artifact grants nothing by itself.
 */
export const AIH_MARKETPLACE_FILE = "marketplace.json";

/** Default output directory for `marketplace build` (gitignored `.aih/`). */
export const DEFAULT_MARKETPLACE_OUT = ".aih/marketplace";

/**
 * Artifact-relative paths come from a HOSTED, hand-editable manifest and later
 * feed filesystem reads on the consumer side — a crafted path like `../../.ssh/x`
 * would traverse out of the artifact directory. Mirrors the `skillNameSchema`
 * refinement per SEGMENT: forward-slash-separated segments only, no empty/`.`/
 * `..` segments, no absolute/drive forms, no backslashes or control characters.
 */
export const marketplaceRelPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
      if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
      if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
      return path.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
    },
    {
      message:
        "unsafe artifact path (forward-slash relative segments only; no .., absolute paths, backslashes, or control chars)",
    },
  );

/** One packaged file: artifact-relative path + the exact bytes it must hash to. */
export const MarketplaceFileSchema = z
  .object({
    path: marketplaceRelPathSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().min(0),
  })
  .strict();

/**
 * One packaged skill — the lock entry's identity (name/source/commit/verdict)
 * plus the artifact-relative receipts: the committed card copy, the
 * content-addressed vet evidence copy, and every shipped file with its hash.
 * Verdict is the vet verdict the approval recorded (GREEN, YELLOW, RED or
 * UNKNOWN), carried as the skill's label for the consumer.
 */
export const MarketplaceSkillSchema = z
  .object({
    name: skillNameSchema,
    source: z.string().min(1),
    commit: z.string().min(1),
    verdict: z.enum(["GREEN", "YELLOW", "RED", "UNKNOWN"]),
    license: z.string().min(1).optional(),
    riskClass: z.string().min(1).optional(),
    /** Artifact-relative path of the committed skill-card copy (`cards/<name>.json`). */
    card: marketplaceRelPathSchema,
    /** Artifact-relative path of the vet-evidence copy (`evidence/<filename>`). */
    evidence: marketplaceRelPathSchema,
    files: z.array(MarketplaceFileSchema).min(1),
  })
  .strict();

export const MarketplaceManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1),
    /** Optional operator-supplied stamp (`--stamp`); NEVER a wall-clock read. */
    stamp: z.string().min(1).optional(),
    skills: z.array(MarketplaceSkillSchema),
  })
  .strict();

export type MarketplaceFile = z.infer<typeof MarketplaceFileSchema>;
export type MarketplaceSkill = z.infer<typeof MarketplaceSkillSchema>;
export type MarketplaceManifest = z.infer<typeof MarketplaceManifestSchema>;

export type MarketplaceManifestRead =
  | { ok: true; manifest: MarketplaceManifest }
  | { ok: false; reason: string };

/**
 * Read an artifact's manifest. Fail-CLOSED, but as a RESULT rather than a throw
 * (the inverse of `readSkillsLock`'s fail-soft): `marketplace validate` is a
 * checker, so a malformed manifest is a FINDING it must report — never a crash,
 * and never a fail-soft read that would let a half-valid manifest keep grading
 * files while silently dropping the entries it could not parse.
 */
export function readMarketplaceManifest(dir: string): MarketplaceManifestRead {
  const raw = readIfExists(join(dir, AIH_MARKETPLACE_FILE));
  if (raw === undefined) {
    return { ok: false, reason: `${AIH_MARKETPLACE_FILE} is missing` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${AIH_MARKETPLACE_FILE} is not valid JSON` };
  }
  const result = MarketplaceManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where =
      issue === undefined ? "" : `: ${issue.path.join(".") || "(root)"} — ${issue.message}`;
    return { ok: false, reason: `${AIH_MARKETPLACE_FILE} failed schema validation${where}` };
  }
  return { ok: true, manifest: result.data };
}
