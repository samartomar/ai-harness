import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";
import type { BaselineVetRequestV1 } from "@aihq/scan";
import { z } from "zod";
import { defineBaselineCatalog } from "./catalog.js";
import { hashSourceTree } from "./hash.js";
import { createCoreBaselineVetRequests } from "./scanner-consumer.js";

const sourcePath = z
  .string()
  .min(1)
  .max(4_096)
  .superRefine((value, ctx) => {
    if (value.includes("\\") || value.startsWith("/")) {
      ctx.addIssue({
        code: "custom",
        message: "candidate path must be source-relative POSIX text",
      });
      return;
    }
    const normalized = posix.normalize(value);
    if (
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      isAbsolute(normalized)
    ) {
      ctx.addIssue({ code: "custom", message: "candidate path escapes source root" });
    }
  });

const sourceIdentity = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    pinnedCommit: z.string().regex(/^[0-9a-f]{40}$/),
    treeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const inventoryComponent = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9:._-]*$/),
    paths: z.array(sourcePath).min(1).max(4_096),
    content: z.enum(["general", "skill"]).default("general"),
  })
  .strict();

const inventoryFacets = z
  .object({
    skills: z.array(sourcePath).max(10_000),
    agents: z.array(sourcePath).max(10_000),
    hooks: z.array(sourcePath).max(10_000),
    mcp: z.array(sourcePath).max(10_000),
    sourceSymlinks: z.array(sourcePath).max(10_000),
  })
  .strict();

const inventorySchema = z
  .object({
    protocol: z.literal("CandidateBaselineInventoryV1"),
    producer: z.object({ id: z.literal("aih-core-candidate-preparation-v1") }).strict(),
    source: sourceIdentity,
    components: z.array(inventoryComponent).min(1).max(4_096),
    exclusions: z
      .array(z.object({ path: sourcePath, reason: z.literal("source-symlink") }).strict())
      .max(4_096),
    facets: inventoryFacets.optional(),
  })
  .strict()
  .superRefine((inventory, ctx) => {
    const componentIds = new Set<string>();
    for (const [index, component] of inventory.components.entries()) {
      if (componentIds.has(component.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["components", index, "id"],
          message: "duplicate component ID",
        });
      }
      componentIds.add(component.id);
      const paths = new Set<string>();
      for (const [pathIndex, path] of component.paths.entries()) {
        if (paths.has(path)) {
          ctx.addIssue({
            code: "custom",
            path: ["components", index, "paths", pathIndex],
            message: "duplicate component path",
          });
        }
        paths.add(path);
      }
    }
    const exclusions = new Set<string>();
    for (const [index, exclusion] of inventory.exclusions.entries()) {
      if (exclusions.has(exclusion.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["exclusions", index, "path"],
          message: "duplicate exclusion path",
        });
      }
      exclusions.add(exclusion.path);
    }
    if (inventory.facets !== undefined) {
      const facetSymlinks = [...inventory.facets.sourceSymlinks].sort();
      const excludedSymlinks = [...exclusions].sort();
      if (JSON.stringify(facetSymlinks) !== JSON.stringify(excludedSymlinks)) {
        ctx.addIssue({
          code: "custom",
          path: ["facets", "sourceSymlinks"],
          message: "source symlink facet must match explicit exclusions",
        });
      }
    }
  });

export type CandidateSourceInventory = Readonly<z.infer<typeof inventorySchema>>;

