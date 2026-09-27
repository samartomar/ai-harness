import {
  SKILLSPECTOR_IMAGE_DIGEST,
  SKILLSPECTOR_SOURCE_REVISION,
} from "../../../src/trust/images.js";

// ---------------------------------------------------------------------------
// The S2j hand vector (C2a §1.6 [Scan: S2j], decision D24): a tree, its
// baseline subject F (every file outside the top-level `.git`) and the
// contrast subject with `.git/HEAD`, and the analyzer identities Scan's batch
// runs. Digests are literals computed by hand with plain node:crypto over the
// subject-files-v1 framing, never Core's subject code.
// ---------------------------------------------------------------------------

export const VECTOR_FILES = {
  ".git/HEAD": "ref: refs/heads/main\n",
  "SKILL.md": "---\nname: vector\ndescription: baseline completion vector\n---\n# Vector\n",
  "src/a.js": "console.log(1);\n",
} as const;
/** F = { SKILL.md, src/a.js }: the baseline subject. */
export const BASELINE = {
  subjectTreeSha256: "6d8a18d0f8e75ac27da59b7ab2d95d40e6c7a9d514ee448212ee3d26ae9b8c3e",
  analyzedFileCount: 2,
} as const;
/** F with `.git/HEAD` too: the delegated Semgrep/SkillSpector subject over the same tree. */
export const WITH_GIT = {
  subjectTreeSha256: "97c4ab9cc9b887bd70d66a8be8c5d6c51bd3e9df93c87d5d13f9d3a0b4651796",
  analyzedFileCount: 3,
} as const;

export const SEMGREP_NAMESPACE = {
  version: "1.178.0+uvlock.5fae6a8598f7",
  lockSha256: "5fae6a8598f7d5cf4921c0cb5bd1790accd756a2073abfb5c5f104ae64c5b594",
} as const;
export const CISCO_NAMESPACE = {
  version: "2.1.0+uvlock.1e98c5679994",
  lockSha256: "1e98c5679994dc56f82c1d88a77528d4c4b076160aff85b4d97ce239360bc210",
} as const;
export const SKILLSPECTOR_HARDENED = {
  version: `${SKILLSPECTOR_SOURCE_REVISION}@${SKILLSPECTOR_IMAGE_DIGEST}`,
  lockSha256: null,
} as const;

type Subject = { readonly subjectTreeSha256: string; readonly analyzedFileCount: number };
type Analyzer = { readonly version: string; readonly lockSha256: string | null };

/** One SARIF log whose single run's first invocation states this evidence (or none). */
export function vectorAnnex(
  completion?: { readonly detectorId: string } & Subject & { readonly analyzer: Analyzer },
): Record<string, unknown> {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "fixture" } },
        invocations: [
          completion === undefined
            ? { executionSuccessful: true }
            : { executionSuccessful: true, properties: { aihScanCompletionV1: completion } },
        ],
        results: [],
      },
    ],
  };
}

export function vectorEvidence(detectorId: string, subject: Subject, analyzer: Analyzer) {
  return { detectorId, ...subject, analyzer };
}
