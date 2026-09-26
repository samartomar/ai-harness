import { createHash } from "node:crypto";
import { loadCatalogAuthoringBundleV1 } from "../../src/catalog-package/authoring-bundle.js";
import { canonicalStrictJsonSha256V1 } from "../../src/contract/strict-json-v1.js";

export const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** A single-source bundle sealed the way the Catalog seals one (self digest over the bare bundle). */
export function sealedSingleSourceBundle(id: string, revision: string, skills: readonly string[]) {
  return sealedComponentSourceBundle(
    id,
    revision,
    skills.map((skill) => ({
      componentId: `skill:${skill}`,
      originalPath: `skills/${skill}/SKILL.md`,
      label: skill,
      detail: skill,
    })),
  );
}

/** The same sealed bundle with one upstream asset `<id>/<componentId>` per named component. */
export function sealedComponentSourceBundle(
  id: string,
  revision: string,
  components: readonly {
    componentId: string;
    originalPath: string;
    label: string;
    detail: string;
  }[],
) {
  const sourceId = `source:${id}`;
  const assetIds = components.map((component) => `${id}/${component.componentId}`);
  const skills = components.map((component) => component.detail);
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
          originalPath: components[index]?.originalPath,
          derivation: "upstream",
          kind: "skill",
          label: components[index]?.label,
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

/**
 * The installed Catalog's real compiled source `source:<id>` as a sealed single-source bundle:
 * its source, every asset it compiled and their detail chunks, byte for byte. `revision`
 * re-pins the same compiled partition to another commit (no compiled bundle exists yet at the
 * new pins); `extra` adds assets shaped like the first one.
 */
export function installedSingleSourceBundle(
  id: string,
  revision?: string,
  extra: readonly { id: string; originalPath: string; derivation?: string }[] = [],
) {
  const bundle = loadCatalogAuthoringBundleV1().prepared.bundle;
  const sourceId = `source:${id}`;
  const source = bundle.sources[sourceId];
  if (source === undefined) throw new Error(`fixture: the installed Catalog has no ${sourceId}`);
  const at = revision ?? source.revision.id;
  const compiled = Object.values(bundle.assets).filter((asset) => asset.sourceId === sourceId);
  const [first] = compiled;
  if (first === undefined) throw new Error(`fixture: ${sourceId} compiled no asset`);
  const assets = [
    ...compiled,
    ...extra.map((asset) => ({ ...first, derivation: "upstream" as const, ...asset })),
  ].map((asset) => ({ ...asset, sourceRevisionId: at }));
  const bare = {
    version: bundle.version,
    sources: { [sourceId]: { ...source, revision: { ...source.revision, id: at } } },
    assets: Object.fromEntries(assets.map((asset) => [asset.id, asset])),
    groups: {},
    relations: [],
    templates: {},
    evidence: {},
    detailChunks: Object.fromEntries(
      compiled.map((asset) => [asset.detailChunkId, bundle.detailChunks[asset.detailChunkId]]),
    ),
  };
  return {
    ...bare,
    provenance: {
      bundleDigest: `sha256:${canonicalStrictJsonSha256V1({ ...bare, provenance: {} })}`,
    },
  };
}
