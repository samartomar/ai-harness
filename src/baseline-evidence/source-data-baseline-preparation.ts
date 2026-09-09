import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  assertStrictJsonValueV1,
  canonicalStrictJsonSha256V1,
} from "../contract/strict-json-v1.js";
import { POLICY_AUTHORING_ASSET_KINDS } from "../org-policy/catalog-provider-types.js";
import { compilePinnedBaselineV1 } from "../org-policy/workbench/compilers/pinned-baseline.js";
import { defineBaselineCatalog } from "./catalog.js";
import { hashComponentTree, hashSourceTree } from "./hash.js";
import { componentIdentityPaths } from "./license.js";

const text = z.string().min(1).max(1_000);
const id = z.string().min(1).max(256);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const path = text.refine(
  (value) =>
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
);
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
/** Curated inventory only. Report claims are deliberately not an input field. */
export const SourceDataBaselineInputV1Schema = z
  .object({
    version: z.literal("pinned-baseline/v1"),
    framework: z
      .object({
        id: z.enum(["ecc", "superpowers"]),
        repository,
        commit: sha,
        assets: z
          .array(
            z
              .object({
                id,
                kind: z.enum(POLICY_AUTHORING_ASSET_KINDS),
                curationKind: z.enum(["agent", "skill", "command"]).optional(),
                riders: z.array(id).max(1_000).optional(),
                dependencies: z.array(id).max(1_000).optional(),
                members: z.array(id).max(1_000).optional(),
                source: z.object({ repository, commit: sha, path }).strict(),
                sourcePaths: z.array(path).min(1).max(10_000),
                metadata: z
                  .object({
                    title: text,
                    summary: z.string().max(4_000),
                    usageContext: z.string().max(4_000),
                    allowedTools: z.array(text).max(128),
                    sourcePath: path,
                    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .min(1)
          .max(1_000),
      })
      .strict(),
  })
  .strict();

function closurePaths(paths: readonly string[]) {
  const ordered = [...new Set(paths)].sort();
  return ordered.filter(
    (path) => !ordered.some((parent) => path !== parent && path.startsWith(`${parent}/`)),
  );
}

/** Bind existing baseline compiler declarations to actual bytes, never to claimed verdicts. */
export function prepareSourceDataBaselineCoverageV1(sourceRoot: string, input: unknown) {
  assertStrictJsonValueV1(input, "Baseline source data");
  const parsed = SourceDataBaselineInputV1Schema.parse(input);
  const framework = parsed.framework;
  const [owner, repo] = framework.repository.split("/");
  if (
    !owner ||
    !repo ||
    new Set(framework.assets.map((asset) => asset.id)).size !== framework.assets.length
  )
    throw new TypeError("Baseline source data: ambiguous source or asset inventory");
  const materials = new Map<string, ReturnType<typeof hashComponentTree>>();
  const identities = new Map<string, string>();
  for (const asset of framework.assets) {
    if (
      asset.source.repository !== framework.repository ||
      asset.source.commit !== framework.commit
    )
      throw new TypeError("Baseline source data: declaration source mismatch");
    // A redundant child must itself exist; normalization cannot erase a bad claim.
    for (const declaredPath of asset.sourcePaths) {
      const stat = lstatSync(join(sourceRoot, declaredPath));
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
        throw new TypeError("Baseline source data: unsafe declared material");
    }
    const paths = closurePaths(asset.sourcePaths);
    const material = hashComponentTree(sourceRoot, paths);
    const primary = hashComponentTree(sourceRoot, [asset.source.path]);
    const covered = new Map(material.files.map((file) => [file.path, file.sha256]));
    if (
      primary.files.length === 0 ||
      primary.files.some((file) => covered.get(file.path) !== file.sha256)
    )
      throw new TypeError("Baseline source data: incomplete primary material");
    if (asset.metadata) {
      const actual = hashComponentTree(sourceRoot, [asset.metadata.sourcePath]).files;
      if (
        actual.length !== 1 ||
        actual[0]?.sha256 !== asset.metadata.sourceSha256 ||
        covered.get(asset.metadata.sourcePath) !== asset.metadata.sourceSha256
      )
        throw new TypeError("Baseline source data: metadata file identity mismatch");
    }
    materials.set(asset.id, material);
    identities.set(
      asset.id,
      hashComponentTree(sourceRoot, componentIdentityPaths(sourceRoot, paths)).treeSha256,
    );
  }
  const sourceTreeSha256 = hashSourceTree(sourceRoot).treeSha256;
  const compiled = compilePinnedBaselineV1(
    framework,
    {
      id: framework.id,
      owner,
      repo,
      pinnedSha: framework.commit,
      sourceTreeSha256,
      components: [],
    },
    identities,
  );
  const catalog = defineBaselineCatalog({
    id: framework.id,
    owner,
    repo,
    pinnedSha: framework.commit,
    components: framework.assets
      .map((asset) => ({
        id: asset.id,
        paths: closurePaths(asset.sourcePaths),
        ...(asset.kind === "skill" ? { skillContent: true as const } : {}),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  });
  const coverage = {
    version: "workbench-scanner-coverage/v1" as const,
    authority: "none" as const,
    scope: "declared-source-files" as const,
    compilerInputDigest: `sha256:${canonicalStrictJsonSha256V1(parsed)}`,
    source: { ...compiled.source, inputFormat: "pinned-baseline/v1" as const },
    repository: framework.repository,
    pinnedCommit: framework.commit,
    sourceTreeSha256,
    components: catalog.components.map((component) => {
      const declaration = compiled.declarations.find(
        (item) => item.declaration.id === `${framework.id}/${component.id}`,
      )?.declaration;
      const material = materials.get(component.id);
      if (!declaration || !material)
        throw new TypeError("Baseline source data: missing compiled material");
      return {
        componentId: component.id,
        primaryPath: declaration.originalPath,
        componentTreeSha256: material.treeSha256,
        paths: component.paths,
        files: material.files.map((file) => ({ path: file.path, digest: `sha256:${file.sha256}` })),
        subject: {
          assetId: declaration.id,
          sourceId: declaration.sourceId,
          sourceRevisionId: declaration.sourceRevisionId,
          contentDigest: declaration.contentDigest,
        },
      };
    }),
    unmappedDerivedAssets: compiled.declarations
      .filter((item) => item.declaration.derivation !== "upstream")
      .map((item) => item.declaration.id)
      .sort(),
  };
  return {
    compiled,
    catalog,
    coverage,
    coverageDigest: `sha256:${canonicalStrictJsonSha256V1(coverage)}`,
  };
}
