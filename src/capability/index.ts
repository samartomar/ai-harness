import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, parse } from "node:path";
import { z } from "zod";
import { AihError } from "../errors.js";
import { readIfExists } from "../internals/fsxn.js";
import {
  type CommandSpec,
  digest,
  type Plan,
  type PlanContext,
  plan,
  writeJson,
} from "../internals/plan.js";
import { jsonFile, lines } from "../internals/render.js";
import { type RepoStack, scanRepo } from "../profile/scan.js";

export const AIH_CAPABILITIES_FILE = "aih-capabilities.json";

const CapabilityIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);

const CapabilityInstallSchema = z.enum(["auto-add", "warn", "requires-approval"]);

const CapabilityEvidenceSchema = z
  .object({
    kind: z.enum(["catalog", "stack", "script", "posture"]),
    source: z.string().min(1),
    detail: z.string().min(1),
  })
  .strict();

const CapabilityRequirementSchema = z
  .object({
    id: CapabilityIdSchema,
    install: CapabilityInstallSchema,
    reason: z.string().min(1),
    evidence: z.array(CapabilityEvidenceSchema).min(1),
  })
  .strict();

const ProjectCapabilitiesFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    requires: z.array(CapabilityRequirementSchema),
  })
  .strict();

const MachineCapabilityRepoSchema = z
  .object({
    root: z.string().min(1),
    manifestPath: z.literal(AIH_CAPABILITIES_FILE),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    capabilities: z.array(CapabilityIdSchema),
  })
  .strict();

const MachineCapabilityCacheSchema = z
  .object({
    schemaVersion: z.literal(1),
    repos: z.array(MachineCapabilityRepoSchema),
  })
  .strict();

export type CapabilityEvidence = z.infer<typeof CapabilityEvidenceSchema>;
export type CapabilityInstall = z.infer<typeof CapabilityInstallSchema>;
export type CapabilityRequirement = z.infer<typeof CapabilityRequirementSchema>;
export type MachineCapabilityCache = z.infer<typeof MachineCapabilityCacheSchema>;
type ProjectCapabilitiesFile = z.infer<typeof ProjectCapabilitiesFileSchema>;
type MachineCapabilityRepo = MachineCapabilityCache["repos"][number];

interface CatalogCapability {
  id: string;
  class: "runtime" | "feature";
  version: string;
  engines: { aih: string };
  bin: string[];
  default: "on" | "opt-in";
  reason: string;
  contributes: {
    skills?: Array<{ name: string; source: { type: "reference"; label: string } }>;
    rules?: Array<{ name: string; source: { type: "reference"; label: string } }>;
  };
  gates?: string[];
}

export interface CapabilityDecision {
  name: string;
  install: CapabilityInstall;
  reason: string;
  evidence: CapabilityEvidence[];
}

interface CapabilityResolveReport {
  schemaVersion: 1;
  posture: string;
  decisions: CapabilityDecision[];
}

const COMMON_CATALOG: readonly CatalogCapability[] = [
  {
    id: "common.security-review",
    class: "feature",
    version: "1.0.0",
    engines: { aih: "^1.3.0" },
    bin: ["COMMON"],
    default: "on",
    reason: "COMMON default-on security review capability for every repo",
    contributes: {
      skills: [
        {
          name: "security-review",
          source: { type: "reference", label: "built-in COMMON catalog reference" },
        },
      ],
    },
    gates: ["security"],
  },
  {
    id: "common.tdd-workflow",
    class: "feature",
    version: "1.0.0",
    engines: { aih: "^1.3.0" },
    bin: ["COMMON"],
    default: "opt-in",
    reason: "Test framework detected, so the repo can use the COMMON TDD workflow",
    contributes: {
      skills: [
        {
          name: "tdd-workflow",
          source: { type: "reference", label: "built-in COMMON catalog reference" },
        },
      ],
    },
    gates: ["test"],
  },
  {
    id: "stack.node-typescript",
    class: "feature",
    version: "1.0.0",
    engines: { aih: "^1.3.0" },
    bin: ["STACK:node-ts"],
    default: "on",
    reason: "TypeScript/Node.js stack detected",
    contributes: {
      rules: [
        {
          name: "typescript-node",
          source: { type: "reference", label: "repo stack catalog reference" },
        },
      ],
    },
    gates: ["typecheck", "test"],
  },
] as const;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const INSTALL_RANK: Record<CapabilityInstall, number> = {
  "auto-add": 0,
  warn: 1,
  "requires-approval": 2,
};

