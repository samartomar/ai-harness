import { isAbsolute, relative, resolve } from "node:path";
import eccModules from "../baseline-evidence/ecc-modules.json";
import type { EccComponentId, EccComponentSelection, EccMcpComponentId } from "./components.js";

export interface EccComponentInstallDescriptor {
  evidenceComponentId: string;
  containingModuleId: string;
  wholeModules?: readonly string[];
  skills?: readonly string[];
  agents?: readonly string[];
  sourceRoots?: readonly string[];
  agentScaffolding?: boolean;
}

export interface EccManifestOperation {
  kind: string;
  moduleId: string;
  sourceRelativePath: string;
  destinationPath: string;
}

export interface EccManifestPlan<Operation extends EccManifestOperation = EccManifestOperation> {
  operations: Operation[];
  statePreview: { operations: Operation[] };
}

export interface EccMaterializationSpec {
  scope: "scoped" | "full";
  moduleIds: string[];
  wholeModules: string[];
  skills: string[];
  agents: string[];
  sourceRoots: string[];
  agentScaffolding: boolean;
  /**
   * Governance leaves ECC's agents, skills, rules, and commands intact, but
   * AIH is the sole owner of MCP and host-hook/runtime configuration. The
   * verified upstream materializer receives this explicit operation filter.
   */
  excludeAihOwnedSurfaces?: boolean;
}

const MODULE_PATHS = new Map(
  eccModules.modules.map((module) => [module.id, module.paths] as const),
);

const WHOLE_MODULE_COMPONENTS: Readonly<Record<string, string>> = {
  "baseline:rules": "rules-core",
  "baseline:commands": "commands-core",
  "baseline:hooks": "hooks-runtime",
  "baseline:platform": "platform-configs",
  "baseline:workflow": "workflow-quality",
  "capability:database": "database",
  "capability:security": "security",
  "capability:research": "research-apis",
  "capability:content": "business-content",
  "capability:operators": "operator-workflows",
  "capability:optimization": "optimization-workflows",
  "capability:prediction-markets": "prediction-market-skills",
  "capability:social": "social-distribution",
  "capability:media": "media-generation",
  "capability:orchestration": "orchestration",
  "capability:agentic": "agentic-patterns",
  "capability:devops": "devops-infra",
  "capability:machine-learning": "machine-learning",
  "capability:supply-chain": "supply-chain-domain",
  "capability:documents": "document-processing",
};

const LANGUAGE_SKILLS: Readonly<Record<string, readonly string[]>> = {
  "lang:typescript": ["api-design", "backend-patterns", "frontend-patterns", "nestjs-patterns"],
  "lang:python": ["python-patterns", "python-testing"],
  "lang:go": ["golang-patterns", "golang-testing"],
  "lang:java": ["java-coding-standards"],
  "lang:cpp": ["cpp-coding-standards", "cpp-testing"],
  "lang:c": ["cpp-coding-standards", "cpp-testing"],
  "lang:kotlin": [
    "kotlin-coroutines-flows",
    "kotlin-exposed-patterns",
    "kotlin-ktor-patterns",
    "kotlin-patterns",
    "kotlin-testing",
  ],
  "lang:arkts": [],
  "lang:perl": ["perl-patterns", "perl-testing"],
  "lang:ruby": [],
  "lang:rust": ["rust-patterns", "rust-testing"],
  "lang:csharp": ["csharp-testing", "dotnet-patterns"],
  "lang:fsharp": ["fsharp-testing", "dotnet-patterns"],
  "lang:php": [],
  "lang:swift": [
    "foundation-models-on-device",
    "liquid-glass-design",
    "swift-actor-persistence",
    "swift-concurrency-6-2",
    "swift-protocol-di-testing",
    "swiftui-patterns",
    "ios-icon-gen",
  ],
};

