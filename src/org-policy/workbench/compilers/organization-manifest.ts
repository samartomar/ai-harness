import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertSafeRelativePosixPathV1,
  canonicalStrictJsonBytesV1,
  parseStrictJsonObjectV1,
} from "../../../contract/strict-json-v1.js";
import type { CompilerAssetDeclarationV1 } from "../contracts.js";
import type { CompiledDeclarationV1 } from "./registry.js";

const CatalogIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9:._-]*$/)
  .max(240);
const LabelSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) => value === value.trim() && value === value.normalize("NFC") && !/\p{C}/u.test(value),
    "label must be NFC visible text",
  );
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ScanSubjectSchema = z
  .object({
    intakeItemId: CatalogIdSchema,
    sourceDigest: DigestSchema,
  })
  .strict();
const AssetSchema = z
  .object({
    id: CatalogIdSchema,
    kind: z.enum(["mcp", "skill", "agent"]),
    label: LabelSchema,
    path: z.string().min(1).max(1_000),
    scanSubject: ScanSubjectSchema.optional(),
    requires: z.array(CatalogIdSchema).max(1_000).optional(),
    members: z.array(CatalogIdSchema).max(1_000).optional(),
  })
  .strict();
const ManifestSchema = z
  .object({
    version: z.literal("organization-authoring-manifest/v1"),
    source: z
      .object({ id: CatalogIdSchema, revisionId: CatalogIdSchema, locator: LabelSchema.max(1_000) })
      .strict(),
    assets: z.array(AssetSchema).min(1).max(10_000),
  })
  .strict();

export interface CompiledOrganizationManifestV1 {
  source: {
    id: string;
    revisionId: string;
    contentDigest: string;
    locator: string;
    inputFormat: "organization-authoring-manifest/v1";
  };
  declarations: CompiledDeclarationV1[];
  relations: Array<{
    fromAssetId: string;
    toAssetId: string;
    kind: "requires" | "member";
    membership?: "required" | "optional";
  }>;
  detailBytes: Record<string, string>;
  scanSubjects: Record<string, OrganizationManifestScanSubjectV1>;
}

