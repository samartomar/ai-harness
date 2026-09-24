import { createHash } from "node:crypto";
import { AihError, z } from "@aihq/core/framework-host";
import { UPSTREAM } from "../identity.js";
import { currentEccInvocation } from "../invocation.js";
import {
  assertPortableSourcePath,
  deriveEccProfile,
  type EccProfile,
  eccProfileSchema,
} from "./index.js";
import type { ProjectionSourceTrust } from "./source-closure.js";

/**
 * The ECC profile evidence an ordinary `aih ecc --lifecycle install|update`
 * renders from: descriptor section `profileEvidence` of the Catalog framework
 * descriptor Core loaded and verified (C1). The plugin embeds no profile
 * evidence: the section is the only source, its commit must equal the one ECC
 * revision this plugin supports (`describe().upstream.commit`, C3), and every
 * evidence document is carried as exact text bound to its SHA-256.
 *
 * Section shape (`sections.profileEvidence`, strict JSON, unknown keys refused):
 *
 * - `format`: `"aih-ecc-profile-evidence"`, `version`: `1`;
 * - `repository`: `"affaan-m/ECC"`; `sourceCommit`: 40 lowercase hex, equal to
 *   `sections.vendorLock.pinnedSha` and to the plugin's upstream commit;
 * - `profile`: the aih ECC profile document (`eccProfileSchema`), its
 *   `source.commit`, `source.reviewReceipt.sourceCommit` and every
 *   `ownership[].sourcePin` equal to `sourceCommit`;
 * - `pinnedSourceEvidence`: the pinned manifest and inventory evidence
 *   (`evidenceVersion` 1) whose `source.commit` equals `sourceCommit` and whose
 *   `reviewReceipt` equals `profile.source.reviewReceipt`;
 * - `projectedSource`: `{ id, evidencePath, evidenceSha256, fileCount,
 *   totalBytes, aggregateSha256 }`, the projected-source closure identity;
 * - `documents`: exactly two `{ path, sha256, text }` entries, one at
 *   `profile.source.reviewReceipt.evidencePath` and one at
 *   `projectedSource.evidencePath`; `sha256` is the lowercase hex SHA-256 of the
 *   UTF-8 encoding of `text` exactly as carried (no line-ending
 *   normalization) and must equal `reviewReceipt.evidenceSha256` and
 *   `projectedSource.evidenceSha256` respectively.
 */
export const ECC_PROFILE_EVIDENCE_FORMAT = "aih-ecc-profile-evidence";

const MAX_DOCUMENT_CHARS = 4 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export type EccProfileEvidenceRefusalReason =
  | "framework-profile-evidence-unavailable"
  | "framework-profile-evidence-incompatible";

/** A typed framework-plugin refusal: a label and the operator's next route. */
export class EccProfileEvidenceRefusalError extends AihError {
  readonly reason: EccProfileEvidenceRefusalReason;
  readonly label: string;
  readonly nextRoute: string;

  constructor(reason: EccProfileEvidenceRefusalReason, label: string, nextRoute: string) {
    super(`${reason}: ${label}. Next: ${nextRoute}`, "AIH_FRAMEWORK_PLUGIN");
    this.reason = reason;
    this.label = label;
    this.nextRoute = nextRoute;
  }
}

function nextRoute(commit: string): string {
  return `install an @aihq/catalog whose ./catalog-framework-ecc.json carries sections.profileEvidence for ${UPSTREAM.repository}@${commit}; governed ECC delivery (\`aih policy project\`) and \`aih ecc\` previews do not need it`;
}

function incompatible(problem: string, commit: string): EccProfileEvidenceRefusalError {
  return new EccProfileEvidenceRefusalError(
    "framework-profile-evidence-incompatible",
    `the installed Catalog's ECC profile evidence is not usable: ${problem.slice(0, 400)}`,
    nextRoute(commit),
  );
}

const DocumentSchema = z
  .object({
    path: z.string().min(1).max(240),
    sha256: z.string().regex(SHA256),
    text: z.string().max(MAX_DOCUMENT_CHARS),
  })
  .strict();

const ProjectedSourceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/),
    evidencePath: z.string().min(1).max(240),
    evidenceSha256: z.string().regex(SHA256),
    fileCount: z.number().int().positive(),
    totalBytes: z.number().int().nonnegative(),
    aggregateSha256: z.string().regex(SHA256),
  })
  .strict();

