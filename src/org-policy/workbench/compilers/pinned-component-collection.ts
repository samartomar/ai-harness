import { createHash } from "node:crypto";
import { z } from "zod";
import { codeUnitCompare } from "../../../capability/package-graph/canonical.js";
import {
  assertSafeRelativePosixPathV1,
  assertStrictJsonValueV1,
  canonicalStrictJsonBytesV1,
} from "../../../contract/strict-json-v1.js";
import type { CompilerAssetDeclarationV1 } from "../contracts.js";
import type { CompiledDeclarationV1 } from "./formats.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const COMPONENT_ID = /^(skill|hook|mcp):[a-z][a-z0-9-]*$/u;
const PROFILE_ID = /^profile:[a-z][a-z0-9-]*$/u;
const TEMPLATE_ID = /^template:[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/u;
const FileSchema = z
  .object({
    path: z.string().min(1).max(1_000),
    bytesBase64: z.string().min(1).max(1_333_336),
    sha256: z.string().regex(SHA256),
    size: z.number().int().min(1).max(1_000_000),
  })
  .strict();
const BaseComponentSchema = z
  .object({
    id: z.string().regex(COMPONENT_ID),
    label: z.string().min(1).max(500),
    description: z.string().min(1).max(4_000),
    primaryPath: z.string().min(1).max(1_000),
    fileRefs: z.array(z.string().min(1).max(1_000)).min(1).max(128),
    requires: z.array(z.string().regex(COMPONENT_ID)).max(128).optional(),
    members: z.array(z.string().regex(COMPONENT_ID)).max(128).optional(),
  })
  .strict();
const SkillComponentSchema = BaseComponentSchema.extend({ kind: z.literal("skill") }).strict();
const HookComponentSchema = BaseComponentSchema.extend({
  kind: z.literal("hook"),
  metadata: z
    .object({
      type: z.literal("command"),
      declaredHosts: z.array(z.string().min(1).max(100)).min(1).max(32),
      event: z.string().min(1).max(100),
      command: z.string().min(1).max(4_000),
      timeoutSeconds: z.number().int().min(1).max(300),
      matcher: z.string().min(1).max(200).optional(),
      statusMessage: z.string().min(1).max(500).optional(),
    })
    .strict(),
}).strict();
const McpComponentSchema = BaseComponentSchema.extend({
  kind: z.literal("mcp"),
  metadata: z
    .object({
      transport: z.literal("stdio"),
      command: z.string().min(1).max(100),
      args: z.array(z.string().min(1).max(1_000)).min(1).max(32),
      declaredDependencyRanges: z.array(z.string().min(1).max(200)).max(32),
      protocol: z
        .object({
          prompts: z.array(z.string().min(1).max(200)).max(64),
          tools: z.array(z.string().min(1).max(200)).max(64),
          modes: z.array(z.string().min(1).max(200)).max(64),
        })
        .strict()
        .optional(),
    })
    .strict(),
}).strict();
const ProfileSchema = z
  .object({
    id: z.string().regex(PROFILE_ID),
    label: z.string().min(1).max(500),
    methodologyKey: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    requires: z.string().regex(COMPONENT_ID),
    originalPath: z.string().min(1).max(1_000),
  })
  .strict();
const TemplateSchema = z
  .object({
    id: z.string().regex(TEMPLATE_ID),
    label: z.string().min(1).max(500),
    profileRef: z.string().regex(PROFILE_ID),
  })
  .strict();
const InputSchema = z
  .object({
    version: z.literal("pinned-component-collection/v1"),
    source: z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
        repository: z.string().url().max(1_000),
        commit: z.string().regex(COMMIT),
        version: z.string().regex(/^\d+\.\d+\.\d+$/u),
        licenseFileRef: z.string().min(1).max(1_000),
      })
      .strict(),
    files: z.array(FileSchema).min(1).max(256),
    components: z
      .array(
        z.discriminatedUnion("kind", [
          SkillComponentSchema,
          HookComponentSchema,
          McpComponentSchema,
        ]),
      )
      .min(1)
      .max(128),
    profile: ProfileSchema.optional(),
    template: TemplateSchema.optional(),
  })
  .strict();

