import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  assertSafeRelativePosixPathV1,
  assertStrictJsonValueV1,
  canonicalStrictJsonBytesV1,
} from "../../../contract/strict-json-v1.js";
import type { CompilerAssetDeclarationV1 } from "../contracts.js";
import type { CompiledDeclarationV1 } from "./formats.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SOURCE_ID = /^[a-z][a-z0-9-]*$/;
const REPOSITORY = /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._/-]+$/;

const FileSchema = z
  .object({ path: z.string(), bytesBase64: z.string(), sha256: z.string() })
  .strict();
const SkillSchema = z
  .object({ id: z.string().regex(SOURCE_ID), files: z.array(FileSchema).min(1) })
  .strict();
const SourceSchema = z
  .object({
    id: z.string().regex(SOURCE_ID),
    repository: z.string().regex(REPOSITORY),
    commit: z.string().regex(COMMIT),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  })
  .strict();
const InputSchema = z
  .object({
    version: z.literal("pinned-skill-collection/v1"),
    source: SourceSchema,
    license: FileSchema,
    /** Bounded to the catalog-wide provider asset scale without constraining real source inventories. */
    skills: z.array(SkillSchema).min(1).max(1000),
    collectionDigest: z.string().regex(SHA256),
  })
  .strict();

export type PinnedSkillCollectionInputV1 = z.infer<typeof InputSchema>;
export interface CompiledPinnedSkillCollectionV1 {
  source: {
    id: string;
    revisionId: string;
    contentDigest: string;
    repository: string;
    inputFormat: "pinned-skill-collection/v1";
  };
  declarations: CompiledDeclarationV1[];
  detailBytes: Record<string, string>;
}

type PinnedFileV1 = z.infer<typeof FileSchema>;
type PinnedSkillV1 = z.infer<typeof SkillSchema>;

function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalBase64(value: string, label: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw new TypeError(`${label} must be canonical base64`);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("non-canonical UTF-8");
  } catch {
    throw new TypeError(`${label} must contain valid UTF-8`);
  }
  return bytes;
}

function recordDigest(skill: PinnedSkillV1): string {
  return digest(
    canonicalStrictJsonBytesV1({
      id: skill.id,
      files: [...skill.files].sort((left, right) => left.path.localeCompare(right.path)),
    }),
  );
}

export function pinnedSkillCollectionDigestV1(
  input: Omit<PinnedSkillCollectionInputV1, "collectionDigest">,
): string {
  return digest(
    canonicalStrictJsonBytesV1({
      ...input,
      skills: [...input.skills].sort((left, right) => left.id.localeCompare(right.id)),
    }),
  );
}

function validateFile(file: PinnedFileV1, label: string): void {
  assertSafeRelativePosixPathV1(file.path, `${label} path`);
  if (!SHA256.test(file.sha256)) throw new TypeError(`${label} has invalid SHA-256`);
  const bytes = canonicalBase64(file.bytesBase64, label);
  if (digest(bytes) !== file.sha256) throw new TypeError(`${label} digest mismatch`);
}

function entryForSkill(skill: PinnedSkillV1, files: readonly PinnedFileV1[]): PinnedFileV1 {
  const entries = files.filter((file) => file.path.endsWith("/SKILL.md"));
  if (entries.length !== 1) {
    throw new TypeError(`pinned skill ${skill.id} must contain exactly one SKILL.md`);
  }
  const entry = entries[0];
  if (entry === undefined) throw new TypeError(`pinned skill ${skill.id} is missing SKILL.md`);
  const directory = entry.path.slice(0, -"/SKILL.md".length);
  if (!files.every((file) => file.path === entry.path || file.path.startsWith(`${directory}/`))) {
    throw new TypeError(`pinned skill ${skill.id} has a resource outside its directory`);
  }
  return entry;
}

