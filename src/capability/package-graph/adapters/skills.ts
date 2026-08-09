import { createHash } from "node:crypto";
import { z } from "zod";
import { type Pack, PacksFileSchema } from "../../../pack/manifest.js";
import {
  type SkillLockEntry,
  SkillLockEntrySchema,
  skillNameSchema,
  sourceScopePathSchema,
} from "../../../skill/lockfile.js";
import {
  type PackageGraphAuthorityDocument,
  PackageGraphAuthorityDocumentSchema,
  PackageGraphAuthoritySchema,
} from "../build.js";
import {
  type PackageGraphPackage,
  type PackageGraphSource,
  type PackageGraphSurface,
  PackageIdSchema,
  SurfaceIdSchema,
} from "../schema.js";
import { normalizeGitHubRepository, parseGitHubSkillSource } from "./github.js";

const StrictSkillSourceScopeSchema = z
  .object({
    selectedSkillNames: z.array(skillNameSchema).nonempty(),
    includedPaths: z.array(sourceScopePathSchema).nonempty(),
    excludedSkillPaths: z.array(sourceScopePathSchema),
  })
  .strict();

const StrictSkillLockEntrySchema = SkillLockEntrySchema.strict().extend({
  sourceScope: StrictSkillSourceScopeSchema.optional(),
});

const StrictSkillsLockSchema = z
  .object({
    schemaVersion: z.literal(1),
    skills: z.array(StrictSkillLockEntrySchema),
  })
  .strict();

export type SkillPackageGraphDiagnosticCode =
  | "package-graph.invalid-utf8"
  | "package-graph.invalid-json"
  | "package-graph.invalid-schema"
  | "package-graph.duplicate-lock-name"
  | "package-graph.duplicate-pack-name"
  | "package-graph.duplicate-pack-member"
  | "package-graph.cross-pack-member"
  | "package-graph.unsupported-source"
  | "package-graph.source-commit-mismatch"
  | "package-graph.invalid-surface-id"
  | "package-graph.invalid-package-id"
  | "package-graph.invalid-host-source"
  | "package-graph.invalid-authority-id"
  | "package-graph.catalog-only-ref"
  | "package-graph.catalog-lock-mismatch"
  | "package-graph.required-checks-unsupported";

export interface SkillPackageGraphDiagnostic {
  authorityKind: "lock" | "catalog";
  code: SkillPackageGraphDiagnosticCode;
  message: string;
  entityId?: string;
}

export interface SkillPackageGraphAdapterInput {
  lockBytes: Buffer;
  packsBytes?: Buffer;
  lockAuthorityId: string;
  catalogAuthorityId: string;
  hostSource: { provider: "github"; repository: string };
}

export interface SkillPackageGraphAdapterResult {
  documents: PackageGraphAuthorityDocument[];
  diagnostics: SkillPackageGraphDiagnostic[];
}

interface ParsedJsonSuccess {
  success: true;
  value: unknown;
}

interface ParsedJsonFailure {
  success: false;
  code: "package-graph.invalid-utf8" | "package-graph.invalid-json";
}

interface ProjectedAuthority<T> {
  document?: PackageGraphAuthorityDocument;
  parsed?: T;
  diagnostics: SkillPackageGraphDiagnostic[];
}

interface SurfaceIdentity {
  readonly source: {
    readonly provider: string;
    readonly repository: string;
  };
  readonly sourceDigest: {
    readonly algorithm: "git-sha1" | "sha256";
    readonly value: string;
  };
}

function exactSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJsonBytes(bytes: Buffer): ParsedJsonSuccess | ParsedJsonFailure {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { success: false, code: "package-graph.invalid-utf8" };
  }
  try {
    return { success: true, value: JSON.parse(text) as unknown };
  } catch {
    return { success: false, code: "package-graph.invalid-json" };
  }
}

