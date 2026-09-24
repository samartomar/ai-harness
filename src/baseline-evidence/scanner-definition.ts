import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
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
  assertCollectionSnapshotBytesV1,
  type CollectionInput,
  collectionBaselineCatalogV1,
  collectionFilesV1,
  registeredCollectionInputV1,
} from "./scanner-catalog-consumer.js";
import { BaselineComponentPathSchema } from "./schema.js";

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

/** Reject a missing path, a link at any segment, or two paths of one component that overlap. */
function assertComponentPaths(sourceRoot: string, catalog: BaselineCatalog): void {
  const root = resolve(sourceRoot);
  for (const component of catalog.components) {
    const paths = [...component.paths].sort(codeUnitCompare);
    for (const [index, path] of paths.entries()) {
      const next = paths[index + 1];
      if (next?.startsWith(`${path}/`))
        fail(`component ${component.id} paths overlap: ${path}, ${next}`);
      let current = root;
      for (const part of path.split("/")) {
        current = resolve(current, part);
        let stats: ReturnType<typeof lstatSync>;
        try {
          stats = lstatSync(current);
        } catch {
          fail(`path does not exist: ${path}`);
        }
        if (stats.isSymbolicLink()) fail(`path traverses a link: ${path}`);
      }
    }
  }
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
  input: {
    readonly sourceRoot: string;
    readonly catalogId: string;
    readonly definitionPath: string;
    readonly head: string;
  },
  deps: ScannerDefinitionDepsV1 = {},
): ScannerDefinitionResolutionV1 {
  const { catalogId } = input;
  if (!Object.hasOwn(SCANNER_DEFINITION_SOURCES_V1, catalogId))
    fail(
      `unknown subject ${JSON.stringify(catalogId)}; expected ${Object.keys(SCANNER_DEFINITION_SOURCES_V1).join("|")}`,
    );
  const id = catalogId as DefinitionSourceId;
  const expected = SCANNER_DEFINITION_SOURCES_V1[id];
  const value = readDefinition(input.definitionPath);
  const collection = expected.kind === "collection" ? collectionCatalog(value, id) : undefined;
  const catalog = collection?.catalog ?? parsed(BaselineCatalogSchema, value, `${id} definition`);
  if (catalog.id !== id) fail(`definition id ${catalog.id} is not ${id}`);
  if (`${catalog.owner}/${catalog.repo}` !== expected.repository)
    fail(`${id} must name ${expected.repository}, not ${catalog.owner}/${catalog.repo}`);
  if (input.head !== catalog.pinnedSha)
    fail(`${id} checkout is ${input.head}, definition pins ${catalog.pinnedSha}`);
  if (collection !== undefined) assertCollectionSnapshotBytesV1(input.sourceRoot, collection.input);
  assertComponentPaths(input.sourceRoot, catalog);

  const carried = (deps.carriedCatalog ?? installedCarriedCatalog)(id);
  if (carried === undefined || carried.pinnedSha !== catalog.pinnedSha)
    return { route: "definition", catalog };
  const carriedIdentity = catalogIdentity(carried);
  const definitionIdentity = catalogIdentity(catalog);
  if (carriedIdentity !== definitionIdentity)
    fail(
      `installed Catalog carries ${id}@${carried.pinnedSha} (${carriedIdentity}); the definition differs (${definitionIdentity})`,
    );
  return { route: "installed", catalog: carried };
}