function strictestInstall(a: CapabilityInstall, b: CapabilityInstall): CapabilityInstall {
  return INSTALL_RANK[a] >= INSTALL_RANK[b] ? a : b;
}

function requireHome(ctx: PlanContext): string {
  const home = ctx.env.USERPROFILE || ctx.env.HOME;
  if (typeof home !== "string" || home.trim().length === 0) {
    throw new AihError(
      "cannot resolve machine capability cache path — HOME/USERPROFILE is not set",
      "AIH_CONFIG",
    );
  }
  return home;
}

export function machineCapabilityCachePath(ctx: PlanContext): string {
  return join(requireHome(ctx), ".aih", "capabilities", "cache.json");
}

function parseExistingProjectManifest(root: string): ProjectCapabilitiesFile | undefined {
  const raw = readIfExists(join(root, AIH_CAPABILITIES_FILE));
  if (raw === undefined) return undefined;
  try {
    return ProjectCapabilitiesFileSchema.parse(JSON.parse(raw));
  } catch {
    throw new AihError(
      `${AIH_CAPABILITIES_FILE} contains entries aih cannot parse — fix it by hand first (rewriting it would destroy what is there)`,
      "AIH_CONFIG",
    );
  }
}

function readMachineCapabilityCache(ctx: PlanContext): MachineCapabilityCache {
  const path = machineCapabilityCachePath(ctx);
  const raw = readIfExists(path);
  if (raw === undefined) return { schemaVersion: 1, repos: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AihError(
      "machine capability cache is not valid JSON — delete ~/.aih/capabilities/cache.json or rebuild it with `aih capability resolve --apply`",
      "AIH_CONFIG",
    );
  }
  const result = MachineCapabilityCacheSchema.safeParse(parsed);
  if (!result.success) {
    throw new AihError(
      "machine capability cache has an unsupported shape — delete ~/.aih/capabilities/cache.json or rebuild it with `aih capability resolve --apply`",
      "AIH_CONFIG",
    );
  }
  return result.data;
}

function installForPosture(ctx: PlanContext): CapabilityInstall {
  if (ctx.posture === "enterprise") return "requires-approval";
  if (ctx.posture === "team") return "warn";
  return "auto-add";
}

function catalogEvidence(capability: CatalogCapability): CapabilityEvidence {
  return {
    kind: "catalog",
    source: capability.id,
    detail: `${capability.bin.join(", ")} ${capability.default} catalog capability`,
  };
}

function stackEvidence(source: string, detail: string): CapabilityEvidence {
  return { kind: "stack", source, detail };
}

function scriptEvidence(source: string, detail: string): CapabilityEvidence {
  return { kind: "script", source, detail };
}

function decision(
  ctx: PlanContext,
  capability: CatalogCapability,
  evidence: CapabilityEvidence[],
): CapabilityDecision {
  return {
    name: capability.id,
    install: installForPosture(ctx),
    reason: capability.reason,
    evidence,
  };
}

