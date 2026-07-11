import type { Posture } from "../config/posture.js";
import type { RepoStack } from "../profile/scan.js";

export type EccComponentId = `${string}:${string}`;
export type EccMcpComponentId = `mcp:${string}`;

export const COMMON_ECC_COMPONENTS = [
  "baseline:rules",
  "baseline:agents",
  "baseline:platform",
  "baseline:commands",
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
] as const satisfies readonly EccComponentId[];

const LANGUAGE_COMPONENTS: Readonly<Record<string, readonly EccComponentId[]>> = {
  "TypeScript/Node.js": ["lang:typescript", "agent:typescript-reviewer"],
  "JavaScript/Node.js": ["lang:typescript", "agent:typescript-reviewer"],
  TypeScript: ["lang:typescript", "agent:typescript-reviewer"],
  JavaScript: ["lang:typescript", "agent:typescript-reviewer"],
  Python: ["lang:python", "agent:python-reviewer"],
  Go: ["lang:go", "agent:go-reviewer", "agent:go-build-resolver"],
  Java: ["lang:java", "agent:java-reviewer", "agent:java-build-resolver"],
  Kotlin: ["lang:kotlin", "agent:kotlin-reviewer", "agent:kotlin-build-resolver"],
  Rust: ["lang:rust", "agent:rust-reviewer", "agent:rust-build-resolver"],
  Swift: ["lang:swift", "agent:swift-reviewer", "agent:swift-build-resolver"],
  PHP: ["lang:php", "agent:php-reviewer"],
  Ruby: ["lang:ruby"],
};

const WEB_AGENTS = ["agent:e2e-runner", "agent:a11y-architect"] as const;

const FRAMEWORK_COMPONENTS: Readonly<Record<string, readonly EccComponentId[]>> = {
  React: ["framework:react", "agent:react-reviewer", "agent:react-build-resolver", ...WEB_AGENTS],
  "Next.js": [
    "framework:nextjs",
    "agent:react-reviewer",
    "agent:react-build-resolver",
    ...WEB_AGENTS,
  ],
  Angular: ["framework:angular", ...WEB_AGENTS],
  Vue: ["framework:vue", ...WEB_AGENTS],
  Nuxt: ["framework:nuxt", ...WEB_AGENTS],
  Svelte: ["framework:svelte", ...WEB_AGENTS],
  Django: ["framework:django", "agent:django-reviewer", "agent:django-build-resolver"],
  FastAPI: ["agent:fastapi-reviewer"],
  "Spring Boot": ["framework:springboot", "agent:java-reviewer", "agent:java-build-resolver"],
  Quarkus: ["framework:quarkus"],
  Rails: ["framework:rails"],
  Laravel: ["framework:laravel"],
};

const DECLARATION_RIDERS: Readonly<Record<string, readonly EccComponentId[]>> = {
  "lang:typescript": ["agent:typescript-reviewer"],
  "lang:python": ["agent:python-reviewer"],
  "lang:go": ["agent:go-reviewer", "agent:go-build-resolver"],
  "lang:java": ["agent:java-reviewer", "agent:java-build-resolver"],
  "lang:kotlin": ["agent:kotlin-reviewer", "agent:kotlin-build-resolver"],
  "lang:rust": ["agent:rust-reviewer", "agent:rust-build-resolver"],
  "lang:cpp": ["agent:cpp-reviewer", "agent:cpp-build-resolver"],
  "lang:php": ["agent:php-reviewer"],
  "lang:csharp": ["agent:csharp-reviewer"],
  "lang:fsharp": ["agent:fsharp-reviewer"],
  "lang:swift": ["agent:swift-reviewer", "agent:swift-build-resolver"],
  "lang:arkts": ["agent:harmonyos-app-resolver"],
  "framework:react": ["agent:react-reviewer", "agent:react-build-resolver", ...WEB_AGENTS],
  "framework:nextjs": ["agent:react-reviewer", "agent:react-build-resolver", ...WEB_AGENTS],
  "framework:angular": [...WEB_AGENTS],
  "framework:django": ["agent:django-reviewer", "agent:django-build-resolver"],
  "capability:database": ["agent:database-reviewer"],
  "capability:machine-learning": ["agent:pytorch-build-resolver", "agent:mle-reviewer"],
};

