/**
 * The aih ECC profile pinned at affaan-m/ECC 5064474d (v2.2.1), taken verbatim
 * from Catalog's `profileEvidence` section bytes at that commit
 * (tests/fixtures/ecc-profileEvidence-5064474d.json). Test data only: the
 * plugin reads its profile and evidence from the Catalog descriptor's
 * `profileEvidence` section (src/profile/descriptor-evidence.ts).
 *
 * tests/fixtures/ecc-5064474d holds the raw upstream manifests at that commit
 * and the section's two documents as files (review-receipt.json,
 * projected-source-closure.json), byte for byte.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EccProfile } from "../../src/profile/index.js";
import type { ProjectionSourceTrust } from "../../src/profile/source-closure.js";

export const pinnedFixtureDirectory = join(import.meta.dirname, "../fixtures/ecc-5064474d");

interface PinnedProfileEvidenceSection {
  sourceCommit: string;
  profile: EccProfile;
  pinnedSourceEvidence: unknown;
  projectedSource: Omit<ProjectionSourceTrust, "sourceCommit">;
  documents: { path: string; sha256: string; text: string }[];
}

export const PINNED_PROFILE_EVIDENCE_SECTION = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/ecc-profileEvidence-5064474d.json"), "utf8"),
) as PinnedProfileEvidenceSection;

export const PINNED_SOURCE_COMMIT = PINNED_PROFILE_EVIDENCE_SECTION.sourceCommit;

export const TRUSTED_MANIFEST_PINS = PINNED_PROFILE_EVIDENCE_SECTION.profile.source.manifestPins;

/** The profile document, review receipt included. */
export const AIH_ECC_PROFILE_TEMPLATE = PINNED_PROFILE_EVIDENCE_SECTION.profile;

export const PINNED_SOURCE_EVIDENCE = PINNED_PROFILE_EVIDENCE_SECTION.pinnedSourceEvidence;

export const TRUSTED_PROJECTED_SOURCE: ProjectionSourceTrust = {
  ...PINNED_PROFILE_EVIDENCE_SECTION.projectedSource,
  sourceCommit: PINNED_SOURCE_COMMIT,
};
