import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import { canonicalStrictJsonSha256V1 } from "../contract/strict-json-v1.js";
import {
  assertAcquiredGithubSourceMaterialPathsV1,
  isKnownAcquiredGithubSourceRootV1,
} from "../internals/bounded-github-source-archive.js";
import { prepareEccCatalogSourceV1 } from "../org-policy/catalog-providers/ecc.js";
import { prepareSuperpowersCatalogSourceV1 } from "../org-policy/catalog-providers/superpowers.js";
import { compilePinnedBaselineV1 } from "../org-policy/workbench/compilers/pinned-baseline.js";
import {
  compilePinnedComponentCollectionV1,
  type PinnedComponentCollectionInputV1,
} from "../org-policy/workbench/compilers/pinned-component-collection.js";
import {
  compilePinnedSkillCollectionV1,
  type PinnedSkillCollectionInputV1,
} from "../org-policy/workbench/compilers/pinned-skill-collection.js";
import { getMattPocockPinnedSkillCollectionV1 } from "../org-policy/workbench/providers/mattpocock.js";
import { ponytailPinnedComponentCollectionV1 } from "../org-policy/workbench/providers/ponytail.js";
import { defineBaselineCatalog } from "./catalog.js";
import { eccBaselineCatalogV1 } from "./catalog-providers/ecc.js";
import { superpowersBaselineCatalogV1 } from "./catalog-providers/superpowers.js";
import { baselineCatalogById } from "./catalogs.js";
import { hashComponentTree, hashSourceTree } from "./hash.js";
import { componentIdentityPaths } from "./license.js";
import { readVendorBaselineLock } from "./vendor.js";

type CollectionInput = PinnedSkillCollectionInputV1 | PinnedComponentCollectionInputV1;
type BaselineProviderId = "ecc" | "superpowers";

/** Provider-owned snapshots; this registry does not extend installation or qualification support. */
const collections: Readonly<Record<string, () => CollectionInput>> = Object.freeze({
  mattpocock: getMattPocockPinnedSkillCollectionV1,
  ponytail: ponytailPinnedComponentCollectionV1,
});

function fail(message: string): never {
  throw new TypeError(`Scanner provider coverage: ${message}`);
}