const DECLARABLE_COMPONENTS = new Set<string>([
  ...COMMON_ECC_COMPONENTS,
  ...Object.values(LANGUAGE_COMPONENTS).flat(),
  ...Object.values(FRAMEWORK_COMPONENTS).flat(),
  ...Object.keys(DECLARATION_RIDERS),
  ...Object.values(DECLARATION_RIDERS).flat(),
  "baseline:hooks",
  "baseline:workflow",
  "capability:security",
  "capability:research",
  "capability:content",
  "capability:operators",
  "capability:optimization",
  "capability:prediction-markets",
  "capability:social",
  "capability:media",
  "capability:orchestration",
  "capability:agentic",
  "capability:devops",
  "capability:supply-chain",
  "capability:documents",
  "lang:c",
  "lang:perl",
  "framework:quarkus",
  "framework:rails",
  "framework:laravel",
  "skill:continuous-learning",
  "skill:eval-harness",
  "skill:windows-desktop-e2e",
  "skill:frontend-patterns",
  "skill:backend-patterns",
  "skill:security-review",
  "skill:deep-research",
  "skill:mle-workflow",
]);

const EXPLICIT_MCP_COMPONENTS = new Set<EccMcpComponentId>([
  "mcp:sequential-thinking",
  "mcp:code-review-graph",
  "mcp:codebase-memory-mcp",
  "mcp:github",
  "mcp:context7",
  "mcp:exa",
]);

const REPO_DECLARED_DEFAULT_MCPS: Readonly<Record<string, EccMcpComponentId>> = {
  "code-review-graph": "mcp:code-review-graph",
  "codebase-memory-mcp": "mcp:codebase-memory-mcp",
};

export interface SelectEccComponentsInput {
  stack: RepoStack;
  posture: Posture;
  profile: string;
  declarations?: readonly string[];
  declaredMcps?: readonly string[];
}

export interface EccComponentSelection {
  scope: "scoped" | "full";
  components: EccComponentId[];
  mcps: EccMcpComponentId[];
  recommendations: EccComponentId[];
}

function addAll<T extends string>(target: Set<T>, ordered: T[], values: readonly T[]): void {
  for (const value of values) {
    if (target.has(value)) continue;
    target.add(value);
    ordered.push(value);
  }
}

function normalizeDeclaration(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes(":")) return normalized;
  for (const family of ["skill", "agent"] as const) {
    const candidate = `${family}:${normalized}`;
    if (DECLARABLE_COMPONENTS.has(candidate)) return candidate;
  }
  return normalized;
}

export function selectEccComponents(input: SelectEccComponentsInput): EccComponentSelection {
  const componentSet = new Set<EccComponentId>();
  const components: EccComponentId[] = [];
  addAll(componentSet, components, COMMON_ECC_COMPONENTS);

  for (const language of input.stack.languages) {
    addAll(componentSet, components, LANGUAGE_COMPONENTS[language] ?? []);
  }
  for (const framework of input.stack.frameworks) {
    addAll(componentSet, components, FRAMEWORK_COMPONENTS[framework] ?? []);
  }
  if (input.stack.databases.length > 0) {
    addAll(componentSet, components, ["capability:database", "agent:database-reviewer"]);
  }
  if (input.stack.deployment.length > 0) {
    addAll(componentSet, components, ["capability:devops"]);
  }

  const mcpSet = new Set<EccMcpComponentId>();
  const mcps: EccMcpComponentId[] = [];
  addAll(mcpSet, mcps, ["mcp:sequential-thinking"]);
  for (const name of input.declaredMcps ?? []) {
    const selected = REPO_DECLARED_DEFAULT_MCPS[name.trim().toLowerCase()];
    if (selected !== undefined) addAll(mcpSet, mcps, [selected]);
  }
  if (input.posture === "team" || input.posture === "enterprise") {
    addAll(mcpSet, mcps, ["mcp:github"]);
  }

  for (const raw of input.declarations ?? []) {
    const declaration = normalizeDeclaration(raw);
    if (EXPLICIT_MCP_COMPONENTS.has(declaration as EccMcpComponentId)) {
      addAll(mcpSet, mcps, [declaration as EccMcpComponentId]);
      continue;
    }
    if (!DECLARABLE_COMPONENTS.has(declaration)) {
      throw new Error(`unknown ECC component declaration: ${raw}`);
    }
    const component = declaration as EccComponentId;
    addAll(componentSet, components, [component]);
    addAll(componentSet, components, DECLARATION_RIDERS[component] ?? []);
  }

  const recommendations: EccComponentId[] = [];
  if (input.posture === "enterprise") {
    addAll(componentSet, components, ["capability:security"]);
  } else if (input.posture === "team" && !componentSet.has("capability:security")) {
    recommendations.push("capability:security");
  }

  return {
    scope: input.profile === "full" ? "full" : "scoped",
    components,
    mcps,
    recommendations,
  };
}