const workbenchCoverageInput = z
  .object({
    sourceId: z.string().min(1).max(240),
    sourceRevisionId: z.string().min(1).max(240),
    assets: z
      .array(
        z
          .object({
            id: z.string().min(1).max(240),
            originalPath: sourcePath,
            contentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .max(50_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const [index, asset] of value.assets.entries()) {
      if (ids.has(asset.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["assets", index, "id"],
          message: "duplicate Workbench asset ID",
        });
      }
      ids.add(asset.id);
    }
  });

export interface CandidateWorkbenchPathMappingV1 {
  readonly assetId: string;
  readonly assetContentDigest: string;
  readonly candidateComponentId: string;
  readonly candidateComponentTreeSha256: string;
  readonly originalPath: string;
}

export interface CandidateWorkbenchCoverageV1 {
  readonly protocol: "CandidateWorkbenchCoverageV1";
  readonly authority: "none";
  readonly publisherEligibility: "requires-protected-publisher-reexecution";
  readonly activePinAction: "preserve";
  readonly candidateSourceId: string;
  readonly candidateRevisionId: string;
  readonly candidateComponentCount: number;
  readonly catalogStatus: "not-offered" | "exact-revision" | "revision-mismatch";
  readonly workbenchSourceId?: string;
  readonly workbenchRevisionId?: string;
  readonly offeredAssetCount: number;
  readonly pathMappedAssetCount: number;
  readonly pathMappings: readonly CandidateWorkbenchPathMappingV1[];
  readonly unmappedAssetIds: readonly string[];
  readonly candidateOnlyComponentIds: readonly string[];
}

function sourceRelative(root: string, path: string): string {
  const value = relative(root, path).replaceAll("\\", "/");
  if (!value || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    throw new Error(`candidate source path escapes root: ${path}`);
  }
  return value;
}

function symlinkPaths(sourceRoot: string): readonly string[] {
  const symlinks: string[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    const relativePath = sourceRelative(sourceRoot, path);
    if (stat.isSymbolicLink()) {
      symlinks.push(relativePath);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const child of readdirSync(path).sort()) visit(resolve(path, child));
  };
  for (const name of readdirSync(sourceRoot)
    .filter((name) => name !== ".git")
    .sort()) {
    visit(resolve(sourceRoot, name));
  }
  return Object.freeze(symlinks);
}

function componentCoversPath(componentPath: string, sourcePath: string): boolean {
  return sourcePath === componentPath || sourcePath.startsWith(`${componentPath}/`);
}

function requestComponents(
  inventory: CandidateSourceInventory,
  requests: readonly BaselineVetRequestV1[],
): ReadonlyMap<
  string,
  Readonly<{ content: "general" | "skill"; paths: readonly string[]; treeSha256: string }>
> {
  if (requests.length === 0 || requests.length > 1_000) {
    throw new Error("candidate request set must contain 1-1000 batches");
  }
  const components = new Map<
    string,
    Readonly<{ content: "general" | "skill"; paths: readonly string[]; treeSha256: string }>
  >();
  for (const request of requests) {
    if (
      request.protocol !== "BaselineVetRequestV1" ||
      request.profile !== "aih-baseline-v1" ||
      request.source.id !== inventory.source.id ||
      request.source.owner !== inventory.source.owner ||
      request.source.repository !== inventory.source.repository ||
      request.source.pinnedCommit !== inventory.source.pinnedCommit ||
      request.source.treeSha256 !== inventory.source.treeSha256
    ) {
      throw new Error("request source does not match sealed candidate inventory");
    }
    for (const component of request.components) {
      if (components.has(component.id)) {
        throw new Error("candidate request set duplicates a component");
      }
      components.set(component.id, component);
    }
  }
  const expected = new Map(inventory.components.map((component) => [component.id, component]));
  if (components.size !== expected.size) {
    throw new Error("request components do not match sealed candidate inventory");
  }
  for (const [id, component] of components) {
    const sealed = expected.get(id);
    const sealedPaths = sealed === undefined ? [] : [...sealed.paths].sort();
    const requestPaths = [...component.paths].sort();
    if (
      sealed === undefined ||
      component.content !== sealed.content ||
      requestPaths.length !== sealedPaths.length ||
      requestPaths.some((path, index) => path !== sealedPaths[index])
    ) {
      throw new Error("request components do not match sealed candidate inventory");
    }
  }
  return components;
}

function assertCoverage(sourceRoot: string, inventory: CandidateSourceInventory): void {
  const source = hashSourceTree(sourceRoot);
  if (source.treeSha256 !== inventory.source.treeSha256) {
    throw new Error("materialized source does not match the sealed candidate inventory");
  }
  const exclusions = [...inventory.exclusions.map((entry) => entry.path)].sort();
  const symlinks = [...symlinkPaths(sourceRoot)].sort();
  if (JSON.stringify(exclusions) !== JSON.stringify(symlinks)) {
    throw new Error("candidate source symlink exclusions do not match materialized source");
  }
  for (const file of source.files) {
    const coverage = inventory.components.filter((component) =>
      component.paths.some((path) => componentCoversPath(path, file.path)),
    );
    if (coverage.length !== 1) {
      throw new Error(
        `source file is not covered by exactly one candidate component: ${file.path}`,
      );
    }
  }
}

/** Validate an immutable, candidate-only inventory. It never reads active pins or evidence. */
export function defineCandidateSourceInventory(value: unknown): CandidateSourceInventory {
  return Object.freeze(inventorySchema.parse(value));
}

/**
 * Produce bounded canonical Scanner requests for a sealed candidate source.
 * Candidate preparation cannot qualify, publish, or replace an active catalog.
 */
export function prepareCandidateBaselineRequests(input: {
  sourceRoot: string;
  inventory: CandidateSourceInventory;
}): readonly BaselineVetRequestV1[] {
  const inventory = defineCandidateSourceInventory(input.inventory);
  assertCoverage(input.sourceRoot, inventory);
  const catalog = defineBaselineCatalog({
    id: inventory.source.id,
    owner: inventory.source.owner,
    repo: inventory.source.repository,
    pinnedSha: inventory.source.pinnedCommit,
    components: inventory.components.map((component) => ({
      id: component.id,
      paths: component.paths,
      ...(component.content === "skill" ? { skillContent: true as const } : {}),
    })),
  });
  return createCoreBaselineVetRequests(input.sourceRoot, catalog);
}

/**
 * Compare a sealed candidate request set with the assets the current Workbench
 * actually offers. The result is path-intersection review data only: it never
 * converts an unsigned scan into publisher evidence, qualification, or a pin
 * update.
 */
export function assessCandidateWorkbenchCoverage(input: {
  inventory: CandidateSourceInventory;
  requests: readonly BaselineVetRequestV1[];
  workbench?: z.input<typeof workbenchCoverageInput>;
}): CandidateWorkbenchCoverageV1 {
  const inventory = defineCandidateSourceInventory(input.inventory);
  const components = requestComponents(inventory, input.requests);
  const workbench =
    input.workbench === undefined ? undefined : workbenchCoverageInput.parse(input.workbench);
  const mappings: CandidateWorkbenchPathMappingV1[] = [];
  const unmappedAssetIds: string[] = [];
  const mappedComponents = new Set<string>();
  for (const asset of workbench?.assets ?? []) {
    const matches = inventory.components.filter((component) =>
      component.paths.some((path) => componentCoversPath(path, asset.originalPath)),
    );
    if (matches.length > 1) {
      throw new Error(`ambiguous candidate component coverage for Workbench asset ${asset.id}`);
    }
    const match = matches[0];
    if (match === undefined) {
      unmappedAssetIds.push(asset.id);
      continue;
    }
    const requestComponent = components.get(match.id);
    if (requestComponent === undefined) {
      throw new Error("request components do not match sealed candidate inventory");
    }
    mappedComponents.add(match.id);
    mappings.push({
      assetId: asset.id,
      assetContentDigest: asset.contentDigest,
      candidateComponentId: match.id,
      candidateComponentTreeSha256: requestComponent.treeSha256,
      originalPath: asset.originalPath,
    });
  }
  mappings.sort((left, right) => left.assetId.localeCompare(right.assetId));
  unmappedAssetIds.sort();
  const candidateOnlyComponentIds = inventory.components
    .map((component) => component.id)
    .filter((id) => !mappedComponents.has(id))
    .sort();
  const catalogStatus =
    workbench === undefined
      ? "not-offered"
      : workbench.sourceRevisionId === inventory.source.pinnedCommit
        ? "exact-revision"
        : "revision-mismatch";
  return Object.freeze({
    protocol: "CandidateWorkbenchCoverageV1",
    authority: "none",
    publisherEligibility: "requires-protected-publisher-reexecution",
    activePinAction: "preserve",
    candidateSourceId: inventory.source.id,
    candidateRevisionId: inventory.source.pinnedCommit,
    candidateComponentCount: inventory.components.length,
    catalogStatus,
    ...(workbench === undefined
      ? {}
      : {
          workbenchSourceId: workbench.sourceId,
          workbenchRevisionId: workbench.sourceRevisionId,
        }),
    offeredAssetCount: workbench?.assets.length ?? 0,
    pathMappedAssetCount: mappings.length,
    pathMappings: Object.freeze(mappings),
    unmappedAssetIds: Object.freeze(unmappedAssetIds),
    candidateOnlyComponentIds: Object.freeze(candidateOnlyComponentIds),
  });
}
