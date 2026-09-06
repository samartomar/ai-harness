import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertStrictJsonValueV1,
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
} from "../../../contract/strict-json-v1.js";
import type { CatalogCompilerAssemblyInputV1 } from "../compiler-input.js";
import { compilerRegistrationForInputFormatV1 } from "../compilers/formats.js";
import {
  compilePinnedSkillCollectionV1,
  type PinnedSkillCollectionInputV1,
  pinnedSkillCollectionDigestV1,
} from "../compilers/pinned-skill-collection.js";
import { defineCatalogProviderV1 } from "./contracts.js";
import snapshot from "./mattpocock.snapshot.json";

export const MATTPOCOCK_SKILLS_SOURCE_V1 = {
  id: "mattpocock",
  repository: "https://github.com/mattpocock/skills",
  commit: "3cca18b368ae95cdbdebbff572ccafa662551015",
  version: "1.2.3",
} as const;

export const MATTPOCOCK_CANONICAL_SKILL_PATHS_V1 = [
  "skills/engineering/ask-matt/SKILL.md",
  "skills/engineering/diagnosing-bugs/SKILL.md",
  "skills/engineering/grill-with-docs/SKILL.md",
  "skills/engineering/triage/SKILL.md",
  "skills/engineering/improve-codebase-architecture/SKILL.md",
  "skills/engineering/setup-matt-pocock-skills/SKILL.md",
  "skills/engineering/tdd/SKILL.md",
  "skills/engineering/to-spec/SKILL.md",
  "skills/engineering/to-tickets/SKILL.md",
  "skills/engineering/wayfinder/SKILL.md",
  "skills/engineering/implement/SKILL.md",
  "skills/engineering/prototype/SKILL.md",
  "skills/engineering/research/SKILL.md",
  "skills/engineering/domain-modeling/SKILL.md",
  "skills/engineering/codebase-design/SKILL.md",
  "skills/engineering/code-review/SKILL.md",
  "skills/engineering/resolving-merge-conflicts/SKILL.md",
  "skills/engineering/wizard/SKILL.md",
  "skills/productivity/grill-me/SKILL.md",
  "skills/productivity/grilling/SKILL.md",
  "skills/productivity/handoff/SKILL.md",
  "skills/productivity/teach/SKILL.md",
  "skills/productivity/to-questionnaire/SKILL.md",
  "skills/productivity/wait-what/SKILL.md",
  "skills/productivity/writing-for-agents/SKILL.md",
] as const;