const LANGUAGE_RULES: Readonly<Record<string, readonly string[]>> = {
  "lang:typescript": ["rules/typescript"],
  "lang:python": ["rules/python"],
  "lang:go": ["rules/golang"],
  "lang:java": ["rules/java"],
  "lang:cpp": ["rules/cpp"],
  "lang:c": ["rules/cpp"],
  "lang:kotlin": ["rules/kotlin"],
  "lang:arkts": ["rules/arkts"],
  "lang:perl": ["rules/perl"],
  "lang:ruby": ["rules/ruby"],
  "lang:rust": ["rules/rust"],
  "lang:csharp": ["rules/csharp"],
  "lang:fsharp": ["rules/fsharp"],
  "lang:php": ["rules/php"],
};

const FRAMEWORK_SKILLS: Readonly<Record<string, readonly string[]>> = {
  "framework:angular": ["angular-developer", "frontend-patterns"],
  "framework:react": ["frontend-patterns", "react-patterns", "react-performance", "react-testing"],
  "framework:nextjs": [
    "frontend-patterns",
    "nextjs-turbopack",
    "react-patterns",
    "react-performance",
    "react-testing",
  ],
  "framework:vue": ["frontend-patterns", "ui-to-vue", "vue-patterns"],
  "framework:nuxt": ["frontend-patterns", "ui-to-vue", "vue-patterns"],
  "framework:svelte": ["frontend-patterns"],
  "framework:django": ["django-patterns", "django-tdd", "django-verification"],
  "framework:springboot": ["springboot-patterns", "springboot-tdd", "springboot-verification"],
  "framework:quarkus": ["quarkus-patterns", "quarkus-tdd", "quarkus-verification"],
  "framework:rails": [],
  "framework:laravel": [
    "laravel-plugin-discovery",
    "laravel-patterns",
    "laravel-tdd",
    "laravel-verification",
  ],
};

const FRAMEWORK_RULES: Readonly<Record<string, readonly string[]>> = {
  "framework:angular": ["rules/angular"],
  "framework:react": ["rules/react", "rules/web"],
  "framework:nextjs": ["rules/react", "rules/web"],
  "framework:vue": ["rules/vue", "rules/web"],
  "framework:nuxt": ["rules/nuxt", "rules/vue", "rules/web"],
  "framework:svelte": ["rules/web"],
  "framework:django": ["rules/python"],
  "framework:springboot": ["rules/java"],
  "framework:quarkus": ["rules/java"],
  "framework:rails": ["rules/ruby"],
  "framework:laravel": ["rules/php"],
};

const SKILL_MODULES: Readonly<Record<string, string>> = {
  "tdd-workflow": "workflow-quality",
  "verification-loop": "workflow-quality",
  "strategic-compact": "workflow-quality",
  "continuous-learning": "workflow-quality",
  "eval-harness": "workflow-quality",
  "windows-desktop-e2e": "workflow-quality",
  "coding-standards": "framework-language",
  "frontend-patterns": "framework-language",
  "backend-patterns": "framework-language",
  "security-review": "security",
  "deep-research": "research-apis",
  "mle-workflow": "machine-learning",
};

/** Skills that have a second, source-controlled `.agents/skills` copy at the v2.1.0 pin. */
const AGENT_SKILL_COPIES = new Set([
  "agent-introspection-debugging",
  "agent-sort",
  "api-design",
  "article-writing",
  "backend-patterns",
  "benchmark-methodology",
  "brand-discovery",
  "brand-voice",
  "bun-runtime",
  "coding-standards",
  "competitive-platform-analysis",
  "competitive-report-structure",
  "content-engine",
  "crosspost",
  "deep-research",
  "dmux-workflows",
  "documentation-lookup",
  "e2e-testing",
  "eval-harness",
  "everything-claude-code",
  "exa-search",
  "fal-ai-media",
  "frontend-patterns",
  "frontend-slides",
  "investor-materials",
  "investor-outreach",
  "market-research",
  "mcp-server-patterns",
  "mle-workflow",
  "nextjs-turbopack",
  "plan-canvas",
  "product-capability",
  "security-review",
  "strategic-compact",
  "tdd-workflow",
  "unified-memory",
  "verification-loop",
  "video-editing",
  "x-api",
]);

function leafName(componentId: string, family: string): string | undefined {
  const prefix = `${family}:`;
  return componentId.startsWith(prefix) ? componentId.slice(prefix.length) : undefined;
}

