import {
  ECC_DECLARABLE_COMPONENT_IDS,
  ECC_EXPLICIT_MCP_COMPONENT_IDS,
  type EccComponentId,
} from "../../ecc/components.js";
import { eccComponentSourcePaths } from "../../ecc/materialize.js";
import { BASELINE_SOURCES } from "../../internals/baseline-sources.js";
import {
  type BaselineCatalog,
  type BaselineCatalogComponent,
  defineBaselineCatalog,
} from "../catalog.js";
import eccModules from "../ecc-modules.json";
import eccProfiles from "../ecc-profiles.json";

const ECC_NESTED_SKILL_MODULES = new Set(["agents-core", "platform-configs"]);
type EccModule = (typeof eccModules.modules)[number];
function supportedModules(): EccModule[] {
  const byId = new Map(eccModules.modules.map((module) => [module.id, module]));
  if (byId.size !== eccModules.modules.length) throw new Error("duplicate ECC module snapshot id");
  const seen = new Set<string>();
  return eccProfiles.profiles.full.modules.map((id) => {
    if (seen.has(id)) throw new Error(`duplicate ECC full-profile module id ${id}`);
    seen.add(id);
    const module = byId.get(id);
    if (!module) throw new Error(`ECC full profile references unknown module ${id}`);
    return module;
  });
}
function skillContent(module: { id: string; paths: readonly string[] }): boolean {
  return (
    ECC_NESTED_SKILL_MODULES.has(module.id) ||
    module.paths.some((path) => path.split("/").includes("skills"))
  );
}
const declarable: readonly BaselineCatalogComponent[] = [
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
function extraSkills(): BaselineCatalogComponent[] {
  const explicit = new Set(declarable.map((component) => component.id));
  const byId = new Map<string, BaselineCatalogComponent>();
  for (const module of eccModules.modules)
    for (const path of module.paths) {
      const name = /^skills\/([a-z0-9][a-z0-9-]*)$/.exec(path)?.[1];
      if (!name) continue;
      const id: EccComponentId = `skill:${name}`;
      if (explicit.has(id)) continue;
      const paths = eccComponentSourcePaths(id);
      const existing = byId.get(id);
      if (existing && JSON.stringify(existing.paths) !== JSON.stringify(paths))
        throw new Error(`ECC skill ${id} has conflicting source roots`);
      byId.set(id, { id, paths, skillContent: true });
    }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}
const components: readonly BaselineCatalogComponent[] = [
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
  ...supportedModules().map((module) => ({
    id: `module:${module.id}`,
    paths: module.paths,
    ...(skillContent(module) ? { skillContent: true as const } : {}),
  })),
  ...declarable,
  ...extraSkills(),
];
function sourcePin(): string {
  for (const baseline of BASELINE_SOURCES) {
    const source = baseline.sources.find(
      (candidate) => candidate.owner === "affaan-m" && candidate.repo === "ECC",
    );
    if (source) return source.pinnedSha;
  }
  throw new Error("baseline source registry is missing affaan-m/ECC");
}
/** Source-local normalized ECC baseline input. */
export function eccBaselineCatalogV1(pin?: string): BaselineCatalog {
  return defineBaselineCatalog({
    id: "ecc",
    owner: "affaan-m",
    repo: "ECC",
    pinnedSha: pin ?? sourcePin(),
    components,
  });
}