export const MATTPOCOCK_SUPPORT_OWNERSHIP_V1 = [
  [
    "skills/engineering/diagnosing-bugs/scripts/hitl-loop.template.sh",
    "skills/engineering/diagnosing-bugs/SKILL.md",
  ],
  ["skills/engineering/ask-matt/PHASE-BOUNDARIES.md", "skills/engineering/ask-matt/SKILL.md"],
  [
    "skills/engineering/codebase-design/DEEPENING.md",
    "skills/engineering/codebase-design/SKILL.md",
  ],
  [
    "skills/engineering/codebase-design/DESIGN-IT-TWICE.md",
    "skills/engineering/codebase-design/SKILL.md",
  ],
  [
    "skills/engineering/domain-modeling/ADR-FORMAT.md",
    "skills/engineering/domain-modeling/SKILL.md",
  ],
  [
    "skills/engineering/domain-modeling/CONTEXT-FORMAT.md",
    "skills/engineering/domain-modeling/SKILL.md",
  ],
  [
    "skills/engineering/improve-codebase-architecture/HTML-REPORT.md",
    "skills/engineering/improve-codebase-architecture/SKILL.md",
  ],
  ["skills/engineering/prototype/LOGIC.md", "skills/engineering/prototype/SKILL.md"],
  ["skills/engineering/prototype/UI.md", "skills/engineering/prototype/SKILL.md"],
  [
    "skills/engineering/setup-matt-pocock-skills/domain.md",
    "skills/engineering/setup-matt-pocock-skills/SKILL.md",
  ],
  [
    "skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md",
    "skills/engineering/setup-matt-pocock-skills/SKILL.md",
  ],
  [
    "skills/engineering/setup-matt-pocock-skills/issue-tracker-gitlab.md",
    "skills/engineering/setup-matt-pocock-skills/SKILL.md",
  ],
  [
    "skills/engineering/setup-matt-pocock-skills/issue-tracker-local.md",
    "skills/engineering/setup-matt-pocock-skills/SKILL.md",
  ],
  [
    "skills/engineering/setup-matt-pocock-skills/triage-labels.md",
    "skills/engineering/setup-matt-pocock-skills/SKILL.md",
  ],
  ["skills/engineering/tdd/mocking.md", "skills/engineering/tdd/SKILL.md"],
  ["skills/engineering/tdd/tests.md", "skills/engineering/tdd/SKILL.md"],
  ["skills/engineering/triage/AGENT-BRIEF.md", "skills/engineering/triage/SKILL.md"],
  ["skills/engineering/triage/OUT-OF-SCOPE.md", "skills/engineering/triage/SKILL.md"],
  ["skills/engineering/wizard/template.sh", "skills/engineering/wizard/SKILL.md"],
  ["skills/productivity/teach/LEARNING-RECORD-FORMAT.md", "skills/productivity/teach/SKILL.md"],
  ["skills/productivity/teach/MISSION-FORMAT.md", "skills/productivity/teach/SKILL.md"],
  ["skills/productivity/teach/RESOURCES-FORMAT.md", "skills/productivity/teach/SKILL.md"],
  [
    "skills/productivity/writing-for-agents/SKILL-MECHANICS.md",
    "skills/productivity/writing-for-agents/SKILL.md",
  ],
] as const;
const BARE_SHA256 = /^[a-f0-9]{64}$/;
const FileSchema = z
  .object({
    path: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(BARE_SHA256),
    base64: z.string(),
  })
  .strict();
const SkillEntrySchema = FileSchema.extend({
  kind: z.literal("skill"),
  frontmatter: z.string(),
}).strict();
const SupportEntrySchema = FileSchema.extend({
  kind: z.literal("support"),
  requiredBy: z.string(),
  referenceKind: z.string(),
}).strict();
const LicenseEntrySchema = FileSchema.extend({ kind: z.literal("license") }).strict();
const SnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    upstream: z
      .object({
        repository: z.string(),
        pin: z.string(),
        pluginVersion: z.string(),
        retrieval: z.string(),
      })
      .strict(),
    inclusion: z
      .object({
        canonicalSkillPaths: z.array(z.string()),
        excludedPrefixes: z.array(z.string()),
        unresolvedRelativeReferences: z.array(z.string()),
        note: z.string(),
      })
      .strict(),
    entries: z.array(z.union([SkillEntrySchema, SupportEntrySchema, LicenseEntrySchema])),
  })
  .strict();

type SnapshotEntryV1 = z.infer<typeof SnapshotSchema>["entries"][number];
type SkillEntryV1 = z.infer<typeof SkillEntrySchema>;
type SupportEntryV1 = z.infer<typeof SupportEntrySchema>;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesForSnapshotEntry(entry: SnapshotEntryV1): Buffer {
  const bytes = Buffer.from(entry.base64, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== entry.base64) {
    throw new TypeError(`Matt Pocock snapshot has non-canonical base64 for ${entry.path}`);
  }
  if (bytes.length !== entry.sizeBytes || sha256(bytes) !== entry.sha256) {
    throw new TypeError(`Matt Pocock snapshot byte integrity mismatch for ${entry.path}`);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("non-canonical UTF-8");
  } catch {
    throw new TypeError(`Matt Pocock snapshot has invalid UTF-8 for ${entry.path}`);
  }
  return bytes;
}

function leadingFrontmatter(text: string, path: string): string {
  const lines = text.split(/\r?\n/u);
  if (lines[0] !== "---") throw new TypeError(`Matt Pocock snapshot lacks frontmatter for ${path}`);
  const closing = lines.indexOf("---", 1);
  if (closing < 1)
    throw new TypeError(`Matt Pocock snapshot has unterminated frontmatter for ${path}`);
  return lines.slice(1, closing).join("\n");
}

function assertSamePaths(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new TypeError(`Matt Pocock snapshot has unexpected ${label}`);
  }
}

