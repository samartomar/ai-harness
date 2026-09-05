import { createHash } from "node:crypto";
import {
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
} from "../../contract/strict-json-v1.js";
import { type PolicyAuthoringCatalog, policyAuthoringCatalog } from "../catalog.js";
import { compileBuiltInCatalogV1 } from "./compilers/built-in.js";
import { compileOrganizationManifestV1 } from "./compilers/organization-manifest.js";
import { compilePinnedBaselineV1 } from "./compilers/pinned-baseline.js";
import {
  assemblyRegistryForCompiledDeclarationsV1,
  type CompiledDeclarationV1,
  compilerRegistrationForInputFormatV1,
} from "./compilers/registry.js";
import {
  type AuthoringAssetV1,
  type AuthoringCatalogBundleV1,
  assembleAuthoringAssetV1,
  type CoreAuthoringCapabilityRegistryEntryV1,
  parseAuthoringCatalogBundleV1,
} from "./contracts.js";
import {
  consumeFreshOrganizationPreparationV1,
  type FreshOrganizationPreparationV1,
} from "./core/organization-preparation.js";

function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function bundleDigest(bundle: Omit<AuthoringCatalogBundleV1, "provenance">): string {
  return `sha256:${canonicalStrictJsonSha256V1({ ...bundle, provenance: {} })}`;
}

/**
 * Core-only integrity gate for prepared catalog payloads. Browser consumers read
 * the prepared bundle; they neither hash nor grant trust to it.
 */
export function verifyAuthoringCatalogBundleIntegrityV1(bundle: AuthoringCatalogBundleV1): void {
  for (const [chunkId, chunk] of Object.entries(bundle.detailChunks)) {
    if (digest(chunk.bytes) !== chunk.digest)
      throw new Error(`detail chunk digest mismatch: ${chunkId}`);
  }
  const { bundleDigest: declaredDigest, ...provenance } = bundle.provenance;
  const expectedDigest = `sha256:${canonicalStrictJsonSha256V1({ ...bundle, provenance })}`;
  if (declaredDigest !== expectedDigest) throw new Error("bundle digest mismatch");
}

function mergeRecords<T>(label: string, records: readonly Record<string, T>[]): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const record of records) {
    for (const [id, value] of Object.entries(record)) {
      if (merged[id] !== undefined) throw new Error(`duplicate ${label} ${id}`);
      merged[id] = value;
    }
  }
  return merged;
}

function requireUniqueDeclarations(declarations: readonly CompiledDeclarationV1[]): void {
  const ids = new Set<string>();
  for (const { declaration } of declarations) {
    if (ids.has(declaration.id)) throw new Error(`duplicate compiled asset ${declaration.id}`);
    ids.add(declaration.id);
  }
}

function requireUniqueRelations(relations: AuthoringCatalogBundleV1["relations"]): void {
  const endpoints = new Set<string>();
  for (const relation of relations) {
    const endpoint = `${relation.fromAssetId}\u0000${relation.toAssetId}`;
    if (endpoints.has(endpoint)) {
      throw new Error(
        `ambiguous catalog relation ${relation.fromAssetId} -> ${relation.toAssetId}`,
      );
    }
    endpoints.add(endpoint);
  }
}

/** A source-neutral compiler result accepted by the Core-only bundle assembler. */
export interface CatalogCompilerAssemblyInputV1 {
  sources: AuthoringCatalogBundleV1["sources"];
  declarations: readonly CompiledDeclarationV1[];
  relations?: AuthoringCatalogBundleV1["relations"];
  groups?: AuthoringCatalogBundleV1["groups"];
  templates?: AuthoringCatalogBundleV1["templates"];
  evidence?: AuthoringCatalogBundleV1["evidence"];
  detailBytes: Record<string, string>;
}

/**
 * Assembles any reviewed compiler outputs. This is the only point where source
 * declarations receive the closed Core action policy and can match exact Core
 * controls. It deliberately has no source- or UI-specific branch.
 */
