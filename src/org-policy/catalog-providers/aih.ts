import type { AihCatalogSourceV1 } from "../catalog-provider-types.js";

export interface PrepareAihCatalogSourceV1Input {
  capabilityCatalog: AihCatalogSourceV1["aihCapabilityCatalog"];
  capabilityPackage: AihCatalogSourceV1["aihCapabilityPackage"];
}

const FIRST_PARTY_CAPABILITY_PACKS = [
  {
    kind: "skill" as const,
    id: "package:skill-pack/docs-quality",
    pack: "docs-quality",
    description:
      "First-party claim-first, evidence-grounded documentation skill (BetterDoc) — edits, reviews, and creates source-grounded docs with a bounded anti-slop lint that never overrides source truth.",
    skills: ["aih-betterdoc"],
    sources: [
      {
        skill: "aih-betterdoc",
        path: "packs/docs-quality/aih-betterdoc",
        manifestIdentity: "local",
      },
    ],
  },
  {
    kind: "agent" as const,
    id: "package:skill-pack/governance-quality",
    pack: "governance-quality",
    description:
      "First-party read-only Governance Doctor agent workflow for isolated destination lifecycle review, backed by declarative Audit and Guide source material.",
    skills: ["aih-gov-doctor"],
    sources: [
      {
        skill: "aih-gov-doctor",
        path: "packs/governance-quality/aih-gov-doctor",
        manifestIdentity: "local",
      },
    ],
  },
  {
    kind: "agent" as const,
    id: "package:skill-pack/review-quality",
    pack: "review-quality",
    description:
      "First-party isolated BUGBOUNTY agent workflow for high-coverage generated-agent, skill, MCP, workflow, and evidence review.",
    skills: ["aih-bugbounty"],
    sources: [
      {
        skill: "aih-bugbounty",
        path: "packs/review-quality/aih-bugbounty",
        manifestIdentity: "local",
      },
    ],
  },
] as const;

/** Direct, pure first-party capability preparation from explicit package input. */
export function prepareAihCatalogSourceV1(
  input: PrepareAihCatalogSourceV1Input,
): AihCatalogSourceV1 {
  return {
    aihCapabilityCatalog: input.capabilityCatalog,
    aihCapabilityPackage: input.capabilityPackage,
    aihSkills: FIRST_PARTY_CAPABILITY_PACKS.filter((pack) => pack.kind === "skill").map(
      ({ kind: _, ...pack }) => ({
        ...pack,
        skills: [...pack.skills],
        sources: pack.sources.map((source) => ({ ...source })),
      }),
    ),
    aihAgents: FIRST_PARTY_CAPABILITY_PACKS.filter((pack) => pack.kind === "agent").map(
      ({ kind: _, ...pack }) => ({
        ...pack,
        skills: [...pack.skills],
        sources: pack.sources.map((source) => ({ ...source })),
      }),
    ),
  };
}
