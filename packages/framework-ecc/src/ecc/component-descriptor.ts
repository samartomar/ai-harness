import { eccDescriptorMemo, eccDescriptorSection } from "../invocation.js";
import {
  type EccComponentId,
  type EccMcpComponentId,
  UPSTREAM_CORE_ECC_MODULE_IDS,
} from "./components.js";

export interface EccComponentInstallDescriptor {
  evidenceComponentId: string;
  containingModuleId: string;
  wholeModules?: readonly string[];
  skills?: readonly string[];
  agents?: readonly string[];
  sourceRoots?: readonly string[];
  agentScaffolding?: boolean;
}

function modulePaths(): Map<string, readonly string[]> {
  return eccDescriptorMemo("materialize.modulePaths", loadModulePaths);
}

function loadModulePaths(): Map<string, readonly string[]> {
  const graph = eccDescriptorSection<{
    readonly modules: readonly { readonly id: string; readonly paths: readonly string[] }[];
  }>("moduleGraph");
  return new Map(graph.modules.map((module) => [module.id, module.paths] as const));
}

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

function skillModules(): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [moduleId, paths] of modulePaths()) {
    for (const path of paths) {
      const skill = /^skills\/([a-z0-9][a-z0-9-]*)$/.exec(path)?.[1];
      if (skill === undefined) continue;
      const existing = result[skill];
      if (existing !== undefined && existing !== moduleId) {
        throw new Error(`ECC skill ${skill} belongs to both ${existing} and ${moduleId}`);
      }
      result[skill] = moduleId;
    }
  }
  return Object.freeze(result);
}

function loadedSkillModulesV1(): Readonly<Record<string, string>> {
  return eccDescriptorMemo("materialize.skillModules", skillModules);
}

function leafName(componentId: string, family: string): string | undefined {
  const prefix = `${family}:`;
  return componentId.startsWith(prefix) ? componentId.slice(prefix.length) : undefined;
}

export function eccComponentInstallDescriptor(
  componentId: EccComponentId | EccMcpComponentId,
): EccComponentInstallDescriptor {
  const selectedModule = leafName(componentId, "module");
  if (selectedModule !== undefined) {
    if (!modulePaths().has(selectedModule)) {
      throw new Error(`pinned ECC module snapshot is missing ${selectedModule}`);
    }
    return {
      evidenceComponentId: componentId,
      containingModuleId: selectedModule,
      wholeModules: [selectedModule],
    };
  }
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
      sourceRoots: [".mcp.json", "mcp-configs/mcp-servers.json"],
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
    const moduleId = loadedSkillModulesV1()[skill];
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

/** Whole upstream modules selected by one semantic component, before dependency expansion. */
export function eccComponentWholeModuleIds(
  componentId: EccComponentId | EccMcpComponentId,
): string[] {
  return [...(eccComponentInstallDescriptor(componentId).wholeModules ?? [])];
}

/**
 * Module roots that must be selected beside one semantic component. Languages
 * are additive only after ECC Core; whole-module semantic components retain
 * their existing exact containing-module requirement.
 */
export function eccComponentRequiredModuleRootIds(
  componentId: EccComponentId | EccMcpComponentId,
): string[] {
  return [
    ...new Set([
      ...eccComponentWholeModuleIds(componentId),
      ...(componentId.startsWith("lang:") ? UPSTREAM_CORE_ECC_MODULE_IDS : []),
    ]),
  ];
}

const SELECTABLE_MODULE_MEMBER_KINDS = new Set(["agent", "baseline", "skill"]);

/**
 * Individually selectable artifacts materially contained by one module.
 * MCP, language, framework, capability, runtime, and module identities are
 * deliberately excluded: selecting a source module must not manufacture an
 * activation or a broader semantic choice.
 */
export function eccModuleSelectableMemberIds(
  moduleId: string,
  componentIds: readonly string[],
): string[] {
  if (!modulePaths().has(moduleId)) {
    throw new Error(`pinned ECC module snapshot is missing ${moduleId}`);
  }
  return componentIds.filter((componentId) => {
    const separator = componentId.indexOf(":");
    const kind = separator === -1 ? "" : componentId.slice(0, separator);
    return (
      SELECTABLE_MODULE_MEMBER_KINDS.has(kind) &&
      eccComponentInstallDescriptor(componentId as EccComponentId).containingModuleId === moduleId
    );
  });
}