function assertMattSource(input: PinnedSkillCollectionInputV1): void {
  const source = input.source;
  if (
    source.id !== MATTPOCOCK_SKILLS_SOURCE_V1.id ||
    source.repository !== MATTPOCOCK_SKILLS_SOURCE_V1.repository ||
    source.commit !== MATTPOCOCK_SKILLS_SOURCE_V1.commit ||
    source.version !== MATTPOCOCK_SKILLS_SOURCE_V1.version
  ) {
    throw new TypeError("Matt Pocock provider requires its exact pinned descriptor");
  }
}

export function prepareMattPocockSnapshotV1(snapshotValue: unknown): PinnedSkillCollectionInputV1 {
  assertStrictJsonValueV1(snapshotValue, "Matt Pocock packaged snapshot");
  const data = SnapshotSchema.parse(snapshotValue);
  if (
    data.upstream.repository !== MATTPOCOCK_SKILLS_SOURCE_V1.repository ||
    data.upstream.pin !== MATTPOCOCK_SKILLS_SOURCE_V1.commit ||
    data.upstream.pluginVersion !== MATTPOCOCK_SKILLS_SOURCE_V1.version
  ) {
    throw new TypeError("Matt Pocock packaged snapshot pin mismatch");
  }
  if (data.inclusion.unresolvedRelativeReferences.length !== 0) {
    throw new TypeError("Matt Pocock snapshot cannot include unresolved relative references");
  }
  assertSamePaths(
    data.inclusion.canonicalSkillPaths,
    MATTPOCOCK_CANONICAL_SKILL_PATHS_V1,
    "canonical skill paths",
  );

  const paths = new Set<string>();
  for (const entry of data.entries) {
    if (paths.has(entry.path)) throw new TypeError(`Matt Pocock snapshot duplicates ${entry.path}`);
    paths.add(entry.path);
    bytesForSnapshotEntry(entry);
  }
  const skills = data.entries.filter((entry): entry is SkillEntryV1 => entry.kind === "skill");
  const supports = data.entries.filter(
    (entry): entry is SupportEntryV1 => entry.kind === "support",
  );
  const licenses = data.entries.filter((entry) => entry.kind === "license");
  if (licenses.length !== 1) {
    throw new TypeError("Matt Pocock snapshot must consume exactly one LICENSE");
  }
  if (skills.length !== 25 || supports.length !== MATTPOCOCK_SUPPORT_OWNERSHIP_V1.length) {
    throw new TypeError("Matt Pocock snapshot has an unexpected packaged entry count");
  }
  const license = licenses[0];
  if (license === undefined || license.path !== "LICENSE") {
    throw new TypeError("Matt Pocock snapshot must consume exactly one LICENSE");
  }
  assertSamePaths(
    skills.map((entry) => entry.path),
    MATTPOCOCK_CANONICAL_SKILL_PATHS_V1,
    "skill entries",
  );

  assertSamePaths(
    supports.map((entry) => `${entry.path}\u0000${entry.requiredBy}`),
    MATTPOCOCK_SUPPORT_OWNERSHIP_V1.map(([path, requiredBy]) => `${path}\u0000${requiredBy}`),
    "support ownership",
  );
  const skillByPath = new Map(skills.map((entry) => [entry.path, entry]));
  for (const support of supports) {
    if (!skillByPath.has(support.requiredBy)) {
      throw new TypeError(`Matt Pocock snapshot has orphan support ${support.path}`);
    }
  }
  const sourceSkills = skills.map((entry) => {
    const skillId = /^skills\/[^/]+\/([^/]+)\/SKILL\.md$/u.exec(entry.path)?.[1];
    if (skillId === undefined) {
      throw new TypeError(`Matt Pocock snapshot has invalid skill path ${entry.path}`);
    }
    const frontmatter = leadingFrontmatter(
      bytesForSnapshotEntry(entry).toString("utf8"),
      entry.path,
    );
    if (frontmatter !== entry.frontmatter) {
      throw new TypeError(
        `Matt Pocock snapshot frontmatter does not match bytes for ${entry.path}`,
      );
    }
    return {
      id: skillId,
      files: [entry, ...supports.filter((support) => support.requiredBy === entry.path)].map(
        (file) => ({
          path: file.path,
          bytesBase64: file.base64,
          sha256: `sha256:${file.sha256}`,
        }),
      ),
    };
  });
  const value = {
    version: "pinned-skill-collection/v1" as const,
    source: MATTPOCOCK_SKILLS_SOURCE_V1,
    license: {
      path: license.path,
      bytesBase64: license.base64,
      sha256: `sha256:${license.sha256}`,
    },
    skills: sourceSkills,
  };
  return { ...value, collectionDigest: pinnedSkillCollectionDigestV1(value) };
}

