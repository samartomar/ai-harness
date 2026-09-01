import { ECC_DECLARABLE_COMPONENT_IDS, ECC_EXPLICIT_MCP_COMPONENT_IDS } from "../ecc/components.js";
import { eccComponentSourcePaths } from "../ecc/materialize.js";
import { BASELINE_SOURCES } from "../internals/baseline-sources.js";
import {
  type BaselineCatalog,
  type BaselineCatalogComponent,
  defineBaselineCatalog,
} from "./catalog.js";
import eccModules from "./ecc-modules.json";
import eccProfiles from "./ecc-profiles.json";

const SUPERPOWERS_SKILLS = [
  "brainstorming",
  "dispatching-parallel-agents",
  "executing-plans",
  "finishing-a-development-branch",
  "receiving-code-review",
  "requesting-code-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "using-git-worktrees",
  "using-superpowers",
  "verification-before-completion",
  "writing-plans",
  "writing-skills",
] as const;

const ECC_NESTED_SKILL_MODULES = new Set(["agents-core", "platform-configs"]);

type EccModule = (typeof eccModules.modules)[number];

function supportedEccModules(): EccModule[] {
  const byId = new Map<string, EccModule>();
  for (const module of eccModules.modules) {
    if (byId.has(module.id)) throw new Error(`duplicate ECC module snapshot id ${module.id}`);
    byId.set(module.id, module);
  }
  const selected: EccModule[] = [];
  const seen = new Set<string>();
  for (const id of eccProfiles.profiles.full.modules) {
    if (seen.has(id)) throw new Error(`duplicate ECC full-profile module id ${id}`);
    seen.add(id);
    const module = byId.get(id);
    if (module === undefined) throw new Error(`ECC full profile references unknown module ${id}`);
    selected.push(module);
  }
  return selected;
}

const ECC_SUPPORTED_MODULES = supportedEccModules();

function moduleContainsSkillContent(module: { id: string; paths: readonly string[] }): boolean {
  return (
    ECC_NESTED_SKILL_MODULES.has(module.id) ||
    module.paths.some((path) => path.split("/").includes("skills"))
  );
}

const ECC_DECLARABLE_COMPONENTS: readonly BaselineCatalogComponent[] = [
  ...ECC_DECLARABLE_COMPONENT_IDS,
  ...ECC_EXPLICIT_MCP_COMPONENT_IDS,
].map((id) => {
  const paths = eccComponentSourcePaths(id);
  return {
    id,
    paths,
    ...(id === "baseline:platform" ||
    paths.some((path) => path.includes("/skills/") || path.startsWith("skills/"))
      ? { skillContent: true as const }
      : {}),
  };
});

/**
 * Individually selectable ECC Skills are baseline subjects too. The module
 * snapshot is the source-locked inventory used by the installer, so derive
 * the direct Skill subjects from those exact roots and retain the richer
 * explicit component definition when one already exists.
 */
function additionalEccSkillComponents(): BaselineCatalogComponent[] {
  const explicitIds = new Set(ECC_DECLARABLE_COMPONENTS.map((component) => component.id));
  const byId = new Map<string, BaselineCatalogComponent>();
  for (const module of eccModules.modules) {
    for (const path of module.paths) {
      const name = /^skills\/([a-z0-9][a-z0-9-]*)$/.exec(path)?.[1];
      if (name === undefined) continue;
      const id = `skill:${name}`;
      if (explicitIds.has(id)) continue;
      const existing = byId.get(id);
      if (existing !== undefined && existing.paths[0] !== path) {
        throw new Error(`ECC skill ${id} has conflicting source roots`);
      }
      byId.set(id, { id, paths: [path], skillContent: true });
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

const ECC_COMPONENTS: readonly BaselineCatalogComponent[] = [
  {
    id: "runtime:ecc-installer",
    paths: [
      "package.json",
      "package-lock.json",
      "manifests",
      "scripts/install-apply.js",
      "scripts/lib/install",
      "scripts/lib/install-manifests.js",
      "scripts/lib/install-executor.js",
      "scripts/lib/invocation-environment.js",
      "scripts/lib/install-state.js",
      "scripts/lib/install-targets",
      "scripts/lib/cursor-agent-names.js",
      "scripts/lib/mcp-config.js",
      "scripts/lib/opencode-paths.js",
      "scripts/lib/path-safety.js",
      "scripts/codex/merge-codex-config.js",
      "scripts/codex/merge-mcp-config.js",
      ".codex/AGENTS.md",
    ],
  },
  { id: "runtime:ecc-kiro", paths: [".kiro"], skillContent: true },
  ...ECC_SUPPORTED_MODULES.map((module) => ({
    id: `module:${module.id}`,
    paths: module.paths,
    ...(moduleContainsSkillContent(module) ? { skillContent: true as const } : {}),
  })),
  ...ECC_DECLARABLE_COMPONENTS,
  ...additionalEccSkillComponents(),
];

const SUPERPOWERS_COMPONENTS: readonly BaselineCatalogComponent[] = [
  {
    id: "runtime:superpowers-plugin",
    paths: [
      ".claude-plugin",
      ".codex-plugin",
      ".cursor-plugin",
      ".kimi-plugin",
      ".opencode",
      ".pi",
      "gemini-extension.json",
      "hooks",
      "package.json",
      "scripts",
    ],
  },
  ...SUPERPOWERS_SKILLS.map((name) => ({
    id: `skill:${name}`,
    paths: [`skills/${name}`],
    skillContent: true as const,
  })),
];

function sourcePin(owner: string, repo: string): string {
  for (const baseline of BASELINE_SOURCES) {
    const source = baseline.sources.find(
      (candidate) => candidate.owner === owner && candidate.repo === repo,
    );
    if (source) return source.pinnedSha;
  }
  throw new Error(`baseline source registry is missing ${owner}/${repo}`);
}

function catalog(
  id: string,
  owner: string,
  repo: string,
  components: readonly BaselineCatalogComponent[],
  pin?: string,
): BaselineCatalog {
  return defineBaselineCatalog({
    id,
    owner,
    repo,
    pinnedSha: pin ?? sourcePin(owner, repo),
    components,
  });
}

export const BASELINE_CATALOG_IDS = ["ecc", "superpowers"] as const;
export type BaselineCatalogId = (typeof BASELINE_CATALOG_IDS)[number];

export function baselineCatalogById(id: string, pin?: string): BaselineCatalog {
  if (id === "ecc") return catalog("ecc", "samartomar", "ECC", ECC_COMPONENTS, pin);
  if (id === "superpowers") {
    return catalog("superpowers", "obra", "Superpowers", SUPERPOWERS_COMPONENTS, pin);
  }
  throw new Error(
    `unknown baseline catalog ${JSON.stringify(id)}; expected ${BASELINE_CATALOG_IDS.join("|")}`,
  );
}
