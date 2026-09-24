import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import {
  canonicalStrictJsonSha256V1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import { type BaselineCatalog, BaselineCatalogSchema } from "./catalog.js";
import { baselineCatalogById } from "./catalogs.js";
import {
  admittedSourceFromCandidateBundleV1,
  assertCollectionSnapshotBytesV1,
  baselineCoverageV1,
  type CollectionInput,
  collectionBaselineCatalogV1,
  collectionCoverageV1,
  collectionFilesV1,
  enforceAcquiredCoveragePathsV1,
  registeredCollectionInputV1,
} from "./scanner-catalog-consumer.js";
import {
  BaselineComponentPathSchema,
  type BaselineSourceEvidence,
  parseBaselineEvidenceLock,
} from "./schema.js";

/**
 * The closed set of upstream subjects a baseline definition may describe. A definition
 * stands in for the installed Catalog's lookup only at a pin that Catalog does not carry;
 * it never names another repository and never rebinds a carried pin.
 */
export const SCANNER_DEFINITION_SOURCES_V1 = {
  ecc: { repository: "affaan-m/ECC", kind: "framework" },
  superpowers: { repository: "obra/Superpowers", kind: "framework" },
  mattpocock: {
    repository: "mattpocock/skills",
    kind: "collection",
    version: "pinned-skill-collection/v1",
  },
  ponytail: {
    repository: "DietrichGebert/ponytail",
    kind: "collection",
    version: "pinned-component-collection/v1",
  },
} as const;
type DefinitionSourceId = keyof typeof SCANNER_DEFINITION_SOURCES_V1;

const DEFINITION_MAX_BYTES = 64 * 1024 * 1024;
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const pinnedFileSchema = z
  .object({
    path: BaselineComponentPathSchema,
    bytesBase64: z
      .string()
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    sha256: sha256Schema.optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .strict();
const collectionSourceSchema = z
  .object({
    id: z.string(),
    repository: z.string(),
    commit: commitSchema,
    version: z.string().min(1).max(100).optional(),
    licenseFileRef: BaselineComponentPathSchema.optional(),
  })
  .strict();
const skillCollectionSchema = z
  .object({
    version: z.literal("pinned-skill-collection/v1"),
    collectionDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
    source: collectionSourceSchema,
    license: pinnedFileSchema.optional(),
    skills: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
            files: z.array(pinnedFileSchema).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const componentCollectionSchema = z
  .object({
    version: z.literal("pinned-component-collection/v1"),
    source: collectionSourceSchema,
    files: z.array(pinnedFileSchema).min(1),
    components: z
      .array(
        z
          .object({
            id: z.string(),
            kind: z.string().min(1).max(100),
            label: z.string().optional(),
            description: z.string().optional(),
            primaryPath: BaselineComponentPathSchema.optional(),
            fileRefs: z.array(BaselineComponentPathSchema).min(1),
          })
          .strict(),
      )
      .min(1),
    profile: z.unknown().optional(),
    template: z.unknown().optional(),
  })
  .strict();

export interface ScannerDefinitionDepsV1 {
  /** The installed Catalog's catalog for an id; it throws when the Catalog is unusable. */
  readonly carriedCatalog?: (id: DefinitionSourceId) => BaselineCatalog | undefined;
}

export type ScannerDefinitionResolutionV1 =
  | { readonly route: "definition"; readonly catalog: BaselineCatalog }
  | { readonly route: "installed"; readonly catalog: BaselineCatalog };

function fail(message: string): never {
  throw new Error(`baseline definition: ${message}`);
}

function readDefinition(path: string): Record<string, unknown> {
  const opened = readRegularFileWithStats(resolve(path), { maxBytes: DEFINITION_MAX_BYTES });
  if (opened === undefined || opened.contents.length === 0) fail(`unusable file ${path}`);
  const text = opened.contents.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(opened.contents)) fail(`non-UTF-8 file ${path}`);
  try {
    return parseStrictJsonObjectV1(text, "baseline definition");
  } catch (error) {
    return fail(`not one strict JSON object (${error instanceof Error ? error.message : error})`);
  }
}

function parsed<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success)
    fail(`${label} is malformed: ${result.error.issues[0]?.message ?? "invalid"}`);
  return result.data;
}

function collectionCatalog(value: Record<string, unknown>, id: DefinitionSourceId) {
  const expected = SCANNER_DEFINITION_SOURCES_V1[id];
  if (expected.kind !== "collection") return fail(`${id} is not a collection`);
  const input: CollectionInput =
    expected.version === "pinned-skill-collection/v1"
      ? parsed(skillCollectionSchema, value, `${id} collection`)
      : parsed(componentCollectionSchema, value, `${id} collection`);
  const carried = new Set<string>();
  for (const file of collectionFilesV1(input) as readonly z.infer<typeof pinnedFileSchema>[]) {
    if (carried.has(file.path)) fail(`${id} collection repeats file ${file.path}`);
    carried.add(file.path);
    const bytes = Buffer.from(file.bytesBase64, "base64");
    if (
      file.sha256 !== undefined &&
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    )
      fail(`${id} collection file ${file.path} sha256 disagrees with its bytes`);
    if (file.size !== undefined && file.size !== bytes.length)
      fail(`${id} collection file ${file.path} size disagrees with its bytes`);
  }
  for (const component of input.components ?? [])
    for (const ref of component.fileRefs)
      if (!carried.has(ref))
        fail(`${id} collection component ${component.id} names uncarried ${ref}`);
  if (input.source.repository !== `https://github.com/${expected.repository}`)
    fail(`${id} collection must name https://github.com/${expected.repository}`);
  try {
    return { input, catalog: collectionBaselineCatalogV1(input) };
  } catch (error) {
    return fail(
      `${id} collection is malformed (${error instanceof Error ? error.message : error})`,
    );
  }
}

/**
 * How component paths may relate across one definition. `disjoint` (the default) is the
 * whole-repository inventory Scan's request-set route requires: no path equals or contains
 * another anywhere in the inventory. `compiler-catalog` is the named exception for a
 * Catalog-compiled catalog whose components are deliberately overlapping views of shared
 * files (as in the governed ECC vendor lock); it still refuses overlap inside one component.
 */
export const SCANNER_DEFINITION_OVERLAP_MODES_V1 = ["disjoint", "compiler-catalog"] as const;
export type ScannerDefinitionOverlapModeV1 = (typeof SCANNER_DEFINITION_OVERLAP_MODES_V1)[number];

/**
 * Reject two paths where one equals or is a path-segment ancestor of the other: inside one
 * component always, and between components unless the mode is `compiler-catalog`.
 */
function assertNoPathOverlap(
  catalog: BaselineCatalog,
  overlap: ScannerDefinitionOverlapModeV1,
): void {
  const report = (ancestor: string, path: string, ancestorOwner: string, owner: string) => {
    if (ancestorOwner === owner) fail(`component ${owner} paths overlap: ${ancestor}, ${path}`);
    if (overlap === "disjoint")
      fail(`components ${ancestorOwner} and ${owner} overlap: ${ancestor}, ${path}`);
  };
  // Every path's owning components, in inventory order; an equal path is checked on entry.
  const owners = new Map<string, string[]>();
  for (const component of catalog.components)
    for (const path of component.paths) {
      const existing = owners.get(path) ?? [];
      for (const owner of existing) report(path, path, owner, component.id);
      owners.set(path, [...existing, component.id]);
    }
  // A path overlaps each owner of every proper ancestor, compared segment by segment.
  for (const component of catalog.components)
    for (const path of component.paths) {
      const segments = path.split("/");
      for (let length = 1; length < segments.length; length += 1) {
        const ancestor = segments.slice(0, length).join("/");
        for (const owner of owners.get(ancestor) ?? []) report(ancestor, path, owner, component.id);
      }
    }
}

/**
 * The case mapping two paths are compared under: Unicode NFC, then JavaScript's
 * locale-independent `toLowerCase()` (Scan's win32 rule). Paths equal under it name one
 * file on a case-insensitive (Windows, default macOS) file system, so a definition may
 * spell each path, and each ancestor, only one way on every platform.
 */
function scannerDefinitionPathCaseKeyV1(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function assertNoCaseAliases(catalog: BaselineCatalog): void {
  const spellings = new Map<string, string>();
  for (const component of catalog.components)
    for (const path of component.paths) {
      const segments = path.split("/");
      for (let length = 1; length <= segments.length; length += 1) {
        const prefix = segments.slice(0, length).join("/");
        const key = scannerDefinitionPathCaseKeyV1(prefix);
        const existing = spellings.get(key);
        if (existing === undefined) spellings.set(key, prefix);
        else if (existing !== prefix) fail(`paths differ only by case: ${existing}, ${prefix}`);
      }
    }
}

/**
 * Reject case aliases, a missing path, a segment the file system spells differently, a
 * link at any segment, or overlapping paths (see the mode). The exact spelling is read from
 * each parent directory, so a case-insensitive `lstat` cannot accept another spelling.
 */
function assertComponentPaths(
  sourceRoot: string,
  catalog: BaselineCatalog,
  overlap: ScannerDefinitionOverlapModeV1,
): void {
  const root = resolve(sourceRoot);
  assertNoCaseAliases(catalog);
  const listings = new Map<string, ReadonlySet<string>>();
  const entries = (directory: string) => {
    let names = listings.get(directory);
    if (names === undefined) {
      names = new Set(readdirSync(directory));
      listings.set(directory, names);
    }
    return names;
  };
  for (const component of catalog.components) {
    for (const path of component.paths) {
      let current = root;
      for (const part of path.split("/")) {
        let names: ReadonlySet<string>;
        try {
          names = entries(current);
        } catch {
          fail(`path does not exist: ${path}`);
        }
        if (!names.has(part)) {
          const key = scannerDefinitionPathCaseKeyV1(part);
          if ([...names].some((name) => scannerDefinitionPathCaseKeyV1(name) === key))
            fail(`path spelling differs from the file system: ${path}`);
          fail(`path does not exist: ${path}`);
        }
        current = resolve(current, part);
        if (lstatSync(current).isSymbolicLink()) fail(`path traverses a link: ${path}`);
      }
    }
  }
  assertNoPathOverlap(catalog, overlap);
}

/** Order-insensitive identity: component and path order carry no meaning for a Scanner catalog. */
function catalogIdentity(catalog: BaselineCatalog): string {
  return `sha256:${canonicalStrictJsonSha256V1({
    ...catalog,
    components: catalog.components
      .map((component) => ({ ...component, paths: [...component.paths].sort(codeUnitCompare) }))
      .sort((left, right) => codeUnitCompare(left.id, right.id)),
  })}`;
}

function installedCarriedCatalog(id: DefinitionSourceId): BaselineCatalog | undefined {
  if (SCANNER_DEFINITION_SOURCES_V1[id].kind === "framework") return baselineCatalogById(id);
  const input = registeredCollectionInputV1(id);
  return input === undefined ? undefined : collectionBaselineCatalogV1(input);
}

/**
 * Resolve `--definition` for one checkout. The installed Catalog stays the authority for
 * every pin it carries: an identical definition defers to it, a different one is refused,
 * and an unusable Catalog propagates its refusal. Only an uncarried pin uses the definition.
 */
export function resolveScannerDefinitionV1(
  input: ScannerDefinitionInputV1,
  deps: ScannerDefinitionDepsV1 = {},
): ScannerDefinitionResolutionV1 {
  return resolveDefinition(input, deps).resolution;
}

interface ScannerDefinitionInputV1 {
  readonly sourceRoot: string;
  readonly catalogId: string;
  readonly definitionPath: string;
  readonly head: string;
  /** Defaults to `disjoint`; `compiler-catalog` must be named explicitly. */
  readonly overlap?: ScannerDefinitionOverlapModeV1;
}

function resolveDefinition(
  input: ScannerDefinitionInputV1,
  deps: ScannerDefinitionDepsV1,
): {
  resolution: ScannerDefinitionResolutionV1;
  id: DefinitionSourceId;
  collection?: CollectionInput;
} {
  const { catalogId } = input;
  if (!Object.hasOwn(SCANNER_DEFINITION_SOURCES_V1, catalogId))
    fail(
      `unknown subject ${JSON.stringify(catalogId)}; expected ${Object.keys(SCANNER_DEFINITION_SOURCES_V1).join("|")}`,
    );
  const id = catalogId as DefinitionSourceId;
  const expected = SCANNER_DEFINITION_SOURCES_V1[id];
  const value = readDefinition(input.definitionPath);
  // A collection subject takes either its pinned collection input (which always declares a
  // `version`) or the disjoint whole-repository inventory (a BaselineCatalog, which never
  // does). The document's own shape decides; each is then validated strictly as itself.
  const collection =
    expected.kind === "collection" && Object.hasOwn(value, "version")
      ? collectionCatalog(value, id)
      : undefined;
  const catalog = collection?.catalog ?? parsed(BaselineCatalogSchema, value, `${id} definition`);
  if (catalog.id !== id) fail(`definition id ${catalog.id} is not ${id}`);
  if (`${catalog.owner}/${catalog.repo}` !== expected.repository)
    fail(`${id} must name ${expected.repository}, not ${catalog.owner}/${catalog.repo}`);
  if (input.head !== catalog.pinnedSha)
    fail(`${id} checkout is ${input.head}, definition pins ${catalog.pinnedSha}`);
  if (collection !== undefined) assertCollectionSnapshotBytesV1(input.sourceRoot, collection.input);
  const overlap = input.overlap ?? "disjoint";
  if (!SCANNER_DEFINITION_OVERLAP_MODES_V1.includes(overlap))
    fail(`unknown overlap mode ${JSON.stringify(overlap)}`);
  assertComponentPaths(input.sourceRoot, catalog, overlap);

  const carried = (deps.carriedCatalog ?? installedCarriedCatalog)(id);
  const collectionInput = collection === undefined ? {} : { collection: collection.input };
  if (carried === undefined || carried.pinnedSha !== catalog.pinnedSha)
    return { resolution: { route: "definition", catalog }, id, ...collectionInput };
  const carriedIdentity = catalogIdentity(carried);
  const definitionIdentity = catalogIdentity(catalog);
  if (carriedIdentity !== definitionIdentity)
    fail(
      `installed Catalog carries ${id}@${carried.pinnedSha} (${carriedIdentity}); the definition differs (${definitionIdentity})`,
    );
  return { resolution: { route: "installed", catalog: carried }, id, ...collectionInput };
}

function readJsonFile(path: string, label: string, maxBytes: number): unknown {
  const opened = readRegularFileWithStats(resolve(path), { maxBytes });
  if (opened === undefined || opened.contents.length === 0) fail(`unusable ${label} ${path}`);
  try {
    return parseStrictJsonObjectV1(
      new TextDecoder("utf-8", { fatal: true }).decode(opened.contents),
      label,
    );
  } catch (error) {
    return fail(
      `${label} is not one strict JSON object (${error instanceof Error ? error.message : error})`,
    );
  }
}

/**
 * Coverage for a definition at a pin the installed Catalog does not carry. The admitted
 * source and its compiled assets come from a Catalog-compiled single-source bundle at that
 * pin; a framework's vetted snapshot comes from the assembled vendor lock (`baseline:assemble`).
 * Every binding the installed route checks is checked here against those explicit inputs.
 */
export function prepareDefinitionScannerCoverageV1(
  input: ScannerDefinitionInputV1 & {
    readonly sourceBundlePath: string;
    readonly vendorLockPath?: string;
  },
  deps: ScannerDefinitionDepsV1 = {},
) {
  const { resolution, id, collection } = resolveDefinition(input, deps);
  const { catalog } = resolution;
  if (resolution.route === "installed")
    fail(`the installed Catalog carries ${id}@${catalog.pinnedSha}; run without candidate inputs`);
  if (collection !== undefined && input.vendorLockPath !== undefined)
    fail("--vendor-lock applies only to ecc and superpowers");
  const admitted = admittedSourceFromCandidateBundleV1(
    readJsonFile(input.sourceBundlePath, "candidate source bundle", 64 * 1024 * 1024),
    `source:${id}`,
  );
  if (admitted.source.revision.id !== catalog.pinnedSha)
    fail(
      `candidate source bundle admits ${id}@${admitted.source.revision.id}, definition pins ${catalog.pinnedSha}`,
    );
  if (collection !== undefined)
    return enforceAcquiredCoveragePathsV1(
      input.sourceRoot,
      collectionCoverageV1(input.sourceRoot, collection, admitted),
    );
  if (id !== "ecc" && id !== "superpowers") return fail(`${id} is not a framework`);
  if (input.vendorLockPath === undefined)
    fail(`${id} coverage requires --vendor-lock <assembled lock>`);
  let snapshot: BaselineSourceEvidence | undefined;
  try {
    snapshot = parseBaselineEvidenceLock(
      readJsonFile(input.vendorLockPath, "vendor lock", 64 * 1024 * 1024),
    ).sources.find((source) => source.id === id);
  } catch (error) {
    return fail(`vendor lock is malformed (${error instanceof Error ? error.message : error})`);
  }
  if (snapshot === undefined || snapshot.pinnedSha !== catalog.pinnedSha)
    fail(`vendor lock does not vet ${id}@${catalog.pinnedSha}`);
  return enforceAcquiredCoveragePathsV1(
    input.sourceRoot,
    baselineCoverageV1(input.sourceRoot, id, catalog, snapshot, admitted),
  );
}
