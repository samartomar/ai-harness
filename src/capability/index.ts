import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

function parseExistingProjectManifest(root: string): void {
  const raw = readIfExists(join(root, AIH_CAPABILITIES_FILE));
  if (raw === undefined) return;
  try {
    ProjectCapabilitiesFileSchema.parse(JSON.parse(raw));
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

function projectManifest(report: CapabilityResolveReport): z.infer<
  typeof ProjectCapabilitiesFileSchema
> {
  return {
    schemaVersion: 1,
    requires: report.decisions.map((decision) => ({
      id: decision.name,
      install: decision.install,
      reason: decision.reason,
      evidence: decision.evidence,
    })),
  };
}

function upsertCache(
  cache: MachineCapabilityCache,
  ctx: PlanContext,
  manifest: z.infer<typeof ProjectCapabilitiesFileSchema>,
): MachineCapabilityCache {
  const rendered = jsonFile(manifest);
  const repoEntry = {
    root: ctx.root,
    manifestPath: AIH_CAPABILITIES_FILE,
    manifestSha256: sha256Hex(rendered),
    capabilities: manifest.requires.map((item) => item.id).sort((a, b) => a.localeCompare(b)),
  };
  return {
    schemaVersion: 1,
    repos: [
      ...cache.repos.filter((repo) => repo.root !== ctx.root),
      repoEntry,
    ].sort((a, b) => a.root.localeCompare(b.root)),
  };
}

function resolveText(report: CapabilityResolveReport): string {
  if (report.decisions.length === 0) {
    return lines("No capability gaps detected for this repo.");
  }
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
  parseExistingProjectManifest(ctx.root);
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const report: CapabilityResolveReport = {
    schemaVersion: 1,
    posture: ctx.posture ?? "vibe",
    decisions: resolveDecisions(ctx, stack),
  };
  const manifest = projectManifest(report);
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
} {
  const repos = cache.repos.filter((repo) => {
    if (!existsSync(repo.root)) return false;
    const raw = readIfExists(join(repo.root, repo.manifestPath));
    if (raw === undefined) return false;
    const result = ProjectCapabilitiesFileSchema.safeParse(JSON.parse(raw));
    return result.success;
  });
  return {
    cache: { schemaVersion: 1, repos },
    pruned: cache.repos.length - repos.length,
  };
}

function pruneText(pruned: number, remaining: number): string {
  if (pruned === 0) {
    return lines(
      `Machine capability cache is current — ${remaining} repo${remaining === 1 ? "" : "s"} retained.`,
    );
  }
  return lines(
    `pruned ${pruned} stale repo${pruned === 1 ? "" : "s"} from the derived machine capability cache`,
    `${remaining} repo${remaining === 1 ? "" : "s"} retained`,
  );
}

function capabilityPrunePlan(ctx: PlanContext): Plan {
  const cache = readMachineCapabilityCache(ctx);
  const { cache: next, pruned } = prunedCache(cache);
  const actions =
    pruned > 0
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
    digest("capability prune", pruneText(pruned, next.repos.length), { pruned, cache: next }),
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