function assembleCompilerOutputsV1(
  inputs: readonly CatalogCompilerAssemblyInputV1[],
  coreCapabilities: readonly CoreAuthoringCapabilityRegistryEntryV1[],
): AuthoringCatalogBundleV1 {
  const declarations = inputs.flatMap((input) => input.declarations);
  requireUniqueDeclarations(declarations);
  const sources = mergeRecords(
    "source",
    inputs.map((input) => input.sources),
  );
  for (const { declaration, inputFormat } of declarations) {
    const source = sources[declaration.sourceId];
    if (source === undefined || source.revision.id !== declaration.sourceRevisionId) {
      throw new Error(`compiled declaration has no matching immutable source ${declaration.id}`);
    }
    if (
      source.inputFormat !== inputFormat ||
      source.compiler.id !== compilerRegistrationForInputFormatV1(inputFormat).id ||
      source.compiler.version !== compilerRegistrationForInputFormatV1(inputFormat).version
    ) {
      throw new Error(`compiled declaration has an unregistered source compiler ${declaration.id}`);
    }
  }
  const registry = assemblyRegistryForCompiledDeclarationsV1(declarations, coreCapabilities);
  const assets = Object.fromEntries(
    declarations.map(({ declaration }) => {
      const asset = assembleAuthoringAssetV1(declaration, registry);
      return [asset.id, asset];
    }),
  ) as Record<string, AuthoringAssetV1>;
  const detailBytes = mergeRecords(
    "detail chunk",
    inputs.map((input) => input.detailBytes),
  );
  const relations = inputs.flatMap((input) => input.relations ?? []);
  requireUniqueRelations(relations);
  const bareBundle = {
    version: "authoring-catalog-bundle/v1" as const,
    sources,
    assets,
    groups: mergeRecords(
      "group",
      inputs.map((input) => input.groups ?? {}),
    ),
    relations,
    templates: mergeRecords(
      "template",
      inputs.map((input) => input.templates ?? {}),
    ),
    evidence: mergeRecords(
      "evidence",
      inputs.map((input) => input.evidence ?? {}),
    ),
    detailChunks: Object.fromEntries(
      Object.entries(detailBytes).map(([id, bytes]) => [id, { bytes, digest: digest(bytes) }]),
    ),
  };
  const bundle = parseAuthoringCatalogBundleV1({
    ...bareBundle,
    provenance: { bundleDigest: bundleDigest(bareBundle) },
  });
  verifyAuthoringCatalogBundleIntegrityV1(bundle);
  return bundle;
}

/** Generic compiler output cannot claim Scanner/Core custody or qualification. */
function rejectTrustedCompilerEvidence(inputs: readonly CatalogCompilerAssemblyInputV1[]): void {
  for (const input of inputs) {
    for (const evidence of Object.values(input.evidence ?? {})) {
      if (
        evidence.verification.state === "verified" ||
        evidence.qualification.state === "qualified"
      ) {
        throw new Error(
          `untrusted compiler evidence claims Core verification or qualification: ${evidence.id}`,
        );
      }
    }
  }
}
/** Assemble non-Core compiler output with no authority to elevate a control. */
export function assembleAuthoringCatalogBundleFromCompilerOutputsV1(
  inputs: readonly CatalogCompilerAssemblyInputV1[],
): AuthoringCatalogBundleV1 {
  rejectTrustedCompilerEvidence(inputs);
  return assembleCompilerOutputsV1(inputs, []);
}