function resolveDecisions(ctx: PlanContext, stack: RepoStack): CapabilityDecision[] {
  const byId = new Map(COMMON_CATALOG.map((capability) => [capability.id, capability]));
  const decisions: CapabilityDecision[] = [];

  const security = byId.get("common.security-review");
  if (security) decisions.push(decision(ctx, security, [catalogEvidence(security)]));

  const tdd = byId.get("common.tdd-workflow");
  if (tdd && stack.testRunner !== undefined) {
    decisions.push(
      decision(ctx, tdd, [
        catalogEvidence(tdd),
        scriptEvidence("profile.scanRepo.testRunner", stack.testRunner),
      ]),
    );
  }

  const nodeTs = byId.get("stack.node-typescript");
  if (nodeTs && stack.languages.includes("TypeScript/Node.js")) {
    decisions.push(
      decision(ctx, nodeTs, [
        catalogEvidence(nodeTs),
        stackEvidence("profile.scanRepo.languages", "TypeScript/Node.js"),
      ]),
    );
  }

  return decisions.sort((a, b) => a.name.localeCompare(b.name));
}

function requirementFromDecision(decision: CapabilityDecision): CapabilityRequirement {
  return {
    id: decision.name,
    install: decision.install,
    reason: decision.reason,
    evidence: decision.evidence,
  };
}

function decisionFromRequirement(requirement: CapabilityRequirement): CapabilityDecision {
  return {
    name: requirement.id,
    install: requirement.install,
    reason: requirement.reason,
    evidence: requirement.evidence,
  };
}

