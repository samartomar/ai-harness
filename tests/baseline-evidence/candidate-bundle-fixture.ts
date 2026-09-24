import { createHash } from "node:crypto";
import { canonicalStrictJsonSha256V1 } from "../../src/contract/strict-json-v1.js";

export const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** A single-source bundle sealed the way the Catalog seals one (self digest over the bare bundle). */
export function sealedSingleSourceBundle(id: string, revision: string, skills: readonly string[]) {
  const sourceId = `source:${id}`;
  const assetIds = skills.map((skill) => `${id}/skill:${skill}`);
  const bare = {
    version: "authoring-catalog-bundle/v1",
    sources: {
      [sourceId]: {
        id: sourceId,
        distributor: { kind: "git", locator: `https://github.com/${id}/skills` },
        upstreamOrigin: { kind: "git", locator: `https://github.com/${id}/skills` },
        inputFormat: "pinned-skill-collection/v1",
        revision: { id: revision, contentDigest: digest(`${id} revision`) },
        compiler: { id: "pinned-skill-collection", version: "1" },
      },
    },
    assets: Object.fromEntries(
      skills.map((skill, index) => [
        assetIds[index],
        {
          id: assetIds[index],
          sourceId,
          sourceRevisionId: revision,
          contentDigest: digest(`${assetIds[index]}`),
          originalPath: `skills/${skill}/SKILL.md`,
          derivation: "upstream",
          kind: "skill",
          label: skill,
          detailChunkId: `detail:${skill}`,
          declaredHostCapabilities: [],
          authoring: { action: "record-selection", supportedTargets: [] },
        },
      ]),
    ),
    groups: {},
    relations: [],
    templates: {},
    evidence: {},
    detailChunks: Object.fromEntries(
      skills.map((skill, index) => {
        const bytes = JSON.stringify({ id: assetIds[index] });
        return [`detail:${skill}`, { bytes, digest: digest(bytes) }];
      }),
    ),
  };
  return {
    ...bare,
    provenance: {
      bundleDigest: `sha256:${canonicalStrictJsonSha256V1({ ...bare, provenance: {} })}`,
    },
  };
}
