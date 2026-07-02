import { z } from "zod";
import { marketplaceRelPathSchema } from "../marketplace/manifest.js";

/**
 * Evidence-bundle index (`evidence.json`) at the root of a built evidence
 * ARTIFACT — a typed, kind-tagged catalog of the governance artifacts aih
 * ALREADY emits (approval locks, skill cards, vet evidence, run logs, reports),
 * never new evidence of its own. `aih evidence build` packages the on-disk
 * artifacts into the exact fleet-bundle layout (`files/<rel>` copies +
 * `manifest.json` + `SHA256SUMS`, so `aih verify-bundle` re-checks it
 * unchanged) and adds this index so an auditor can ask "which of these files is
 * the skills lock?" without knowing aih's path conventions. The index only
 * lists what exists — an absent kind is silently absent, never an error.
 */

/** Index filename inside the bundle (sibling of `manifest.json` / `SHA256SUMS`). */
export const EVIDENCE_FILE = "evidence.json";

/** Default output directory for `evidence build` (gitignored `.aih/`). */
export const DEFAULT_EVIDENCE_OUT = ".aih/evidence-bundle";

/** The closed set of artifact kinds aih emits today (all schemaVersion 1 on disk). */
export const EVIDENCE_KINDS = [
  "run-log",
  "skill-evidence",
  "skill-card",
  "skills-lock",
  "trust-lock",
  "packs",
  "report",
  "sarif",
] as const;

export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

/**
 * One indexed artifact: its kind, the repo-relative source path (equal to the
 * manifest's `files[].path`, so `files/<path>` is the packaged copy), the
 * sha256 of the exact packaged bytes, and the artifact's OWN declared
 * schemaVersion (read from its JSON when it carries one, else 1). Paths reuse
 * the marketplace's rel-path refinement — a hosted, hand-editable index must
 * never steer a consumer's filesystem reads out of the bundle.
 */
export const EvidenceArtifactSchema = z
  .object({
    kind: EvidenceKindSchema,
    path: marketplaceRelPathSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    schemaVersion: z.number().int().min(1),
  })
  .strict();

export const EvidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifacts: z.array(EvidenceArtifactSchema),
  })
  .strict();

export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