export function eccComponentInstallDescriptor(
  componentId: EccComponentId | EccMcpComponentId,
): EccComponentInstallDescriptor {
  if (componentId === "baseline:rules") {
    return {
      evidenceComponentId: componentId,
      containingModuleId: "rules-core",
      sourceRoots: ["rules/README.md", "rules/common"],
    };
  }
  const wholeModule = WHOLE_MODULE_COMPONENTS[componentId];
  if (wholeModule !== undefined) {
    return {
      evidenceComponentId: componentId,
      containingModuleId: wholeModule,
      wholeModules: [wholeModule],
    };
  }
  if (componentId === "baseline:agents") {
    return {
      evidenceComponentId: componentId,
      containingModuleId: "agents-core",
      sourceRoots: ["AGENTS.md", ".agents/plugins/marketplace.json"],
      agentScaffolding: true,
    };
  }
  if (componentId.startsWith("mcp:")) {
    return {
      evidenceComponentId: "module:platform-configs",
      containingModuleId: "platform-configs",
    };
  }
  const agent = leafName(componentId, "agent");
  if (agent !== undefined) {
    return {
      evidenceComponentId: componentId,
      containingModuleId: "agents-core",
      agents: [agent],
    };
  }
  const skill = leafName(componentId, "skill");
  if (skill !== undefined) {
    const moduleId = SKILL_MODULES[skill];
    if (moduleId === undefined) throw new Error(`no ECC install descriptor for ${componentId}`);
    return {
      evidenceComponentId: componentId,
      containingModuleId: moduleId,
      skills: [skill],
    };
  }
  const languageSkills = LANGUAGE_SKILLS[componentId];
  if (languageSkills !== undefined) {
    const moduleId = componentId === "lang:swift" ? "swift-apple" : "framework-language";
    return {
      evidenceComponentId: componentId,
      containingModuleId: moduleId,
      skills: languageSkills,
      sourceRoots: LANGUAGE_RULES[componentId] ?? [],
    };
  }
  const frameworkSkills = FRAMEWORK_SKILLS[componentId];
  if (frameworkSkills !== undefined) {
    return {
      evidenceComponentId: componentId,
      containingModuleId: "framework-language",
      skills: frameworkSkills,
      sourceRoots: FRAMEWORK_RULES[componentId] ?? [],
    };
  }
  throw new Error(`no ECC install descriptor for ${componentId}`);
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function operationIdentity(operation: EccManifestOperation): string {
  return [
    operation.kind,
    operation.moduleId,
    normalizedPath(operation.sourceRelativePath),
    normalizedPath(operation.destinationPath),
  ].join("\0");
}

function assertPlanShape<Operation extends EccManifestOperation>(
  plan: EccManifestPlan<Operation>,
): void {
  if (!Array.isArray(plan.operations) || !Array.isArray(plan.statePreview?.operations)) {
    throw new Error("invalid ECC manifest plan operation arrays");
  }
  if (
    plan.operations.length !== plan.statePreview.operations.length ||
    plan.operations.some((operation, index) => {
      const preview = plan.statePreview.operations[index];
      return preview === undefined || operationIdentity(operation) !== operationIdentity(preview);
    })
  ) {
    throw new Error("ECC manifest operation/state preview drift");
  }
  for (const operation of plan.operations) {
    if (operation.kind !== "copy-file" && operation.kind !== "merge-json") {
      throw new Error(`unsupported ECC manifest operation kind: ${operation.kind}`);
    }
    if (
      typeof operation.moduleId !== "string" ||
      typeof operation.sourceRelativePath !== "string" ||
      typeof operation.destinationPath !== "string"
    ) {
      throw new Error("invalid ECC manifest operation shape");
    }
  }
}

function selectedInstallSurface(selection: EccComponentSelection): {
  wholeModules: Set<string>;
  skills: Set<string>;
  agents: Set<string>;
  sourceRoots: Set<string>;
  agentScaffolding: boolean;
} {
  const wholeModules = new Set<string>();
  const skills = new Set<string>();
  const agents = new Set<string>();
  const sourceRoots = new Set<string>();
  let agentScaffolding = false;
  for (const moduleId of selection.moduleIds ?? []) wholeModules.add(moduleId);
  for (const componentId of [...selection.components, ...selection.mcps]) {
    const descriptor = eccComponentInstallDescriptor(componentId);
    for (const moduleId of descriptor.wholeModules ?? []) wholeModules.add(moduleId);
    for (const skill of descriptor.skills ?? []) skills.add(skill);
    for (const agent of descriptor.agents ?? []) agents.add(agent);
    for (const sourceRoot of descriptor.sourceRoots ?? []) sourceRoots.add(sourceRoot);
    if (descriptor.agentScaffolding === true) agentScaffolding = true;
  }
  return { wholeModules, skills, agents, sourceRoots, agentScaffolding };
}

export function eccMaterializationSpec(selection: EccComponentSelection): EccMaterializationSpec {
  const surface = selectedInstallSurface(selection);
  const moduleIds: string[] = [];
  const seen = new Set<string>();
  for (const moduleId of selection.moduleIds ?? []) {
    if (seen.has(moduleId)) continue;
    seen.add(moduleId);
    moduleIds.push(moduleId);
  }
  for (const componentId of [...selection.components, ...selection.mcps]) {
    const moduleId = eccComponentInstallDescriptor(componentId).containingModuleId;
    if (seen.has(moduleId)) continue;
    seen.add(moduleId);
    moduleIds.push(moduleId);
  }
  return {
    scope: selection.scope,
    moduleIds,
    wholeModules: [...surface.wholeModules],
    skills: [...surface.skills],
    agents: [...surface.agents],
    sourceRoots: [...surface.sourceRoots],
    agentScaffolding: surface.agentScaffolding,
  };
}

function selectedOperation(
  operation: EccManifestOperation,
  surface: ReturnType<typeof selectedInstallSurface>,
): boolean {
  if (surface.wholeModules.has(operation.moduleId)) return true;
  const source = normalizedPath(operation.sourceRelativePath);
  if ([...surface.sourceRoots].some((root) => source === root || source.startsWith(`${root}/`))) {
    return true;
  }
  if (
    surface.agentScaffolding &&
    (source === "AGENTS.md" || source === ".agents/plugins/marketplace.json")
  ) {
    return true;
  }
  const agent = /^agents\/([^/]+)\.md$/.exec(source)?.[1];
  if (agent !== undefined && surface.agents.has(agent)) return true;
  const skill = /^(?:skills|\.agents\/skills)\/([^/]+)\//.exec(source)?.[1];
  return skill !== undefined && surface.skills.has(skill);
}

export function eccComponentSourcePaths(componentId: EccComponentId | EccMcpComponentId): string[] {
  const descriptor = eccComponentInstallDescriptor(componentId);
  const paths = new Set<string>(descriptor.sourceRoots ?? []);
  for (const moduleId of descriptor.wholeModules ?? []) {
    const modulePaths = MODULE_PATHS.get(moduleId);
    if (modulePaths === undefined)
      throw new Error(`pinned ECC module snapshot is missing ${moduleId}`);
    for (const path of modulePaths) paths.add(path);
  }
  for (const skill of descriptor.skills ?? []) {
    paths.add(`skills/${skill}`);
    if (AGENT_SKILL_COPIES.has(skill)) paths.add(`.agents/skills/${skill}`);
  }
  for (const agent of descriptor.agents ?? []) paths.add(`agents/${agent}.md`);
  if (componentId.startsWith("mcp:")) {
    paths.add(".mcp.json");
    paths.add("mcp-configs/mcp-servers.json");
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

export function eccManifestOperationSelected(
  operation: EccManifestOperation,
  selection: EccComponentSelection,
): boolean {
  if (selection.scope === "full") return true;
  return selectedOperation(operation, selectedInstallSurface(selection));
}

export function filterEccManifestPlan<Operation extends EccManifestOperation>(
  plan: EccManifestPlan<Operation>,
  selection: EccComponentSelection,
): void {
  assertPlanShape(plan);
  if (selection.scope === "full") return;
  const operations = plan.operations.filter((operation) =>
    eccManifestOperationSelected(operation, selection),
  );
  plan.operations = operations;
  plan.statePreview.operations = operations;
}

export type GovernedEccOperationClass = "ecc-content" | "mcp" | "host-runtime";

/** Runtime roots used to bind a verified upstream destination to this install. */
export interface GovernedEccDestinationRoots {
  projectRoot: string;
  homeDir: string;
  target: string;
}

function assertSourceRelativePath(value: string): string {
  const normalized = normalizedPath(value);
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.startsWith("./") ||
    normalized
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe ECC source path: ${value}`);
  }
  return normalized;
}

function assertDestinationPath(value: string): string {
  const normalized = normalizedPath(value);
  const windowsAbsolute = /^[a-z]:\//i.test(normalized);
  const posixAbsolute = normalized.startsWith("/") && !normalized.startsWith("//");
  const body = windowsAbsolute ? normalized.slice(3) : posixAbsolute ? normalized.slice(1) : "";
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    (!windowsAbsolute && !posixAbsolute) ||
    body.length === 0 ||
    body.startsWith("./") ||
    body.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe ECC destination path: ${value}`);
  }
  return normalized;
}

function isMcpPath(path: string): boolean {
  return (
    /(?:^|\/)(?:\.mcp\.json|mcp\.json|mcp-servers\.json)$/i.test(path) ||
    /^(?:mcp-configs|mcp)(?:\/|$)/i.test(path)
  );
}

function isHostRuntimePath(path: string): boolean {
  return (
    /(?:^|\/)(?:\.claude|\.codex|\.cursor|\.kiro|\.gemini|\.opencode|\.zed)\/(?:hooks(?:\/|$)|(?:settings(?:\.local)?\.json|config\.(?:json|toml)))$/i.test(
      path,
    ) || /^(?:hooks|scripts\/hooks)(?:\/|$)/i.test(path)
  );
}

function isEccContentPath(path: string): boolean {
  return (
    path === "AGENTS.md" ||
    /^(?:\.agents\/(?:plugins|skills)\/|agents\/|skills\/|commands\/|rules\/|\.claude\/commands\/|\.codex\/AGENTS\.md$)/.test(
      path,
    )
  );
}

function containedRelative(root: string, destination: string): string | undefined {
  const inside = relative(resolve(root), resolve(destination));
  if (
    inside === "" ||
    inside === ".." ||
    inside.startsWith("../") ||
    inside.startsWith("..\\") ||
    isAbsolute(inside)
  ) {
    return undefined;
  }
  const normalized = normalizedPath(inside);
  return normalized
    .split("/")
    .some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ? undefined
    : normalized;
}

function isEccContentDestination(
  source: string,
  destination: string,
  roots?: GovernedEccDestinationRoots,
): boolean {
  const mapping = eccContentDestinationMapping(source, roots?.target);
  if (mapping === undefined) return false;
  if (roots === undefined) return normalizedPath(destination).endsWith(`/${mapping.relative}`);
  const root = mapping.scope === "project" ? roots.projectRoot : roots.homeDir;
  return containedRelative(root, destination) === mapping.relative;
}

/**
 * Each retained upstream content source has exactly one owned target path.
 * Matching a suffix somewhere below an otherwise trusted root is not enough:
 * it could remap a rule to a skill or overwrite a sibling's content.
 *
 * Exported because it is the single answer to "where does this component's
 * source file land for this target". A target adapter that needed the same
 * answer and restated it would be a second mapping able to drift from the one
 * the governed classifier below enforces.
 *
 * Three rows are target-independent and therefore SHARED by every target:
 * `AGENTS.md`, `.agents/plugins/` and `.agents/skills/` are the same
 * destination whoever asks. `.claude/commands/` is the opposite — a surface
 * Claude owns exclusively — so it answers for the Claude target and for nobody
 * else: a non-Claude install that landed there would write another tool's
 * directory, and the callers of this mapping fail closed on an unmapped source
 * rather than inventing a destination for it.
 *
 * One target's project root is not `.<target>`: Kimi's is `.kimi-code`, which
 * is where the framework's own Kimi adapter roots a project install and keeps
 * its install state. `.kimi` is that framework's OBSOLETE compatibility-docs
 * directory — its adapter deliberately does not recreate it — so deriving the
 * root would write a directory upstream abandoned. Overriding here rather than
 * at a call site keeps this the single answer to "where does this source land
 * for this target", which is what the governed classifier enforces against.
 */
export function eccContentDestinationMapping(
  source: string,
  target: string | undefined,
): { scope: "project" | "home"; relative: string } | undefined {
  if (source === "AGENTS.md") return { scope: "project", relative: "AGENTS.md" };
  if (source === ".codex/AGENTS.md") {
    return { scope: "home", relative: ".codex/AGENTS.md" };
  }
  if (target === undefined) return undefined;
  const targetRoot = target === "kimi" ? ".kimi-code" : `.${target}`;
  const mappings: Array<[string, string]> = [
    [".agents/plugins/", ".agents/plugins/"],
    [".agents/skills/", ".agents/skills/"],
    ...(target === "claude"
      ? ([[".claude/commands/", ".claude/commands/"]] as Array<[string, string]>)
      : []),
    ["agents/", `${targetRoot}/agents/`],
    ["skills/", `${targetRoot}/skills/`],
    ["commands/", `${targetRoot}/commands/`],
    ["rules/", `${targetRoot}/rules/`],
  ];
  for (const [sourcePrefix, targetPrefix] of mappings) {
    if (!source.startsWith(sourcePrefix)) continue;
    const suffix = source.slice(sourcePrefix.length);
    if (suffix.length === 0) return undefined;
    return { scope: "project", relative: `${targetPrefix}${suffix}` };
  }
  return undefined;
}

/**
 * Classify an operation from the upstream manifest rather than from an ECC
 * profile/module. Core and platform modules are intentionally mixed: their
 * module id is useful identity evidence, but it cannot decide ownership.
 *
 * A merge into an unrecognized runtime path is never guessed to be harmless.
 * New upstream operation forms therefore stop a governed install before apply.
 */
export function classifyGovernedEccOperation(
  operation: EccManifestOperation,
  roots?: GovernedEccDestinationRoots,
): GovernedEccOperationClass {
  if (operation.kind !== "copy-file" && operation.kind !== "merge-json") {
    throw new Error(`unsupported ECC manifest operation kind: ${operation.kind}`);
  }
  if (typeof operation.moduleId !== "string" || operation.moduleId.trim().length === 0) {
    throw new Error("invalid ECC manifest module identity");
  }
  const source = assertSourceRelativePath(operation.sourceRelativePath);
  const destination = assertDestinationPath(operation.destinationPath);

  if (isMcpPath(source) || isMcpPath(destination)) return "mcp";
  if (
    operation.moduleId === "hooks-runtime" ||
    isHostRuntimePath(source) ||
    isHostRuntimePath(destination)
  ) {
    return "host-runtime";
  }
  if (operation.kind === "merge-json") {
    throw new Error(
      `unclassifiable governed ECC merge-json operation: ${operation.moduleId}:${destination}`,
    );
  }
  if (!isEccContentPath(source) || !isEccContentDestination(source, destination, roots)) {
    throw new Error(
      `unclassifiable governed ECC content operation: ${operation.moduleId}:${source} -> ${destination}`,
    );
  }
  return "ecc-content";
}

/**
 * Apply normal component selection first, then remove only the explicitly
 * classified AIH-owned surfaces. This is intentionally operation-level even
 * for Core/platform and full scope, whose modules contain mixed ownership.
 */
export function filterGovernedEccManifestPlan<Operation extends EccManifestOperation>(
  plan: EccManifestPlan<Operation>,
  selection: EccComponentSelection,
  roots?: GovernedEccDestinationRoots,
): void {
  assertPlanShape(plan);
  const selected = plan.operations.filter((operation) =>
    eccManifestOperationSelected(operation, selection),
  );
  const destinations = new Set<string>();
  const operations = selected.filter((operation) => {
    if (classifyGovernedEccOperation(operation, roots) !== "ecc-content") return false;
    const destination = normalizedPath(operation.destinationPath);
    const collisionKey = destination.normalize("NFC").toLowerCase();
    if (destinations.has(collisionKey)) {
      throw new Error(`normalized governed ECC destination collision: ${destination}`);
    }
    destinations.add(collisionKey);
    return true;
  });
  plan.operations = operations;
  plan.statePreview.operations = operations;
}