const SectionSchema = z
  .object({
    format: z.literal(ECC_PROFILE_EVIDENCE_FORMAT),
    version: z.literal(1),
    repository: z.literal("affaan-m/ECC"),
    sourceCommit: z.string().regex(COMMIT),
    profile: z.unknown(),
    pinnedSourceEvidence: z.unknown(),
    projectedSource: ProjectedSourceSchema,
    documents: z.array(DocumentSchema).length(2),
  })
  .strict();

export interface EccProfileEvidenceV1 {
  readonly sourceCommit: string;
  readonly profile: EccProfile;
  readonly evidence: unknown;
  readonly trust: ProjectionSourceTrust;
  /** Evidence-root-relative path → exact document text. */
  readonly documents: ReadonlyMap<string, string>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Validate a `profileEvidence` section against the plugin's upstream commit.
 * Absent → `framework-profile-evidence-unavailable`; anything wrong →
 * `framework-profile-evidence-incompatible`. Never a fallback.
 */
export function readEccProfileEvidenceV1(
  section: unknown,
  upstreamCommit: string = UPSTREAM.commit,
): EccProfileEvidenceV1 {
  if (section === undefined) {
    throw new EccProfileEvidenceRefusalError(
      "framework-profile-evidence-unavailable",
      "ECC profile install and update render only from ECC profile evidence in the installed Catalog, and its ECC framework descriptor carries no sections.profileEvidence",
      nextRoute(upstreamCommit),
    );
  }
  const parsed = SectionSchema.safeParse(section);
  if (!parsed.success) {
    throw incompatible(
      `sections.profileEvidence ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "(root)"} — ${issue.message}`)
        .join("; ")}`,
      upstreamCommit,
    );
  }
  const value = parsed.data;
  if (value.sourceCommit !== upstreamCommit) {
    throw incompatible(
      `it is for ${value.repository}@${value.sourceCommit}, but this plugin supports ${UPSTREAM.repository}@${upstreamCommit}`,
      upstreamCommit,
    );
  }
  let profile: EccProfile;
  try {
    profile = eccProfileSchema.parse(value.profile);
    deriveEccProfile(profile, value.pinnedSourceEvidence);
  } catch (error) {
    throw incompatible(
      `the profile and its evidence do not validate (${(error as Error).message})`,
      upstreamCommit,
    );
  }
  if (profile.source.commit !== value.sourceCommit) {
    throw incompatible(
      `the profile pins ${profile.source.commit}, not the section's ${value.sourceCommit}`,
      upstreamCommit,
    );
  }
  const expected = new Map([
    [profile.source.reviewReceipt.evidencePath, profile.source.reviewReceipt.evidenceSha256],
    [value.projectedSource.evidencePath, value.projectedSource.evidenceSha256],
  ]);
  if (expected.size !== 2) {
    throw incompatible("the review receipt and the source closure share one path", upstreamCommit);
  }
  const documents = new Map<string, string>();
  for (const document of value.documents) {
    try {
      assertPortableSourcePath(document.path);
    } catch {
      throw incompatible(
        `document path ${JSON.stringify(document.path)} is not portable`,
        upstreamCommit,
      );
    }
    const digest = expected.get(document.path);
    if (digest === undefined || documents.has(document.path)) {
      throw incompatible(`document ${document.path} is not expected`, upstreamCommit);
    }
    if (sha256(document.text) !== document.sha256 || document.sha256 !== digest) {
      throw incompatible(`document ${document.path} does not match its SHA-256`, upstreamCommit);
    }
    documents.set(document.path, document.text);
  }
  return Object.freeze({
    sourceCommit: value.sourceCommit,
    profile,
    evidence: value.pinnedSourceEvidence,
    trust: Object.freeze({ ...value.projectedSource, sourceCommit: value.sourceCommit }),
    documents,
  });
}

/** The current invocation's profile evidence: Core-verified descriptor bytes only. */
export function currentEccProfileEvidenceV1(): EccProfileEvidenceV1 {
  return readEccProfileEvidenceV1(currentEccInvocation().descriptor.sections.profileEvidence);
}