function exactPinnedBaselineCoverageV1(sourceRoot: string, id: BaselineProviderId) {
  const sourceSnapshot = readVendorBaselineLock().sources.find((source) => source.id === id);
  if (sourceSnapshot === undefined) fail("missing vetted source snapshot");
  const catalog =
    id === "ecc"
      ? eccBaselineCatalogV1(sourceSnapshot.pinnedSha)
      : superpowersBaselineCatalogV1(sourceSnapshot.pinnedSha);
  if (
    catalog.owner !== sourceSnapshot.owner ||
    catalog.repo !== sourceSnapshot.repo ||
    catalog.pinnedSha !== sourceSnapshot.pinnedSha
  )
    fail("baseline source identity");
  const framework =
    id === "ecc"
      ? prepareEccCatalogSourceV1({ baseline: catalog, sourceSnapshot })
      : prepareSuperpowersCatalogSourceV1({ baseline: catalog, sourceSnapshot });
  const compiled = compilePinnedBaselineV1(framework, sourceSnapshot);
  const sourceTreeSha256 = hashSourceTree(sourceRoot).treeSha256;
  if (sourceTreeSha256 !== sourceSnapshot.sourceTreeSha256)
    fail("source tree differs from vetted snapshot");

  const lockedComponents = new Map(
    sourceSnapshot.components.map((component) => [component.id, component]),
  );
  if (lockedComponents.size !== sourceSnapshot.components.length)
    fail("duplicate vetted component");
  if (
    catalog.components.length !== lockedComponents.size ||
    catalog.components.some((component) => !lockedComponents.has(component.id))
  )
    fail("baseline component inventory");
  const coverage = {
    version: "workbench-scanner-coverage/v1" as const,
    authority: "none" as const,
    scope: "declared-source-files" as const,
    compilerInputDigest: `sha256:${canonicalStrictJsonSha256V1({ framework, sourceSnapshot })}`,
    source: compiled.source,
    repository: `${catalog.owner}/${catalog.repo}`,
    pinnedCommit: catalog.pinnedSha,
    sourceTreeSha256,
    components: catalog.components
      .map((component) => {
        const locked = lockedComponents.get(component.id) ?? fail("missing vetted component");
        const paths = [...component.paths].sort(codeUnitCompare);
        const vettedMaterial = hashComponentTree(
          sourceRoot,
          componentIdentityPaths(sourceRoot, paths),
        );
        if (
          locked.treeSha256 !== vettedMaterial.treeSha256 ||
          JSON.stringify([...locked.paths].sort(codeUnitCompare)) !== JSON.stringify(paths)
        )
          fail(`component differs from vetted snapshot: ${component.id}`);
        // Scanner request identity remains the original declared component surface.
        // Vetted snapshot identity additionally binds inherited legal material above.
        const material = hashComponentTree(sourceRoot, paths);
        const declaration = compiled.declarations.find(
          (candidate) => candidate.declaration.id === `${id}/${component.id}`,
        )?.declaration;
        if (declaration === undefined)
          fail(`component has no exact compiled asset: ${component.id}`);
        return {
          componentId: component.id,
          componentTreeSha256: material.treeSha256,
          paths,
          files: material.files.map((file) => ({
            path: file.path,
            digest: `sha256:${file.sha256}`,
          })),
          subject: {
            assetId: declaration.id,
            sourceId: declaration.sourceId,
            sourceRevisionId: declaration.sourceRevisionId,
            contentDigest: declaration.contentDigest,
          },
        };
      })
      .sort((left, right) => codeUnitCompare(left.componentId, right.componentId)),
    unmappedDerivedAssets: compiled.declarations
      .filter(({ declaration }) => declaration.derivation !== "upstream")
      .map(({ declaration }) => declaration.id)
      .sort(codeUnitCompare),
  };
  return {
    catalog,
    coverage,
    coverageDigest: `sha256:${canonicalStrictJsonSha256V1(coverage)}`,
  };
}
function enforceAcquiredCoveragePathsV1<
  T extends Readonly<{
    catalog: Readonly<{ owner: string; repo: string; pinnedSha: string }>;
    coverage: Readonly<{ components: readonly Readonly<{ paths: readonly string[] }>[] }>;
  }>,
>(sourceRoot: string, prepared: T): T {
  const repository = `${prepared.catalog.owner}/${prepared.catalog.repo}`;
  if (!isKnownAcquiredGithubSourceRootV1(sourceRoot, repository, prepared.catalog.pinnedSha))
    return prepared;
  const paths = [...new Set(prepared.coverage.components.flatMap((component) => component.paths))];
  if (
    !assertAcquiredGithubSourceMaterialPathsV1(
      sourceRoot,
      repository,
      prepared.catalog.pinnedSha,
      paths,
    )
  )
    fail("declared source material overlaps an omitted archive link");
  return prepared;
}
/**
 * Verify the selected snapshot bytes against a materialized upstream checkout.
 * The Scanner source hash describes the WHOLE supplied tree; component hashes
 * describe the declared file sets. Neither is the compiler's collection digest.
 * The returned mapping is a non-authoritative input to later verified consumption.
 */
