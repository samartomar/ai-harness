import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SAFE_ID = /^\/?[a-z0-9][a-z0-9._:/-]*$/;

const relativePathSchema = z
  .string()
  .min(1)
  .refine((value) => {
    if (isAbsolute(value) || value.includes("\\") || value.includes("\0")) return false;
    return !value.split("/").some((part) => part === "" || part === "." || part === "..");
  }, "must be a normalized relative path without traversal");

const hashSchema = z.string().regex(SHA256, "must be a lowercase SHA-256");
const uniqueStrings = z.array(z.string().regex(SAFE_ID)).superRefine((items, context) => {
  if (new Set(items).size !== items.length)
    context.addIssue({ code: "custom", message: "values must be unique" });
});

const ownershipSchema = z
  .object({
    sourcePin: z.string().regex(COMMIT),
    sourcePath: relativePathSchema,
    normalizedHash: hashSchema,
    destination: relativePathSchema,
    owner: z.literal("aih"),
    mergeStrategy: z.enum(["replace", "json-merge", "jsonc-merge", "toml-merge"]),
    previousHash: hashSchema.nullable(),
  })
  .strict();

export const eccProfileSchema = z
  .object({
    version: z.literal(1),
    source: z
      .object({
        repository: z.literal("affaan-m/ECC"),
        commit: z.string().regex(COMMIT, "source commit must be immutable"),
        package: z.literal("ecc-universal"),
        packageVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
        releaseCommit: z.string().regex(COMMIT),
        componentPath: relativePathSchema,
        sourceHash: hashSchema,
        normalizedHash: hashSchema,
        license: z.literal("MIT"),
        reviewReceipt: z.string().min(1),
      })
      .strict(),
    selections: z
      .object({
        baseline: z.tuple([z.literal("core"), z.literal("lang:typescript")]),
        activeSkills: uniqueStrings,
        warmReserveSkills: uniqueStrings,
        coldReserve: z.literal("all-other-pinned-skills"),
      })
      .strict(),
    expected: z
      .object({ skills: z.literal(136), roles: z.literal(67), workflows: z.literal(94) })
      .strict(),
    profileFlags: z
      .object({
        defaultOn: z.tuple([
          z.literal("continuity"),
          z.literal("mcp-health"),
          z.literal("repository-protection"),
        ]),
        userOptIn: z.tuple([z.literal("learning"), z.literal("personal-observability")]),
        onDemand: z.tuple([z.literal("plan-canvas")]),
      })
      .strict(),
    mcpPolicy: z
      .object({
        selected: z.tuple([
          z.literal("code-review-graph"),
          z.literal("codebase-memory-mcp"),
          z.literal("context7"),
          z.literal("serena"),
        ]),
        activation: z.literal("future-aih-owned-projection"),
      })
      .strict(),
    aihAdaptedWorkflows: z.tuple([
      z.literal("/auto-update"),
      z.literal("/hookify"),
      z.literal("/hookify-configure"),
      z.literal("/project-init"),
    ]),
    localPlannedSkills: z.tuple([z.literal("learn-eval"), z.literal("session-continuity")]),
    repoCuratedSkills: z.tuple([z.literal("betterdoc"), z.literal("decision-partner")]),
    ownership: z.array(ownershipSchema).min(1),
    state: z
      .object({ schemaVersion: z.literal(1), lifecycle: z.literal("implementation-pending") })
      .strict(),
  })
  .strict()
  .superRefine((profile, context) => {
    const destinations = profile.ownership.map((item) => item.destination);
    if (new Set(destinations).size !== destinations.length) {
      context.addIssue({
        code: "custom",
        path: ["ownership"],
        message: "ambiguous ownership destination",
      });
    }
  });

export type EccProfile = z.infer<typeof eccProfileSchema>;

const ACTIVE_SKILLS = [
  "agent-architecture-audit",
  "agent-eval",
  "agent-harness-construction",
  "agentic-engineering",
  "ai-first-engineering",
  "api-connector-builder",
  "automation-audit-ops",
  "connections-optimizer",
  "content-hash-cache-pattern",
  "docker-patterns",
  "documentation-lookup",
  "dynamic-workflow-mode",
  "ecc-tools-cost-audit",
  "enterprise-agent-ops",
  "github-ops",
  "opensource-pipeline",
  "regex-vs-llm-structured-text",
  "search-first",
  "security-bounty-hunter",
  "security-review",
  "security-scan",
  "token-budget-advisor",
  "workspace-surface-audit",
];

export const AIH_ECC_PROFILE = {
  version: 1,
  source: {
    repository: "affaan-m/ECC",
    commit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
    package: "ecc-universal",
    packageVersion: "2.1.0",
    releaseCommit: "4da6deac1888690e7fb8572d097ee23db630f7a0",
    componentPath: "manifests/install-components.json",
    sourceHash: "8eac72d3ab4eb41dc6feabadc7f80603999631186aeeb74b0e31019496054ed5",
    normalizedHash: "8eac72d3ab4eb41dc6feabadc7f80603999631186aeeb74b0e31019496054ed5",
    license: "MIT",
    reviewReceipt: "opus-5-profile-audit-2026-08-03",
  },
  selections: {
    baseline: ["core", "lang:typescript"],
    activeSkills: ACTIVE_SKILLS,
    warmReserveSkills: [
      "benchmark",
      "benchmark-methodology",
      "benchmark-optimization-loop",
      "canary-watch",
      "deep-research",
      "deployment-patterns",
      "gateguard",
      "parallel-execution-optimizer",
      "research-ops",
      "safety-guard",
      "team-agent-orchestration",
    ],
    coldReserve: "all-other-pinned-skills",
  },
  expected: { skills: 136, roles: 67, workflows: 94 },
  profileFlags: {
    defaultOn: ["continuity", "mcp-health", "repository-protection"],
    userOptIn: ["learning", "personal-observability"],
    onDemand: ["plan-canvas"],
  },
  mcpPolicy: {
    selected: ["code-review-graph", "codebase-memory-mcp", "context7", "serena"],
    activation: "future-aih-owned-projection",
  },
  aihAdaptedWorkflows: ["/auto-update", "/hookify", "/hookify-configure", "/project-init"],
  localPlannedSkills: ["learn-eval", "session-continuity"],
  repoCuratedSkills: ["betterdoc", "decision-partner"],
  ownership: [
    {
      sourcePin: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
      sourcePath: "manifests/install-components.json",
      normalizedHash: "8eac72d3ab4eb41dc6feabadc7f80603999631186aeeb74b0e31019496054ed5",
      destination: "aih/ecc/profile.json",
      owner: "aih",
      mergeStrategy: "replace",
      previousHash: null,
    },
  ],
  state: { schemaVersion: 1, lifecycle: "implementation-pending" },
} as const satisfies EccProfile;