function frontmatterForSkill(text: string, label: string): { name: string; description: string } {
  const lines = text.split(/\r?\n/u);
  if (lines[0] !== "---") throw new TypeError(`${label} is missing YAML frontmatter`);
  const closing = lines.indexOf("---", 1);
  if (closing < 1) throw new TypeError(`${label} has unterminated YAML frontmatter`);
  const document = parseDocument(lines.slice(1, closing).join("\n"));
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new TypeError(`${label} has invalid YAML frontmatter`);
  }
  const value = document.toJS();
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.description !== "string" ||
    value.description.length === 0
  ) {
    throw new TypeError(`${label} frontmatter requires non-empty name and description`);
  }
  return { name: value.name, description: value.description };
}

/**
 * Compiles a closed, byte-pinned skill collection. Source identity is generic;
 * providers own any source-specific pins. This format declares no actions,
 * projectors, evidence, relations, groups, or templates.
 */
export function compilePinnedSkillCollectionV1(
  inputValue: unknown,
): CompiledPinnedSkillCollectionV1 {
  assertStrictJsonValueV1(inputValue, "pinned skill collection input");
  const input = InputSchema.parse(inputValue);
  const { collectionDigest, license, skills, source, version } = input;
  if (collectionDigest !== pinnedSkillCollectionDigestV1({ version, source, license, skills })) {
    throw new TypeError("pinned skill collection digest mismatch");
  }
  validateFile(license, "pinned skill collection license");
  if (license.path !== "LICENSE") {
    throw new TypeError("pinned skill collection license path must be LICENSE");
  }

  const ids = new Set<string>();
  const paths = new Set<string>([license.path]);
  const declarations: CompiledDeclarationV1[] = [];
  const detailBytes: Record<string, string> = {};
  for (const skill of skills) {
    if (ids.has(skill.id)) {
      throw new TypeError(`pinned skill collection duplicates skill ${skill.id}`);
    }
    ids.add(skill.id);
    const files = [...skill.files].sort((left, right) => left.path.localeCompare(right.path));
    for (const file of files) {
      if (paths.has(file.path)) {
        throw new TypeError(`pinned skill collection duplicates file ${file.path}`);
      }
      paths.add(file.path);
      validateFile(file, `pinned skill ${skill.id}`);
    }
    const entry = entryForSkill(skill, files);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      canonicalBase64(entry.bytesBase64, `pinned skill ${skill.id}`),
    );
    const frontmatter = frontmatterForSkill(text, `pinned skill ${skill.id}`);
    if (frontmatter.name !== skill.id) {
      throw new TypeError(`pinned skill ${skill.id} has mismatched frontmatter name`);
    }

    const contentDigest = recordDigest({ id: skill.id, files });
    const id = `${source.id}/skill:${skill.id}`;
    const detailChunkId = `detail:${id}`;
    detailBytes[detailChunkId] = canonicalStrictJsonBytesV1({
      version: "pinned-skill-collection-detail/v1",
      collectionDigest,
      source,
      skill: {
        id: skill.id,
        description: frontmatter.description,
        contentDigest,
        entryPath: entry.path,
        files: files.map((file) => ({
          path: file.path,
          sha256: file.sha256,
          sizeBytes: canonicalBase64(file.bytesBase64, `pinned skill ${skill.id}`).length,
        })),
      },
      license: {
        path: license.path,
        sha256: license.sha256,
        sizeBytes: canonicalBase64(license.bytesBase64, "pinned skill collection license").length,
      },
    }).toString("utf8");
    const declaration: CompilerAssetDeclarationV1 = {
      id,
      sourceId: `source:${source.id}`,
      sourceRevisionId: source.commit,
      contentDigest,
      originalPath: entry.path,
      derivation: "upstream",
      kind: "skill",
      label: skill.id,
      detailChunkId,
      declaredHostCapabilities: [],
    };
    declarations.push({ declaration, inputFormat: version });
  }

  return {
    source: {
      id: `source:${source.id}`,
      revisionId: source.commit,
      contentDigest: collectionDigest,
      repository: source.repository,
      inputFormat: version,
    },
    declarations,
    detailBytes,
  };
}
