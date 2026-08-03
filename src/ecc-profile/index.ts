import { posix } from "node:path";
import { z } from "zod";
import { hashComponentTree } from "../baseline-evidence/hash.js";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^\/?[a-z0-9][a-z0-9._:/-]*$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const sourcePathSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const segments = value.split("/");
    const invalid =
      value.includes("\\") ||
      value.includes("\0") ||
      value.includes(":") ||
      value.startsWith("/") ||
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.endsWith(".") ||
          segment.endsWith(" ") ||
          WINDOWS_RESERVED.test(segment),
      ) ||
      posix.normalize(value) !== value;
    if (invalid)
      context.addIssue({ code: "custom", message: "hostile or non-portable source path" });
  });
const hashSchema = z.string().regex(SHA256);
const idSchema = z.string().regex(ID);

const reviewReceiptSchema = z
  .object({
    id: z.string().min(1),
    evidencePath: sourcePathSchema,
    sourceCommit: z.string().regex(COMMIT),
  })
  .strict();
const ownershipSchema = z
  .object({
    sourcePin: z.string().regex(COMMIT),
    sourcePath: sourcePathSchema,
    normalizedHash: hashSchema,
    destination: sourcePathSchema,
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
        releaseAncestorCommit: z.string().regex(COMMIT),
        componentPath: sourcePathSchema,
        sourceHash: hashSchema,
        normalizedHash: hashSchema,
        license: z.literal("MIT"),
        reviewReceipt: reviewReceiptSchema,
      })
      .strict(),
    selections: z
      .object({
        baseline: z.tuple([z.literal("core"), z.literal("lang:typescript")]),
        activeSkills: z.array(idSchema).length(23),
        warmReserveSkills: z.array(idSchema),
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
        disabled: z.tuple([
          z.literal("ecc-memory-mcp"),
          z.literal("github"),
          z.literal("sequential-thinking"),
          z.literal("token-savior"),
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
    const active = new Set(profile.selections.activeSkills);
    if (
      new Set([...profile.selections.activeSkills, ...profile.selections.warmReserveSkills])
        .size !==
      active.size + profile.selections.warmReserveSkills.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["selections"],
        message: "active and warm-reserve skill sets overlap",
      });
    }
    if (new Set(profile.selections.activeSkills).size !== profile.selections.activeSkills.length) {
      context.addIssue({
        code: "custom",
        path: ["selections", "activeSkills"],
        message: "active skills must be unique",
      });
    }
    const destinations = profile.ownership.map((item) => item.destination);
    if (new Set(destinations).size !== destinations.length) {
      context.addIssue({
        code: "custom",
        path: ["ownership"],
        message: "ambiguous ownership destination",
      });
    }
    for (const [index, item] of profile.ownership.entries()) {
      if (item.sourcePin !== profile.source.commit) {
        context.addIssue({
          code: "custom",
          path: ["ownership", index, "sourcePin"],
          message: "ownership sourcePin contradicts profile source commit",
        });
      }
      if (
        item.sourcePath === profile.source.componentPath &&
        item.normalizedHash !== profile.source.normalizedHash
      ) {
        context.addIssue({
          code: "custom",
          path: ["ownership", index, "normalizedHash"],
          message: "ownership hash contradicts profile source hash",
        });
      }
    }
    if (profile.source.reviewReceipt.sourceCommit !== profile.source.commit) {
      context.addIssue({
        code: "custom",
        path: ["source", "reviewReceipt"],
        message: "review receipt contradicts profile source commit",
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

export const AIH_ECC_PROFILE_TEMPLATE = {
  version: 1,
  source: {
    repository: "affaan-m/ECC",
    commit: "0c1d7be9a750627fb2a6534c78a998cc46d03f9c",
    package: "ecc-universal",
    packageVersion: "2.1.0",
    releaseAncestorCommit: "4da6deac1888690e7fb8572d097ee23db630f7a0",
    componentPath: "manifests/install-components.json",
    sourceHash: "8eac72d3ab4eb41dc6feabadc7f80603999631186aeeb74b0e31019496054ed5",
    normalizedHash: "8eac72d3ab4eb41dc6feabadc7f80603999631186aeeb74b0e31019496054ed5",
    license: "MIT",
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
    disabled: ["ecc-memory-mcp", "github", "sequential-thinking", "token-savior"],
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
} as const;

const moduleSchema = z
  .object({
    id: idSchema,
    kind: z.string().min(1),
    paths: z.array(sourcePathSchema),
    dependencies: z.array(idSchema),
  })
  .passthrough();
const evidenceSchema = z
  .object({
    evidenceVersion: z.literal(1),
    source: z.object({
      repository: z.literal("affaan-m/ECC"),
      commit: z.string().regex(COMMIT),
      package: z.literal("ecc-universal"),
      packageVersion: z.string(),
      releaseAncestorCommit: z.string().regex(COMMIT),
      license: z.literal("MIT"),
      licensePath: sourcePathSchema,
      manifestHashes: z.record(sourcePathSchema, hashSchema),
    }),
    profilesManifest: z.object({
      version: z.literal(1),
      profiles: z.record(idSchema, z.object({ modules: z.array(idSchema) }).passthrough()),
    }),
    componentsManifest: z.object({
      version: z.literal(1),
      components: z.array(z.object({ id: idSchema, modules: z.array(idSchema) }).passthrough()),
    }),
    modulesManifest: z.object({ version: z.literal(1), modules: z.array(moduleSchema) }),
    agentPaths: z.array(sourcePathSchema),
    workflowPaths: z.array(sourcePathSchema),
  })
  .strict();
type PinnedEvidence = z.infer<typeof evidenceSchema>;

export interface ResolvedEntry {
  id: string;
  sourcePath: string;
  owner: "upstream" | "aih-adaptation";
}
export interface ResolvedSkill extends ResolvedEntry {
  selection: "baseline" | "leaf";
}
export interface ResolvedEccProfile {
  source: EccProfile["source"];
  modules: string[];
  skills: ResolvedSkill[];
  roles: ResolvedEntry[];
  workflows: ResolvedEntry[];
  consumedSourcePaths: string[];
}

function ordered(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function assertUniquePaths(groups: readonly (readonly string[])[]): void {
  const paths = groups.flatMap((group) => [...group]);
  if (new Set(paths).size !== paths.length)
    throw new Error("ambiguous duplicate source path in pinned evidence");
}

function containmentRoots(paths: readonly string[]): string[] {
  return ordered(
    new Set(
      paths.map((sourcePath) =>
        sourcePath.slice(0, sourcePath.indexOf("/") === -1 ? undefined : sourcePath.indexOf("/")),
      ),
    ),
  );
}

function resolveBase(profileInput: unknown, evidenceInput: unknown): ResolvedEccProfile {
  const profile = eccProfileSchema.parse(profileInput);
  const evidence: PinnedEvidence = evidenceSchema.parse(evidenceInput);
  if (
    evidence.source.repository !== profile.source.repository ||
    evidence.source.commit !== profile.source.commit ||
    evidence.source.package !== profile.source.package ||
    evidence.source.packageVersion !== profile.source.packageVersion ||
    evidence.source.releaseAncestorCommit !== profile.source.releaseAncestorCommit ||
    evidence.source.license !== profile.source.license
  )
    throw new Error("pinned evidence contradicts profile source metadata");
  if (profile.source.componentPath !== "manifests/install-components.json")
    throw new Error("componentPath contradicts pinned manifest evidence");
  const componentHash = evidence.source.manifestHashes[profile.source.componentPath];
  if (
    componentHash !== profile.source.sourceHash ||
    componentHash !== profile.source.normalizedHash
  ) {
    throw new Error("profile source hashes contradict pinned component manifest");
  }

  const modules = new Map(evidence.modulesManifest.modules.map((module) => [module.id, module]));
  if (modules.size !== evidence.modulesManifest.modules.length)
    throw new Error("duplicate module id in pinned evidence");
  const core = evidence.profilesManifest.profiles.core;
  const language = evidence.componentsManifest.components.find(
    (component) => component.id === "lang:typescript",
  );
  if (!core || !language)
    throw new Error("pinned manifests omit core or lang:typescript selection");
  const closure = new Set([...core.modules, ...language.modules]);
  for (const id of closure) {
    const module = modules.get(id);
    if (!module) throw new Error(`selected module is missing: ${id}`);
    for (const dependency of module.dependencies) closure.add(dependency);
  }
  const moduleIds = ordered(closure);
  const baselinePaths = ordered(
    new Set(
      moduleIds.flatMap((id) =>
        modules.get(id)?.kind === "skills" ? (modules.get(id)?.paths ?? []) : [],
      ),
    ),
  );
  if (baselinePaths.length !== 113)
    throw new Error(`baseline skill accounting expected 113, received ${baselinePaths.length}`);
  const leafPaths = profile.selections.activeSkills.map((id) => `skills/${id}`);
  const skillPaths = ordered(new Set([...baselinePaths, ...leafPaths]));
  if (skillPaths.length !== profile.expected.skills)
    throw new Error(
      `skill accounting expected ${profile.expected.skills}, received ${skillPaths.length}`,
    );
  if (evidence.agentPaths.length !== profile.expected.roles)
    throw new Error(
      `role accounting expected ${profile.expected.roles}, received ${evidence.agentPaths.length}`,
    );
  if (evidence.workflowPaths.length !== profile.expected.workflows)
    throw new Error(
      `workflow accounting expected ${profile.expected.workflows}, received ${evidence.workflowPaths.length}`,
    );
  assertUniquePaths([skillPaths, evidence.agentPaths, evidence.workflowPaths]);

  const adapted = new Set<string>(profile.aihAdaptedWorkflows);
  const skills = skillPaths.map((sourcePath) => ({
    id: posix.basename(sourcePath),
    sourcePath,
    owner: "upstream" as const,
    selection: leafPaths.includes(sourcePath) ? ("leaf" as const) : ("baseline" as const),
  }));
  const roles = ordered(evidence.agentPaths).map((sourcePath) => ({
    id: posix.basename(sourcePath, ".md"),
    sourcePath,
    owner: "upstream" as const,
  }));
  const workflows = ordered(evidence.workflowPaths).map((sourcePath) => {
    const id = `/${posix.basename(sourcePath, ".md")}`;
    return {
      id,
      sourcePath,
      owner: adapted.has(id) ? ("aih-adaptation" as const) : ("upstream" as const),
    };
  });
  const actualAdapted = workflows
    .filter((item) => item.owner === "aih-adaptation")
    .map((item) => item.id);
  if (actualAdapted.length !== profile.aihAdaptedWorkflows.length)
    throw new Error("adapted workflow is missing from pinned evidence");

  const manifestPaths = Object.keys(evidence.source.manifestHashes);
  const modulePaths = moduleIds.flatMap((id) => modules.get(id)?.paths ?? []);
  const consumedSourcePaths = ordered(
    new Set([
      evidence.source.licensePath,
      ...manifestPaths,
      ...modulePaths,
      ...skillPaths,
      ...evidence.agentPaths,
      ...evidence.workflowPaths,
    ]),
  );
  return {
    source: profile.source,
    modules: moduleIds,
    skills,
    roles,
    workflows,
    consumedSourcePaths,
  };
}

export function resolveEccProfile(profile: unknown, evidence: unknown): ResolvedEccProfile;
export function resolveEccProfile(
  profile: unknown,
  evidence: unknown,
  options: { sourceRoot: string },
): Promise<ResolvedEccProfile>;
export function resolveEccProfile(
  profile: unknown,
  evidence: unknown,
  options?: { sourceRoot: string },
): ResolvedEccProfile | Promise<ResolvedEccProfile> {
  const resolved = resolveBase(profile, evidence);
  if (!options) return resolved;
  return Promise.resolve().then(() => {
    hashComponentTree(options.sourceRoot, containmentRoots(resolved.consumedSourcePaths));
    return resolved;
  });
}

export function serializeResolvedEccProfile(profile: ResolvedEccProfile): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}