export interface OrganizationManifestScanSubjectV1 {
  rawAssetId: string;
  kind: "mcp" | "skill" | "agent";
  path: string;
  intakeItemId: string;
  sourceDigest: string;
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function compiledAssetId(sourceId: string, assetId: string): string {
  // A bounded source-identity namespace prevents two portable organization
  // manifests from overwriting each other while preserving the raw id in detail.
  return `organization/${sha256(sourceId).slice("sha256:".length, "sha256:".length + 20)}/${assetId}`;
}

function assertDistinctRelations(asset: z.infer<typeof AssetSchema>): void {
  const required = new Set<string>();
  for (const target of asset.requires ?? []) {
    if (required.has(target))
      throw new TypeError(`organization manifest ${asset.id} repeats required target ${target}`);
    required.add(target);
  }
  const optional = new Set<string>();
  for (const target of asset.members ?? []) {
    if (optional.has(target))
      throw new TypeError(`organization manifest ${asset.id} repeats optional member ${target}`);
    if (required.has(target))
      throw new TypeError(
        `organization manifest ${asset.id} has contradictory required and optional target ${target}`,
      );
    optional.add(target);
  }
}

function canonicalDeclarationBytes(asset: z.infer<typeof AssetSchema>): Buffer {
  return canonicalStrictJsonBytesV1({
    id: asset.id,
    kind: asset.kind,
    label: asset.label,
    path: assertSafeRelativePosixPathV1(asset.path, "organization manifest asset path"),
    ...(asset.scanSubject === undefined
      ? {}
      : {
          scanSubject: {
            intakeItemId: asset.scanSubject.intakeItemId,
            sourceDigest: asset.scanSubject.sourceDigest,
          },
        }),
    ...(asset.requires === undefined ? {} : { requires: [...asset.requires].sort() }),
    ...(asset.members === undefined ? {} : { members: [...asset.members].sort() }),
  });
}

/**
 * Compiles a self-contained organization manifest without installing, resolving,
 * or contacting its declared tools. Its bytes are declaration identity only;
 * compiler input cannot nominate an action or projector.
 */
export function compileOrganizationManifestV1(
  manifestBytes: string,
): CompiledOrganizationManifestV1 {
  if (Buffer.byteLength(manifestBytes, "utf8") > 1_000_000) {
    throw new TypeError("organization manifest exceeds 1 MiB");
  }
  const manifest = ManifestSchema.parse(
    parseStrictJsonObjectV1(manifestBytes, "organization authoring manifest"),
  );
  const sourceId = manifest.source.id.startsWith("source:")
    ? manifest.source.id
    : `source:${manifest.source.id}`;
  const ids = new Set<string>();
  const sourceNamespace = sourceId;
  const declarations: CompiledDeclarationV1[] = [];
  const detailBytes: Record<string, string> = {};
  const scanSubjects: Record<string, OrganizationManifestScanSubjectV1> = {};
  const kindById = new Map<string, z.infer<typeof AssetSchema>["kind"]>();
  for (const asset of manifest.assets) {
    if (kindById.has(asset.id))
      throw new TypeError(`organization manifest has duplicate asset ${asset.id}`);
    kindById.set(asset.id, asset.kind);
  }
  for (const asset of manifest.assets) {
    if (ids.has(asset.id))
      throw new TypeError(`organization manifest has duplicate asset ${asset.id}`);
    ids.add(asset.id);
    assertDistinctRelations(asset);
    for (const target of [...(asset.requires ?? []), ...(asset.members ?? [])]) {
      if (target === asset.id)
        throw new TypeError(`organization manifest ${asset.id} cannot reference itself`);
      if (!kindById.has(target))
        throw new TypeError(`organization manifest ${asset.id} references unknown asset ${target}`);
      if (kindById.get(target) === "mcp") {
        throw new TypeError(
          `organization manifest cannot derive a selection from MCP request ${target}`,
        );
      }
    }
    if (
      asset.kind === "mcp" &&
      ((asset.requires?.length ?? 0) > 0 || (asset.members?.length ?? 0) > 0)
    ) {
      throw new TypeError(`organization MCP request ${asset.id} cannot carry selection relations`);
    }
    const id = compiledAssetId(sourceNamespace, asset.id);
    const bytes = canonicalDeclarationBytes(asset);
    const contentDigest = sha256(bytes);
    const detailChunkId = `detail:${id}`;
    detailBytes[detailChunkId] = canonicalStrictJsonBytesV1({
      version: "organization-manifest-detail/v1",
      identity: { kind: "declaration", digest: contentDigest },
      declaration: JSON.parse(bytes.toString("utf8")),
    }).toString("utf8");
    const declaration: CompilerAssetDeclarationV1 = {
      id,
      sourceId,
      sourceRevisionId: manifest.source.revisionId,
      contentDigest,
      originalPath: assertSafeRelativePosixPathV1(asset.path, "organization manifest asset path"),
      derivation: "organization-declaration",
      kind: asset.kind,
      label: asset.label,
      detailChunkId,
      declaredHostCapabilities: [],
    };
    declarations.push({ declaration, inputFormat: "organization-authoring-manifest/v1" });
    if (asset.scanSubject !== undefined) {
      scanSubjects[id] = {
        rawAssetId: asset.id,
        kind: asset.kind,
        path: assertSafeRelativePosixPathV1(asset.path, "organization manifest asset path"),
        intakeItemId: asset.scanSubject.intakeItemId,
        sourceDigest: asset.scanSubject.sourceDigest,
      };
    }
  }
  const relations = manifest.assets.flatMap((asset) => {
    const fromAssetId = compiledAssetId(sourceNamespace, asset.id);
    return [
      ...(asset.requires ?? []).map((target) => ({
        fromAssetId,
        toAssetId: compiledAssetId(sourceNamespace, target),
        kind: "requires" as const,
      })),
      ...(asset.members ?? []).map((target) => ({
        fromAssetId,
        toAssetId: compiledAssetId(sourceNamespace, target),
        kind: "member" as const,
        membership: "optional" as const,
      })),
    ];
  });
  return {
    source: {
      id: sourceId,
      revisionId: manifest.source.revisionId,
      contentDigest: sha256(Buffer.from(manifestBytes, "utf8")),
      locator: manifest.source.locator,
      inputFormat: "organization-authoring-manifest/v1",
    },
    declarations,
    relations,
    detailBytes,
    scanSubjects,
  };
}