function diagnostic(
  authorityKind: "lock" | "catalog",
  code: SkillPackageGraphDiagnosticCode,
  entityId?: string,
): SkillPackageGraphDiagnostic {
  return {
    authorityKind,
    code,
    message: code.replace("package-graph.", "").replaceAll("-", " "),
    ...(entityId === undefined ? {} : { entityId }),
  };
}

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function surfaceFor(
  authorityKind: "lock" | "catalog",
  entry: Pick<SkillLockEntry, "name" | "source" | "commit">,
  diagnostics: SkillPackageGraphDiagnostic[],
): PackageGraphSurface | undefined {
  const id = `skill:${entry.name}`;
  if (!SurfaceIdSchema.safeParse(id).success) {
    diagnostics.push(diagnostic(authorityKind, "package-graph.invalid-surface-id"));
    return undefined;
  }
  const parsedSource = parseGitHubSkillSource(entry.source, entry.commit);
  if (!parsedSource.success) {
    diagnostics.push(
      diagnostic(
        authorityKind,
        parsedSource.reason === "source-commit-mismatch"
          ? "package-graph.source-commit-mismatch"
          : "package-graph.unsupported-source",
      ),
    );
    return undefined;
  }
  return {
    id,
    source: parsedSource.source,
    sourceDigest: parsedSource.sourceDigest,
    declaredRisk: [],
    observedRisk: [],
  };
}

function authorityDocument(
  id: string,
  kind: "lock" | "catalog",
  bytes: Buffer,
  surfaces: PackageGraphSurface[],
  packages: PackageGraphPackage[],
): PackageGraphAuthorityDocument {
  return PackageGraphAuthorityDocumentSchema.parse({
    authority: {
      id,
      kind,
      sourceDigest: { algorithm: "sha256", value: exactSha256(bytes) },
    },
    graph: { schemaVersion: 1, surfaces, packages },
  });
}

function projectLock(input: SkillPackageGraphAdapterInput): ProjectedAuthority<SkillLockEntry[]> {
  const authority = PackageGraphAuthoritySchema.safeParse({
    id: input.lockAuthorityId,
    kind: "lock",
    sourceDigest: { algorithm: "sha256", value: exactSha256(input.lockBytes) },
  });
  if (!authority.success) {
    return { diagnostics: [diagnostic("lock", "package-graph.invalid-authority-id")] };
  }
  const decoded = parseJsonBytes(input.lockBytes);
  if (!decoded.success) {
    return { diagnostics: [diagnostic("lock", decoded.code)] };
  }
  const parsed = StrictSkillsLockSchema.safeParse(decoded.value);
  if (!parsed.success) {
    return { diagnostics: [diagnostic("lock", "package-graph.invalid-schema")] };
  }
  if (duplicate(parsed.data.skills.map(({ name }) => name))) {
    return { diagnostics: [diagnostic("lock", "package-graph.duplicate-lock-name")] };
  }

  const diagnostics: SkillPackageGraphDiagnostic[] = [];
  const surfaces = parsed.data.skills.flatMap((entry) => {
    const surface = surfaceFor("lock", entry, diagnostics);
    return surface === undefined ? [] : [surface];
  });
  if (diagnostics.length > 0) return { diagnostics };
  return {
    document: authorityDocument(input.lockAuthorityId, "lock", input.lockBytes, surfaces, []),
    parsed: parsed.data.skills,
    diagnostics,
  };
}

function packDuplicateDiagnostic(packs: readonly Pack[]): SkillPackageGraphDiagnostic | undefined {
  if (duplicate(packs.map(({ name }) => name))) {
    return diagnostic("catalog", "package-graph.duplicate-pack-name");
  }
  const allMembers: string[] = [];
  for (const pack of packs) {
    const members = pack.skills.map(({ name }) => name);
    if (duplicate(members)) {
      return diagnostic("catalog", "package-graph.duplicate-pack-member");
    }
    allMembers.push(...members);
  }
  if (duplicate(allMembers)) return diagnostic("catalog", "package-graph.cross-pack-member");
  return undefined;
}

function sameSurface(left: SurfaceIdentity, right: SurfaceIdentity): boolean {
  return (
    left.source.provider === right.source.provider &&
    left.source.repository === right.source.repository &&
    left.sourceDigest.algorithm === right.sourceDigest.algorithm &&
    left.sourceDigest.value === right.sourceDigest.value
  );
}