function sourceDescriptors(
  pinned: ReturnType<typeof compilePinnedBaselineV1>[],
  builtIn: ReturnType<typeof compileBuiltInCatalogV1>,
): AuthoringCatalogBundleV1["sources"] {
  const sources: AuthoringCatalogBundleV1["sources"] = {};
  for (const result of pinned) {
    sources[result.source.id] = {
      id: result.source.id,
      distributor: { kind: "aih", locator: "@aihq/core" },
      upstreamOrigin: { kind: "git", locator: result.source.repository },
      inputFormat: "pinned-baseline/v1",
      revision: { id: result.source.revisionId, contentDigest: result.source.contentDigest },
      compiler: { id: "pinned-baseline", version: "1" },
    };
  }
  sources[builtIn.source.id] = {
    id: builtIn.source.id,
    distributor: { kind: "aih", locator: "@aihq/core" },
    upstreamOrigin: { kind: "aih", locator: builtIn.source.locator },
    inputFormat: "built-in/v1",
    revision: { id: builtIn.source.revisionId, contentDigest: builtIn.source.contentDigest },
    compiler: { id: "built-in", version: "1" },
  };
  return sources;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredSource(
  descriptors: AuthoringCatalogBundleV1["sources"],
  sourceId: string,
): AuthoringCatalogBundleV1["sources"][string] {
  const source = descriptors[sourceId];
  if (source === undefined) throw new Error(`missing compiled source descriptor ${sourceId}`);
  return source;
}

function compileTemplates(catalog: PolicyAuthoringCatalog): AuthoringCatalogBundleV1["templates"] {
  const templates = [
    ...catalog.enterpriseComposition.parts.map((part) => ({
      id: `template:ecc/${part.id}`,
      roots: part.componentIds.map((componentId) => ({
        assetId: `ecc/${componentId}`,
        mode: "select" as const,
        includeOptionalMembers: false,
      })),
      exclusions: [],
    })),
    ...catalog.frameworks.map((framework) => ({
      id: `template:${framework.id}/methodology`,
      roots: [
        {
          assetId: `${framework.id}/profile:methodology`,
          mode: "select" as const,
          includeOptionalMembers: false,
        },
      ],
      exclusions: [],
    })),
  ];
  return Object.fromEntries(
    templates.map((template) => {
      const roots = [...template.roots].sort((left, right) =>
        codeUnitCompare(left.assetId, right.assetId),
      );
      return [
        template.id,
        {
          ...template,
          roots,
          digest: `sha256:${canonicalStrictJsonSha256V1({ ...template, roots })}`,
        },
      ];
    }),
  );
}

/** Normalize a real offline organization manifest for product preparation. */
export function compileOrganizationManifestAssemblyInputV1(
  manifestBytes: string,
): CatalogCompilerAssemblyInputV1 {
  const result = compileOrganizationManifestV1(manifestBytes);
  return {
    sources: {
      [result.source.id]: {
        id: result.source.id,
        distributor: { kind: "organization", locator: result.source.locator },
        upstreamOrigin: { kind: "organization", locator: result.source.locator },
        inputFormat: result.source.inputFormat,
        revision: { id: result.source.revisionId, contentDigest: result.source.contentDigest },
        compiler: { id: "organization-manifest", version: "1" },
        policyInputRequired: true,
      },
    },
    declarations: result.declarations,
    relations: result.relations,
    detailBytes: result.detailBytes,
  };
}

/** Compile one offline organization manifest through the same generic assembler. */
export function organizationManifestCatalogBundleV1(
  manifestBytes: string,
): AuthoringCatalogBundleV1 {
  return assembleAuthoringCatalogBundleFromCompilerOutputsV1([
    compileOrganizationManifestAssemblyInputV1(manifestBytes),
  ]);
}

interface CompiledPolicyCatalogInputsV1 {
  inputs: CatalogCompilerAssemblyInputV1[];
  coreCapabilities: ReturnType<typeof compileBuiltInCatalogV1>["coreCapabilities"];
}

const MAX_BASELINE_INPUT_CACHE_ENTRIES = 4;
const compiledBaselineInputsByDigest = new Map<string, Readonly<CompiledPolicyCatalogInputsV1>>();

function cacheCompiledBaselineInputsV1(
  digest: string,
  value: CompiledPolicyCatalogInputsV1,
): CompiledPolicyCatalogInputsV1 {
  const snapshot = deepFreezeStrictJsonV1(structuredClone(value));
  compiledBaselineInputsByDigest.delete(digest);
  compiledBaselineInputsByDigest.set(digest, snapshot);
  if (compiledBaselineInputsByDigest.size > MAX_BASELINE_INPUT_CACHE_ENTRIES) {
    const oldest = compiledBaselineInputsByDigest.keys().next().value;
    if (oldest !== undefined) compiledBaselineInputsByDigest.delete(oldest);
  }
  return structuredClone(snapshot);
}

/**
 * Compiling the pinned baseline is pure but comparatively expensive. Cache a
 * sealed snapshot keyed by the canonical catalog bytes, then hand every
 * assembler a detached clone. Recomputing the key makes mutations to a caller
 * supplied catalog a cache miss, while the private snapshot cannot be mutated
 * through a returned bundle.
 */
function compiledPolicyCatalogInputsV1(
  catalog: PolicyAuthoringCatalog,
): CompiledPolicyCatalogInputsV1 {
  const cacheKey = canonicalStrictJsonSha256V1(catalog);
  const cached = compiledBaselineInputsByDigest.get(cacheKey);
  if (cached !== undefined) {
    compiledBaselineInputsByDigest.delete(cacheKey);
    compiledBaselineInputsByDigest.set(cacheKey, cached);
    return structuredClone(cached);
  }
  const pinned = catalog.frameworks.map((framework) => compilePinnedBaselineV1(framework));
  const builtIn = compileBuiltInCatalogV1(catalog);
  const descriptors = sourceDescriptors(pinned, builtIn);
  return cacheCompiledBaselineInputsV1(cacheKey, {
    inputs: [
      ...pinned.map((result) => ({
        sources: { [result.source.id]: requiredSource(descriptors, result.source.id) },
        declarations: result.declarations,
        relations: result.relations,
        groups: result.groups,
        evidence: result.evidence as AuthoringCatalogBundleV1["evidence"],
        detailBytes: result.detailBytes,
      })),
      {
        sources: { [builtIn.source.id]: requiredSource(descriptors, builtIn.source.id) },
        declarations: builtIn.declarations,
        groups: {},
        detailBytes: builtIn.detailBytes,
        templates: compileTemplates(catalog),
      },
    ],
    coreCapabilities: builtIn.coreCapabilities,
  });
}

/** Prepare baseline and real organization manifests without a UI source branch. */
export function policyAuthoringCatalogBundleWithOrganizationManifestsV1(
  organizationManifestBytes: readonly string[],
  catalog: PolicyAuthoringCatalog = policyAuthoringCatalog(),
): AuthoringCatalogBundleV1 {
  const baseline = compiledPolicyCatalogInputsV1(catalog);
  return assembleCompilerOutputsV1(
    [
      ...baseline.inputs,
      ...organizationManifestBytes.map(compileOrganizationManifestAssemblyInputV1),
    ],
    baseline.coreCapabilities,
  );
}

/**
 * Core-only bridge for mixed offline and witnessed organization sources. Fresh
 * preparations are re-read through process-local custody before generic assembly.
 */
export function policyAuthoringCatalogBundleWithOrganizationInputsV1(
  organizationManifestBytes: readonly string[],
  preparations: readonly FreshOrganizationPreparationV1[],
  catalog: PolicyAuthoringCatalog = policyAuthoringCatalog(),
): AuthoringCatalogBundleV1 {
  const freshInputs = preparations.map((preparation) => {
    const input = consumeFreshOrganizationPreparationV1(preparation);
    if (input === undefined)
      throw new TypeError("fresh organization preparation custody is unavailable");
    return input;
  });
  const baseline = compiledPolicyCatalogInputsV1(catalog);
  return assembleCompilerOutputsV1(
    [
      ...baseline.inputs,
      ...organizationManifestBytes.map(compileOrganizationManifestAssemblyInputV1),
      ...freshInputs,
    ],
    baseline.coreCapabilities,
  );
}

/** Core-only bridge for fresh operational organization preparations. */
export function policyAuthoringCatalogBundleWithFreshOrganizationPreparationsV1(
  preparations: readonly FreshOrganizationPreparationV1[],
  catalog: PolicyAuthoringCatalog = policyAuthoringCatalog(),
): AuthoringCatalogBundleV1 {
  return policyAuthoringCatalogBundleWithOrganizationInputsV1([], preparations, catalog);
}

/** Core assembles the compact, source-neutral browser bundle from registered compilers. */
export function policyAuthoringCatalogBundle(
  catalog: PolicyAuthoringCatalog = policyAuthoringCatalog(),
): AuthoringCatalogBundleV1 {
  return policyAuthoringCatalogBundleWithOrganizationManifestsV1([], catalog);
}
