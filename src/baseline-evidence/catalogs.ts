import { BASELINE_SOURCES } from "../internals/baseline-sources.js";
import {
  type BaselineCatalog,
  type BaselineCatalogComponent,
  defineBaselineCatalog,
} from "./catalog.js";
import eccModules from "./ecc-modules.json";
import eccProfiles from "./ecc-profiles.json";

const ECC_COMMON_AGENTS = [
  "code-reviewer",
  "code-architect",
  "architect",
  "planner",
  "tdd-guide",
  "build-error-resolver",
  "refactor-cleaner",
  "code-simplifier",
  "silent-failure-hunter",
  "pr-test-analyzer",
  "doc-updater",
  "docs-lookup",
  "code-explorer",
  "security-reviewer",
  "type-design-analyzer",
  "performance-optimizer",
] as const;

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

const ECC_NESTED_SKILL_MODULES = new Set([
  "agents-core",
  "platform-configs",
]);

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
      "scripts/lib/install-state.js",
      "scripts/lib/install-targets",
      "scripts/lib/cursor-agent-names.js",
      "scripts/lib/mcp-config.js",
      "scripts/lib/path-safety.js",
    ],
  },
  { id: "runtime:ecc-kiro", paths: [".kiro"], skillContent: true },
  ...ECC_SUPPORTED_MODULES.map((module) => ({
    id: `module:${module.id}`,
    paths: module.paths,
    ...(moduleContainsSkillContent(module) ? { skillContent: true as const } : {}),
  })),
  { id: "skill:tdd-workflow", paths: ["skills/tdd-workflow"], skillContent: true },
  {
    id: "skill:verification-loop",
    paths: ["skills/verification-loop"],
    skillContent: true,
  },
  { id: "skill:strategic-compact", paths: ["skills/strategic-compact"], skillContent: true },
  { id: "skill:coding-standards", paths: ["skills/coding-standards"], skillContent: true },
  ...ECC_COMMON_AGENTS.map((name) => ({
    id: `agent:${name}`,
    paths: [`agents/${name}.md`],
  })),
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