function projectCatalog(
  input: SkillPackageGraphAdapterInput,
  lockSurfaces: ReadonlyMap<string, SurfaceIdentity> | undefined,
): ProjectedAuthority<Pack[]> {
  const packsBytes = input.packsBytes;
  if (packsBytes === undefined) return { diagnostics: [] };
  const authority = PackageGraphAuthoritySchema.safeParse({
    id: input.catalogAuthorityId,
    kind: "catalog",
    sourceDigest: { algorithm: "sha256", value: exactSha256(packsBytes) },
  });
  if (!authority.success) {
    return { diagnostics: [diagnostic("catalog", "package-graph.invalid-authority-id")] };
  }
  const decoded = parseJsonBytes(packsBytes);
  if (!decoded.success) {
    return { diagnostics: [diagnostic("catalog", decoded.code)] };
  }
  const parsed = PacksFileSchema.safeParse(decoded.value);
  if (!parsed.success) {
    return { diagnostics: [diagnostic("catalog", "package-graph.invalid-schema")] };
  }
  const duplicateDiagnostic = packDuplicateDiagnostic(parsed.data.packs);
  if (duplicateDiagnostic !== undefined) return { diagnostics: [duplicateDiagnostic] };

  const hostRepository =
    input.hostSource.provider === "github"
      ? normalizeGitHubRepository(input.hostSource.repository)
      : undefined;
  if (hostRepository === undefined) {
    return { diagnostics: [diagnostic("catalog", "package-graph.invalid-host-source")] };
  }
  const hostSource: PackageGraphSource = { provider: "github", repository: hostRepository };
  const diagnostics: SkillPackageGraphDiagnostic[] = [];
  const surfaces: PackageGraphSurface[] = [];
  const packages: PackageGraphPackage[] = [];
  const sourceDigest = { algorithm: "sha256" as const, value: exactSha256(packsBytes) };

  for (const pack of parsed.data.packs) {
    const packageId = `package:skill-pack/${pack.name}`;
    if (!PackageIdSchema.safeParse(packageId).success) {
      diagnostics.push(diagnostic("catalog", "package-graph.invalid-package-id"));
      continue;
    }
    const members: string[] = [];
    for (const ref of pack.skills) {
      const surface = surfaceFor("catalog", ref, diagnostics);
      if (surface === undefined) continue;
      surfaces.push(surface);
      members.push(surface.id);
      const locked = lockSurfaces?.get(surface.id);
      if (lockSurfaces !== undefined && locked === undefined) {
        diagnostics.push(diagnostic("catalog", "package-graph.catalog-only-ref", surface.id));
      } else if (locked !== undefined && !sameSurface(surface, locked)) {
        diagnostics.push(diagnostic("catalog", "package-graph.catalog-lock-mismatch", surface.id));
      }
    }
    packages.push({
      id: packageId,
      source: hostSource,
      sourceDigest,
      members,
      declaredRisk: [],
      observedRisk: [],
    });
    if ((pack.requiredChecks ?? []).length > 0) {
      diagnostics.push(
        diagnostic("catalog", "package-graph.required-checks-unsupported", packageId),
      );
    }
  }

  const fatal = diagnostics.some(({ code }) =>
    [
      "package-graph.unsupported-source",
      "package-graph.source-commit-mismatch",
      "package-graph.invalid-surface-id",
      "package-graph.invalid-package-id",
    ].includes(code),
  );
  if (fatal) return { diagnostics };
  return {
    document: authorityDocument(
      input.catalogAuthorityId,
      "catalog",
      packsBytes,
      surfaces,
      packages,
    ),
    parsed: parsed.data.packs,
    diagnostics,
  };
}

/** Strictly project committed skill approval and pack bytes into separate authority documents. */
export function adaptSkillPackageGraph(
  input: SkillPackageGraphAdapterInput,
): SkillPackageGraphAdapterResult {
  const lock = projectLock(input);
  const lockSurfaces =
    lock.document === undefined
      ? undefined
      : new Map(lock.document.graph.surfaces.map((surface) => [surface.id, surface]));
  const catalog = projectCatalog(input, lockSurfaces);
  return {
    documents: [lock.document, catalog.document].filter(
      (document): document is PackageGraphAuthorityDocument => document !== undefined,
    ),
    diagnostics: [...lock.diagnostics, ...catalog.diagnostics],
  };
}
