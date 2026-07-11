import type { EccComponentId, EccComponentSelection, EccMcpComponentId } from "./components.js";

export interface EccComponentInstallDescriptor {
  evidenceComponentId: string;
  containingModuleId: string;
  wholeModules?: readonly string[];
  skills?: readonly string[];
  agents?: readonly string[];
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
  agentScaffolding: boolean;
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
  "lang:swift": [],
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

const DIRECT_EVIDENCE_COMPONENTS = new Set<string>([
  "skill:tdd-workflow",
  "skill:verification-loop",
  "skill:strategic-compact",
  "skill:coding-standards",
  "agent:code-reviewer",
  "agent:code-architect",
  "agent:architect",
  "agent:planner",
  "agent:tdd-guide",
  "agent:build-error-resolver",
  "agent:refactor-cleaner",
  "agent:code-simplifier",
  "agent:silent-failure-hunter",
  "agent:pr-test-analyzer",
  "agent:doc-updater",
  "agent:docs-lookup",
  "agent:code-explorer",
  "agent:security-reviewer",
  "agent:type-design-analyzer",
  "agent:performance-optimizer",
]);

function leafName(componentId: string, family: string): string | undefined {
  const prefix = `${family}:`;
  return componentId.startsWith(prefix) ? componentId.slice(prefix.length) : undefined;
}

export function eccComponentInstallDescriptor(
  componentId: EccComponentId | EccMcpComponentId,
): EccComponentInstallDescriptor {
  const wholeModule = WHOLE_MODULE_COMPONENTS[componentId];
  if (wholeModule !== undefined) {
    return {
      evidenceComponentId: `module:${wholeModule}`,
      containingModuleId: wholeModule,
      wholeModules: [wholeModule],
    };
  }
  if (componentId === "baseline:agents") {
    return {
      evidenceComponentId: "module:agents-core",
      containingModuleId: "agents-core",
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
      evidenceComponentId: DIRECT_EVIDENCE_COMPONENTS.has(componentId)
        ? componentId
        : "module:agents-core",
      containingModuleId: "agents-core",
      agents: [agent],
    };
  }
  const skill = leafName(componentId, "skill");
  if (skill !== undefined) {
    const moduleId = SKILL_MODULES[skill];
    if (moduleId === undefined) throw new Error(`no ECC install descriptor for ${componentId}`);
    return {
      evidenceComponentId: DIRECT_EVIDENCE_COMPONENTS.has(componentId)
        ? componentId
        : `module:${moduleId}`,
      containingModuleId: moduleId,
      skills: [skill],
    };
  }
  const languageSkills = LANGUAGE_SKILLS[componentId];
  if (languageSkills !== undefined) {
    const moduleId = componentId === "lang:swift" ? "swift-apple" : "framework-language";
    return {
      evidenceComponentId: `module:${moduleId}`,
      containingModuleId: moduleId,
      skills: languageSkills,
    };
  }
  const frameworkSkills = FRAMEWORK_SKILLS[componentId];
  if (frameworkSkills !== undefined) {
    return {
      evidenceComponentId: "module:framework-language",
      containingModuleId: "framework-language",
      skills: frameworkSkills,
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
  agentScaffolding: boolean;
} {
  const wholeModules = new Set<string>();
  const skills = new Set<string>();
  const agents = new Set<string>();
  let agentScaffolding = false;
  for (const componentId of [...selection.components, ...selection.mcps]) {
    const descriptor = eccComponentInstallDescriptor(componentId);
    for (const moduleId of descriptor.wholeModules ?? []) wholeModules.add(moduleId);
    for (const skill of descriptor.skills ?? []) skills.add(skill);
    for (const agent of descriptor.agents ?? []) agents.add(agent);
    if (descriptor.agentScaffolding === true) agentScaffolding = true;
  }
  return { wholeModules, skills, agents, agentScaffolding };
}

export function eccMaterializationSpec(selection: EccComponentSelection): EccMaterializationSpec {
  const surface = selectedInstallSurface(selection);
  const moduleIds: string[] = [];
  const seen = new Set<string>();
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
    agentScaffolding: surface.agentScaffolding,
  };
}

function selectedOperation(
  operation: EccManifestOperation,
  surface: ReturnType<typeof selectedInstallSurface>,
): boolean {
  if (surface.wholeModules.has(operation.moduleId)) return true;
  const source = normalizedPath(operation.sourceRelativePath);
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