function mergedProjectManifest(
  existing: ProjectCapabilitiesFile | undefined,
  decisions: CapabilityDecision[],
): ProjectCapabilitiesFile {
  const byId = new Map<string, CapabilityRequirement>();
  for (const requirement of existing?.requires ?? []) {
    byId.set(requirement.id, requirement);
  }
  for (const decision of decisions) {
    const next = requirementFromDecision(decision);
    const current = byId.get(next.id);
    byId.set(
      next.id,
      current === undefined
        ? next
        : { ...next, install: strictestInstall(current.install, next.install) },
    );
  }
  return {
    schemaVersion: 1,
    requires: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function projectReport(
  ctx: PlanContext,
  manifest: ProjectCapabilitiesFile,
): CapabilityResolveReport {
  return {
    schemaVersion: 1,
    posture: ctx.posture ?? "vibe",
    decisions: manifest.requires.map(decisionFromRequirement),
  };
}

function cacheEntryFor(root: string, manifest: ProjectCapabilitiesFile): MachineCapabilityRepo {
  const rendered = jsonFile(manifest);
  return {
    root,
    manifestPath: AIH_CAPABILITIES_FILE,
    manifestSha256: sha256Hex(rendered),
    capabilities: manifest.requires.map((item) => item.id).sort((a, b) => a.localeCompare(b)),
  };
}

function sameCacheEntry(a: MachineCapabilityRepo, b: MachineCapabilityRepo): boolean {
  return (
    a.root === b.root &&
    a.manifestPath === b.manifestPath &&
    a.manifestSha256 === b.manifestSha256 &&
    a.capabilities.length === b.capabilities.length &&
    a.capabilities.every((capability, index) => capability === b.capabilities[index])
  );
}

function isSafeLocalCacheRoot(root: string): boolean {
  if (root.length === 0 || root.trim() !== root) return false;
  if ([...root].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(root)) return false;
  if (root.replaceAll("\\", "/").startsWith("//")) return false;
  if (!isAbsolute(root)) return false;
  if (process.platform === "win32") {
    const parsed = parse(root);
    if (parsed.root === "\\" || parsed.root === "/") return false;
  }
  return true;
}

function upsertCache(
  cache: MachineCapabilityCache,
  ctx: PlanContext,
  manifest: ProjectCapabilitiesFile,
): MachineCapabilityCache {
  const repoEntry = cacheEntryFor(ctx.root, manifest);
  return {
    schemaVersion: 1,
    repos: [
      ...cache.repos.filter((repo) => repo.root !== ctx.root && isSafeLocalCacheRoot(repo.root)),
      repoEntry,
    ].sort((a, b) => a.root.localeCompare(b.root)),
  };
}

function resolveText(report: CapabilityResolveReport): string {
  return lines(
    `posture: ${report.posture}`,
    ...report.decisions.map(
      (decision) =>
        `  - ${decision.name} [${decision.install}] — ${decision.reason}; evidence: ${decision.evidence
          .map((item) => item.detail)
          .join(" | ")}`,
    ),
    "",
    `Repo intent: ${AIH_CAPABILITIES_FILE}`,
    "Machine cache: ~/.aih/capabilities/cache.json (derived; safe to delete and rebuild)",
  );
}

function capabilityResolvePlan(ctx: PlanContext): Plan {
  const existing = parseExistingProjectManifest(ctx.root);
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const manifest = mergedProjectManifest(existing, resolveDecisions(ctx, stack));
  const report = projectReport(ctx, manifest);
  const cache = upsertCache(readMachineCapabilityCache(ctx), ctx, manifest);
  return plan(
    "capability resolve",
    writeJson(AIH_CAPABILITIES_FILE, manifest, "persist repo capability requirements"),
    writeJson(machineCapabilityCachePath(ctx), cache, "update derived machine capability cache", {
      external: true,
    }),
    digest("capability resolve", resolveText(report), report),
  );
}

function prunedCache(cache: MachineCapabilityCache): {
  cache: MachineCapabilityCache;
  pruned: number;
  refreshed: number;
} {
  const repos: MachineCapabilityRepo[] = [];
  let pruned = 0;
  let refreshed = 0;
  for (const repo of cache.repos) {
    if (!isSafeLocalCacheRoot(repo.root) || !existsSync(repo.root)) {
      pruned += 1;
      continue;
    }
    const raw = readIfExists(join(repo.root, repo.manifestPath));
    if (raw === undefined) {
      pruned += 1;
      continue;
    }
    try {
      const result = ProjectCapabilitiesFileSchema.safeParse(JSON.parse(raw));
      if (!result.success) {
        pruned += 1;
        continue;
      }
      const next = cacheEntryFor(repo.root, result.data);
      if (!sameCacheEntry(next, repo)) {
        refreshed += 1;
      }
      repos.push(next);
    } catch {
      pruned += 1;
    }
  }
  return {
    cache: { schemaVersion: 1, repos: repos.sort((a, b) => a.root.localeCompare(b.root)) },
    pruned,
    refreshed,
  };
}

function pruneText(pruned: number, refreshed: number, remaining: number): string {
  if (pruned === 0 && refreshed === 0) {
    return lines(
      `Machine capability cache is current — ${remaining} repo${remaining === 1 ? "" : "s"} retained.`,
    );
  }
  return lines(
    `pruned ${pruned} stale repo${pruned === 1 ? "" : "s"} from the derived machine capability cache`,
    `refreshed ${refreshed} repo${refreshed === 1 ? "" : "s"} from committed manifests`,
    `${remaining} repo${remaining === 1 ? "" : "s"} retained`,
  );
}

function capabilityPrunePlan(ctx: PlanContext): Plan {
  const cache = readMachineCapabilityCache(ctx);
  const { cache: next, pruned, refreshed } = prunedCache(cache);
  const actions =
    pruned > 0 || refreshed > 0
      ? [
          writeJson(
            machineCapabilityCachePath(ctx),
            next,
            "prune stale repos from derived machine capability cache",
            { external: true },
          ),
        ]
      : [];
  return plan(
    "capability prune",
    ...actions,
    digest("capability prune", pruneText(pruned, refreshed, next.repos.length), {
      pruned,
      refreshed,
      cache: next,
    }),
  );
}

export const capabilityResolveCommand: CommandSpec = {
  name: "resolve",
  summary:
    "Resolve repo capability needs and update the derived ~/.aih machine cache (--apply writes)",
  plan: capabilityResolvePlan,
};

export const capabilityPruneCommand: CommandSpec = {
  name: "prune",
  summary: "Prune stale repo entries from the derived ~/.aih machine capability cache",
  plan: capabilityPrunePlan,
};