const catalogEntrySchema = z
  .object({ id: z.string().regex(SAFE_ID), sourcePath: relativePathSchema })
  .strict();
const skillCatalogEntrySchema = catalogEntrySchema
  .extend({ selection: z.enum(["baseline", "leaf"]) })
  .strict();
const catalogSchema = z
  .object({
    skills: z.array(skillCatalogEntrySchema),
    roles: z.array(catalogEntrySchema),
    workflows: z.array(catalogEntrySchema),
  })
  .strict();

export type EccCatalog = z.infer<typeof catalogSchema>;
export interface ResolvedEntry extends z.infer<typeof catalogEntrySchema> {
  owner: "upstream" | "aih-adaptation";
}
export interface ResolvedEccProfile {
  source: EccProfile["source"];
  skills: ResolvedEntry[];
  roles: ResolvedEntry[];
  workflows: ResolvedEntry[];
}

function uniqueEntries(entries: z.infer<typeof catalogEntrySchema>[], kind: string): void {
  const ids = entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${kind} catalog contains duplicate ids`);
  const paths = entries.map((entry) => entry.sourcePath);
  if (new Set(paths).size !== paths.length)
    throw new Error(`${kind} catalog contains ambiguous source paths`);
}

function resolveBase(profileInput: unknown, catalogInput: unknown): ResolvedEccProfile {
  const profile = eccProfileSchema.parse(profileInput);
  const catalog = catalogSchema.parse(catalogInput);
  uniqueEntries(catalog.skills, "skills");
  uniqueEntries(catalog.roles, "roles");
  uniqueEntries(catalog.workflows, "workflows");
  for (const id of profile.selections.activeSkills) {
    if (!catalog.skills.some((entry) => entry.id === id))
      throw new Error(`selected skill leaf is missing: ${id}`);
  }
  const baselineSkills = catalog.skills.filter((entry) => entry.selection === "baseline");
  const leafSkills = catalog.skills.filter((entry) => entry.selection === "leaf");
  if (baselineSkills.length !== 113)
    throw new Error(`baseline skill accounting expected 113, received ${baselineSkills.length}`);
  const expectedLeaves = [...profile.selections.activeSkills].sort();
  const actualLeaves = leafSkills.map((entry) => entry.id).sort();
  if (JSON.stringify(actualLeaves) !== JSON.stringify(expectedLeaves))
    throw new Error("leaf selection does not exactly match the profile");
  for (const [kind, actual, expected] of [
    ["skills", catalog.skills.length, profile.expected.skills],
    ["roles", catalog.roles.length, profile.expected.roles],
    ["workflows", catalog.workflows.length, profile.expected.workflows],
  ] as const)
    if (actual !== expected)
      throw new Error(`${kind} accounting expected ${expected}, received ${actual}`);
  for (const id of profile.aihAdaptedWorkflows) {
    if (!catalog.workflows.some((entry) => entry.id === id))
      throw new Error(`adapted workflow is missing: ${id}`);
  }
  const sort = (entries: z.infer<typeof catalogEntrySchema>[]) =>
    [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const adaptedWorkflows = new Set<string>(profile.aihAdaptedWorkflows);
  return {
    source: profile.source,
    skills: sort(catalog.skills).map((entry) => ({ ...entry, owner: "upstream" })),
    roles: sort(catalog.roles).map((entry) => ({ ...entry, owner: "upstream" })),
    workflows: sort(catalog.workflows).map((entry) => ({
      ...entry,
      owner: adaptedWorkflows.has(entry.id) ? "aih-adaptation" : "upstream",
    })),
  };
}

async function assertContained(root: string, paths: string[]): Promise<void> {
  const canonicalRoot = await realpath(root);
  for (const path of paths) {
    const canonical = await realpath(resolve(canonicalRoot, path));
    const fromRoot = relative(canonicalRoot, canonical);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
      throw new Error(`source path escapes root: ${path}`);
  }
}

export function resolveEccProfile(profile: unknown, catalog: unknown): ResolvedEccProfile;
export function resolveEccProfile(
  profile: unknown,
  catalog: unknown,
  options: { sourceRoot: string },
): Promise<ResolvedEccProfile>;
export function resolveEccProfile(
  profile: unknown,
  catalog: unknown,
  options?: { sourceRoot: string },
): ResolvedEccProfile | Promise<ResolvedEccProfile> {
  const resolved = resolveBase(profile, catalog);
  if (!options) return resolved;
  const paths = [...resolved.skills, ...resolved.roles, ...resolved.workflows].map(
    (entry) => entry.sourcePath,
  );
  return assertContained(options.sourceRoot, paths).then(() => resolved);
}

export function serializeResolvedEccProfile(profile: ResolvedEccProfile): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}