export function prepareCollectionScannerCoverageV1(sourceRoot: string, input: CollectionInput) {
  const compiled =
    input.version === "pinned-skill-collection/v1"
      ? compilePinnedSkillCollectionV1(input)
      : compilePinnedComponentCollectionV1(input);
  const repository = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(
    input.source.repository,
  );
  if (!repository)
    throw new TypeError("Scanner collection requires an exact GitHub source repository.");
  const files =
    input.version === "pinned-skill-collection/v1"
      ? [input.license, ...input.skills.flatMap((skill) => skill.files)]
      : input.files;
  for (const file of files) {
    // Reject linked ancestors as well as linked leaf files before hashing.
    let path = resolve(sourceRoot);
    for (const part of file.path.split("/")) {
      path = resolve(path, part);
      if (lstatSync(path).isSymbolicLink())
        throw new TypeError("Scanner snapshot bytes cannot traverse links.");
    }
    const actual = hashComponentTree(sourceRoot, [file.path]).files;
    const expected = Buffer.from(file.bytesBase64, "base64");
    if (
      actual.length !== 1 ||
      actual[0]?.path !== file.path ||
      actual[0].bytes !== expected.length ||
      actual[0].sha256 !== createHash("sha256").update(expected).digest("hex")
    )
      throw new TypeError(`Scanner source differs from reviewed snapshot bytes: ${file.path}`);
  }
  const components =
    input.version === "pinned-skill-collection/v1"
      ? input.skills.map((skill) => ({
          id: `skill:${skill.id}`,
          paths: skill.files.map((file) => file.path),
          skillContent: true as const,
        }))
      : input.components.map((component) => ({
          id: component.id,
          paths: component.fileRefs,
          ...(component.kind === "skill" ||
          component.fileRefs.some((path) => path.endsWith("/SKILL.md") || path === "SKILL.md")
            ? { skillContent: true as const }
            : {}),
        }));
  const catalog = defineBaselineCatalog({
    id: input.source.id,
    owner: repository[1],
    repo: repository[2],
    pinnedSha: input.source.commit,
    components: components
      .map((component) => ({ ...component, paths: [...component.paths].sort(codeUnitCompare) }))
      .sort((a, b) => codeUnitCompare(a.id, b.id)),
  });
  const coverage = {
    version: "workbench-scanner-coverage/v1" as const,
    authority: "none" as const,
    scope: "declared-source-files" as const,
    compilerInputDigest: `sha256:${canonicalStrictJsonSha256V1(input)}`,
    source: compiled.source,
    repository: `${catalog.owner}/${catalog.repo}`,
    pinnedCommit: catalog.pinnedSha,
    sourceTreeSha256: hashSourceTree(sourceRoot).treeSha256,
    components: catalog.components.map((component) => {
      const declaration = compiled.declarations.find(
        ({ declaration }) => declaration.id === `${catalog.id}/${component.id}`,
      )?.declaration;
      if (!declaration) throw new TypeError("Scanner component has no exact compiled asset.");
      const material = hashComponentTree(sourceRoot, component.paths);
      return {
        componentId: component.id,
        primaryPath: declaration.originalPath,
        componentTreeSha256: material.treeSha256,
        paths: component.paths,
        files: material.files.map((file) => ({
          path: file.path,
          digest: `sha256:${file.sha256}`,
        })),
        subject: {
          assetId: declaration.id,
          sourceId: declaration.sourceId,
          sourceRevisionId: declaration.sourceRevisionId,
          contentDigest: declaration.contentDigest,
        },
      };
    }),
    // Derived compositions need their own Core composition check. Never invent
    // another upstream component or silently inherit a constituent's scan pass.
    unmappedDerivedAssets: compiled.declarations
      .filter(({ declaration }) => declaration.derivation !== "upstream")
      .map(({ declaration }) => declaration.id)
      .sort(codeUnitCompare),
  };
  return { catalog, coverage, coverageDigest: `sha256:${canonicalStrictJsonSha256V1(coverage)}` };
}

export function prepareRegisteredScannerCatalogV1(sourceRoot: string, id: string) {
  const collection = Object.hasOwn(collections, id) ? collections[id] : undefined;
  if (collection)
    return enforceAcquiredCoveragePathsV1(
      sourceRoot,
      prepareCollectionScannerCoverageV1(sourceRoot, collection()),
    );
  if (id === "ecc" || id === "superpowers")
    return enforceAcquiredCoveragePathsV1(
      sourceRoot,
      exactPinnedBaselineCoverageV1(sourceRoot, id),
    );
  return { catalog: baselineCatalogById(id), coverage: undefined, coverageDigest: undefined };
}