export type PinnedComponentCollectionInputV1 = z.infer<typeof InputSchema>;
type Component = PinnedComponentCollectionInputV1["components"][number];

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalStrictJsonBytesV1(value)).digest("hex")}`;
}
function canonicalBase64(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value)
    throw new TypeError(`${label} must be canonical base64`);
  return bytes;
}
function orderedUnique(values: readonly string[], label: string): string[] {
  const ordered = [...values].sort(codeUnitCompare);
  if (new Set(ordered).size !== ordered.length) throw new TypeError(`${label} must be unique`);
  return ordered;
}
function normalizedInput(value: unknown): PinnedComponentCollectionInputV1 {
  assertStrictJsonValueV1(value, "pinned component collection");
  const parsed = InputSchema.parse(value);
  const files = [...parsed.files]
    .map((file) => ({
      ...file,
      path: assertSafeRelativePosixPathV1(file.path, "component file path"),
    }))
    .sort((left, right) => codeUnitCompare(left.path, right.path));
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new TypeError("component file paths must be unique");
  for (const file of files) {
    const bytes = canonicalBase64(file.bytesBase64, `component file ${file.path}`);
    if (bytes.length !== file.size)
      throw new TypeError(`component file ${file.path} size mismatch`);
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== file.sha256)
      throw new TypeError(`component file ${file.path} digest mismatch`);
  }
  const knownFiles = new Set(files.map((file) => file.path));
  const components = [...parsed.components]
    .map((component) => ({
      ...component,
      primaryPath: assertSafeRelativePosixPathV1(component.primaryPath, "component primary path"),
      fileRefs: orderedUnique(
        component.fileRefs.map((path) =>
          assertSafeRelativePosixPathV1(path, "component file reference"),
        ),
        `component ${component.id} file references`,
      ),
      requires: orderedUnique(component.requires ?? [], `component ${component.id} requirements`),
      members: orderedUnique(component.members ?? [], `component ${component.id} members`),
    }))
    .sort((left, right) => codeUnitCompare(left.id, right.id));
  if (new Set(components.map((component) => component.id)).size !== components.length)
    throw new TypeError("component ids must be unique");
  const knownComponents = new Set(components.map((component) => component.id));
  const licenseFileRef = assertSafeRelativePosixPathV1(parsed.source.licenseFileRef, "license");
  const referencedFiles = new Set([licenseFileRef]);
  if (!knownFiles.has(licenseFileRef)) throw new TypeError("license file reference is absent");
  for (const component of components) {
    if (!component.fileRefs.includes(component.primaryPath))
      throw new TypeError(`component ${component.id} primary path must be a file reference`);
    for (const path of component.fileRefs) {
      if (!knownFiles.has(path))
        throw new TypeError(`component ${component.id} names an unknown file reference ${path}`);
      referencedFiles.add(path);
    }
    for (const relation of [...component.requires, ...component.members])
      if (!knownComponents.has(relation))
        throw new TypeError(`component ${component.id} names unknown relation ${relation}`);
    if (
      (component.kind === "hook" || component.kind === "mcp") &&
      (component.requires.length || component.members.length)
    )
      throw new TypeError(`request component ${component.id} cannot declare catalog relations`);
    if (component.kind === "skill") {
      for (const target of [...component.requires, ...component.members]) {
        if (target === component.id)
          throw new TypeError(`skill component ${component.id} cannot relate to itself`);
        if (components.find((candidate) => candidate.id === target)?.kind !== "skill")
          throw new TypeError(`skill component ${component.id} can only relate to another skill`);
      }
      if (component.requires.some((target) => component.members.includes(target)))
        throw new TypeError(
          `skill component ${component.id} cannot duplicate a requirement as a member`,
        );
    }
  }
  if (parsed.profile !== undefined) {
    const profilePath = assertSafeRelativePosixPathV1(
      parsed.profile.originalPath,
      "profile original path",
    );
    const required = components.find((component) => component.id === parsed.profile?.requires);
    if (required?.kind !== "skill") throw new TypeError("profile requirement must name a skill");
    if (!knownFiles.has(profilePath)) throw new TypeError("profile original path is absent");
    referencedFiles.add(profilePath);
    if (parsed.template?.profileRef !== parsed.profile.id)
      throw new TypeError("template must name the declared profile");
  } else if (parsed.template !== undefined) {
    throw new TypeError("template requires a declared profile");
  }
  if (referencedFiles.size !== files.length)
    throw new TypeError("component file inventory is not closed");
  return {
    ...parsed,
    source: { ...parsed.source, licenseFileRef },
    files,
    components,
    ...(parsed.profile === undefined
      ? {}
      : {
          profile: {
            ...parsed.profile,
            originalPath: assertSafeRelativePosixPathV1(
              parsed.profile.originalPath,
              "profile original path",
            ),
          },
        }),
  };
}

export function pinnedComponentCollectionDigestV1(value: unknown): string {
  return digest(normalizedInput(value));
}
function detailFile(file: PinnedComponentCollectionInputV1["files"][number]) {
  return { path: file.path, sha256: file.sha256, size: file.size };
}
function requiredFile(
  fileByPath: ReadonlyMap<string, PinnedComponentCollectionInputV1["files"][number]>,
  componentId: string,
  path: string,
) {
  const file = fileByPath.get(path);
  if (file === undefined)
    throw new TypeError(`component ${componentId} names an unknown file reference ${path}`);
  return detailFile(file);
}
function componentDigest(input: PinnedComponentCollectionInputV1, component: Component): string {
  const fileByPath = new Map(input.files.map((file) => [file.path, file]));
  return digest({
    version: input.version,
    source: input.source,
    component: {
      ...component,
      files: component.fileRefs.map((path) => requiredFile(fileByPath, component.id, path)),
      relationships: { requires: component.requires ?? [], members: component.members ?? [] },
      ...(input.profile?.requires === component.id
        ? {
            methodology: {
              profileId: input.profile.id,
              methodologyKey: input.profile.methodologyKey,
            },
          }
        : {}),
    },
  });
}

export interface CompiledPinnedComponentCollectionV1 {
  source: {
    id: string;
    revisionId: string;
    contentDigest: string;
    repository: string;
    inputFormat: "pinned-component-collection/v1";
  };
  declarations: CompiledDeclarationV1[];
  relations: Array<{
    fromAssetId: string;
    toAssetId: string;
    kind: "requires" | "member";
    membership?: "required" | "optional";
  }>;
  groups: Record<string, { id: string; label: string; assetIds: string[] }>;
  detailBytes: Record<string, string>;
  templates: Record<
    string,
    {
      id: string;
      label: string;
      roots: Array<{ assetId: string; mode: "select"; includeOptionalMembers: false }>;
      exclusions: [];
      digest: string;
    }
  >;
}

/** Compiles a closed byte-pinned component inventory; it never installs, activates, or executes it. */
export function compilePinnedComponentCollectionV1(
  value: unknown,
): CompiledPinnedComponentCollectionV1 {
  const input = normalizedInput(value);
  const sourceId = `source:${input.source.id}`;
  const declarations: CompiledDeclarationV1[] = [];
  const detailBytes: Record<string, string> = {};
  const methodologyMainId =
    input.profile === undefined ? undefined : `${input.source.id}/${input.profile.requires}`;
  for (const component of input.components) {
    const id = `${input.source.id}/${component.id}`;
    const detailChunkId = `detail:${id}`;
    const contentDigest = componentDigest(input, component);
    const fileByPath = new Map(input.files.map((file) => [file.path, file]));
    detailBytes[detailChunkId] = canonicalStrictJsonBytesV1({
      version: "pinned-component-collection-detail/v1",
      source: input.source,
      component: {
        id: component.id,
        kind: component.kind,
        label: component.label,
        description: component.description,
        primaryPath: component.primaryPath,
        files: component.fileRefs.map((path) => requiredFile(fileByPath, component.id, path)),
        relationships: { requires: component.requires ?? [], members: component.members ?? [] },
        ...(component.kind === "skill" ? {} : { metadata: component.metadata }),
      },
      contentDigest,
    }).toString("utf8");
    const declaration: CompilerAssetDeclarationV1 = {
      id,
      sourceId,
      sourceRevisionId: input.source.commit,
      contentDigest,
      originalPath: component.primaryPath,
      derivation: "upstream",
      kind: component.kind,
      label: component.label,
      detailChunkId,
      declaredHostCapabilities: [],
      ...(id === methodologyMainId && input.profile !== undefined
        ? { exclusiveSlot: "methodology" as const, methodologyKey: input.profile.methodologyKey }
        : {}),
    };
    declarations.push({ declaration, inputFormat: input.version });
  }
  const relations: CompiledPinnedComponentCollectionV1["relations"] = [];
  if (input.profile !== undefined) {
    const profileId = `${input.source.id}/${input.profile.id}`;
    const mainAssetId = `${input.source.id}/${input.profile.requires}`;
    const profileChunkId = `detail:${profileId}`;
    const profileDigest = digest({
      version: input.version,
      source: input.source,
      profile: input.profile,
    });
    detailBytes[profileChunkId] = canonicalStrictJsonBytesV1({
      version: "pinned-component-collection-detail/v1",
      source: input.source,
      profile: input.profile,
      contentDigest: profileDigest,
    }).toString("utf8");
    declarations.push({
      declaration: {
        id: profileId,
        sourceId,
        sourceRevisionId: input.source.commit,
        contentDigest: profileDigest,
        originalPath: input.profile.originalPath,
        derivation: "core-derived",
        kind: "profile",
        label: input.profile.label,
        detailChunkId: profileChunkId,
        declaredHostCapabilities: [],
        exclusiveSlot: "methodology",
        methodologyKey: input.profile.methodologyKey,
      },
      inputFormat: input.version,
    });
    relations.push({ fromAssetId: profileId, toAssetId: mainAssetId, kind: "requires" });
  }
  for (const component of input.components.filter((candidate) => candidate.kind === "skill")) {
    const fromAssetId = `${input.source.id}/${component.id}`;
    for (const target of component.requires ?? [])
      relations.push({ fromAssetId, toAssetId: `${input.source.id}/${target}`, kind: "requires" });
    for (const target of component.members ?? [])
      relations.push({
        fromAssetId,
        toAssetId: `${input.source.id}/${target}`,
        kind: "member",
        membership: "optional",
      });
  }
  const groups = Object.fromEntries(
    [...new Set(declarations.map(({ declaration }) => declaration.kind))]
      .sort(codeUnitCompare)
      .map((kind) => {
        const id = `group:${input.source.id}/${kind}`;
        return [
          id,
          {
            id,
            label: `${input.source.id} ${kind}`,
            assetIds: declarations
              .filter(({ declaration }) => declaration.kind === kind)
              .map(({ declaration }) => declaration.id)
              .sort(),
          },
        ];
      }),
  );
  const template =
    input.template === undefined || input.profile === undefined
      ? undefined
      : {
          id: input.template.id,
          label: input.template.label,
          roots: [
            {
              assetId: `${input.source.id}/${input.profile.id}`,
              mode: "select" as const,
              includeOptionalMembers: false as const,
            },
          ],
          exclusions: [] as [],
        };
  return {
    source: {
      id: sourceId,
      revisionId: input.source.commit,
      contentDigest: digest(input),
      repository: input.source.repository,
      inputFormat: input.version,
    },
    declarations,
    relations,
    groups,
    detailBytes,
    templates:
      template === undefined
        ? {}
        : {
            [template.id]: { ...template, digest: digest({ ...template, profile: input.profile }) },
          },
  };
}