function fixtureFile(path: string, text: string) {
  const bytes = Buffer.from(text, "utf8");
  return { path, bytesBase64: bytes.toString("base64"), sha256: `sha256:${sha256(bytes)}` };
}

export function mattPocockPinnedSkillCollectionFixtureV1(): PinnedSkillCollectionInputV1 {
  const value = {
    version: "pinned-skill-collection/v1" as const,
    source: MATTPOCOCK_SKILLS_SOURCE_V1,
    license: fixtureFile("LICENSE", "MIT License\n"),
    skills: [
      {
        id: "fixture",
        files: [
          fixtureFile(
            "skills/engineering/fixture/SKILL.md",
            "---\nname: fixture\ndescription: Small provider contract fixture.\n---\nFixture body.\n",
          ),
        ],
      },
    ],
  };
  return { ...value, collectionDigest: pinnedSkillCollectionDigestV1(value) };
}

let packagedSkillCollectionV1: PinnedSkillCollectionInputV1 | undefined;
let packagedSnapshotDigestV1: string | undefined;
let packagedCompilationCacheV1: CatalogCompilerAssemblyInputV1 | undefined;

/** Lazily validates the sealed package only when a baseline or caller requests it. */
export function getMattPocockPinnedSkillCollectionV1(): PinnedSkillCollectionInputV1 {
  if (packagedSkillCollectionV1 === undefined) {
    packagedSkillCollectionV1 = deepFreezeStrictJsonV1(prepareMattPocockSnapshotV1(snapshot));
  }
  return packagedSkillCollectionV1;
}

export function getMattPocockPackagedSnapshotDigestV1(): string {
  if (packagedSnapshotDigestV1 === undefined) {
    packagedSnapshotDigestV1 = `sha256:${canonicalStrictJsonSha256V1(
      getMattPocockPinnedSkillCollectionV1(),
    )}`;
  }
  return packagedSnapshotDigestV1;
}

function compileMattPocockInputV1(
  input: PinnedSkillCollectionInputV1,
): CatalogCompilerAssemblyInputV1 {
  const result = compilePinnedSkillCollectionV1(input);
  return {
    sources: {
      [result.source.id]: {
        id: result.source.id,
        distributor: { kind: "aih", locator: "@aihq/core" },
        upstreamOrigin: { kind: "git", locator: result.source.repository },
        inputFormat: result.source.inputFormat,
        revision: { id: result.source.revisionId, contentDigest: result.source.contentDigest },
        compiler: compilerRegistrationForInputFormatV1(result.source.inputFormat),
      },
    },
    declarations: result.declarations,
    detailBytes: result.detailBytes,
  };
}

/**
 * The immutable packaged input may share a process-local compiled snapshot.
 * Caller-supplied inputs are always revalidated and compiled independently.
 */
export function compileMattPocockSkillCollectionV1(
  input: PinnedSkillCollectionInputV1,
): CatalogCompilerAssemblyInputV1 {
  assertMattSource(input);
  if (input !== packagedSkillCollectionV1) {
    return compileMattPocockInputV1(input);
  }
  if (packagedCompilationCacheV1 === undefined) {
    packagedCompilationCacheV1 = deepFreezeStrictJsonV1(compileMattPocockInputV1(input));
  }
  return structuredClone(packagedCompilationCacheV1);
}

export const mattpocockCatalogProviderV1 = defineCatalogProviderV1({
  providerId: "mattpocock",
  providerVersion: "1",
  fixture: mattPocockPinnedSkillCollectionFixtureV1,
  compile: (input) => [compileMattPocockSkillCollectionV1(input)],
});
