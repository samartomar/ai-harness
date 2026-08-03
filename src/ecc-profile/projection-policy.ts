import type { ResolvedEntry } from "./index.js";

export type WorkflowTransport = "native" | "normalized" | "unavailable";

export interface WorkflowProjectionPolicy {
  claude: { transport: WorkflowTransport };
  codex: {
    transport: WorkflowTransport;
    unavailableReason?: string;
    fallback?: string;
  };
}

export type ClaudeRolePolicy = "read-only" | "operator" | "editor";

const REVIEWED_WORKFLOW_IDS = [
  "/aside",
  "/auto-update",
  "/build-fix",
  "/checkpoint",
  "/code-review",
  "/cost-report",
  "/cpp-build",
  "/cpp-review",
  "/cpp-test",
  "/ecc-guide",
  "/epic-claim",
  "/epic-decompose",
  "/epic-publish",
  "/epic-review",
  "/epic-sync",
  "/epic-unblock",
  "/epic-validate",
  "/evolve",
  "/fastapi-review",
  "/feature-dev",
  "/flutter-build",
  "/flutter-review",
  "/flutter-test",
  "/gan-build",
  "/gan-design",
  "/go-build",
  "/go-review",
  "/go-test",
  "/gradle-build",
  "/harness-audit",
  "/hookify-configure",
  "/hookify-help",
  "/hookify-list",
  "/hookify",
  "/instinct-export",
  "/instinct-import",
  "/instinct-status",
  "/jira",
  "/kotlin-build",
  "/kotlin-review",
  "/kotlin-test",
  "/learn-eval",
  "/learn",
  "/loop-start",
  "/loop-status",
  "/marketing-campaign",
  "/model-route",
  "/multi-backend",
  "/multi-execute",
  "/multi-frontend",
  "/multi-plan",
  "/multi-workflow",
  "/orch-add-feature",
  "/orch-build-mvp",
  "/orch-change-feature",
  "/orch-fix-defect",
  "/orch-refine-code",
  "/orch-review",
  "/plan-canvas",
  "/plan-prd",
  "/plan",
  "/pm2",
  "/pr",
  "/project-init",
  "/projects",
  "/promote",
  "/prp-commit",
  "/prp-implement",
  "/prp-plan",
  "/prp-pr",
  "/prp-prd",
  "/prune",
  "/python-review",
  "/quality-gate",
  "/react-build",
  "/react-review",
  "/react-test",
  "/refactor-clean",
  "/resume-session",
  "/review-pr",
  "/rust-build",
  "/rust-review",
  "/rust-test",
  "/santa-loop",
  "/save-session",
  "/security-scan",
  "/sessions",
  "/setup-pm",
  "/skill-create",
  "/skill-health",
  "/test-coverage",
  "/update-codemaps",
  "/update-docs",
  "/vue-review",
] as const;

const CODEX_UNAVAILABLE: Record<string, { reason: string; fallback: string }> = {
  "/checkpoint": {
    reason: "Session checkpoint state is reserved for the later continuity lifecycle.",
    fallback: "Summarize the checkpoint in the current conversation without writing state.",
  },
  "/cost-report": {
    reason: "Claude-specific cost telemetry is not available through this Codex projection.",
    fallback: "Use client-native usage reporting when available and label its scope explicitly.",
  },
  "/evolve": {
    reason: "Learning and self-promotion state remain disabled until the opt-in learning slice.",
    fallback: "Propose a reviewed improvement without persisting or promoting it.",
  },
  "/hookify-help": {
    reason: "Composite-hook registration and state are not implemented in renderer slice 3.",
    fallback: "Describe the planned AIH hook contract without reading or changing hook state.",
  },
  "/hookify-list": {
    reason: "Composite-hook registration and state are not implemented in renderer slice 3.",
    fallback: "Report that no AIH hook registry is active yet.",
  },
  "/instinct-export": {
    reason: "Learning-state export remains disabled until the opt-in learning lifecycle exists.",
    fallback: "Return a reviewable summary in the conversation without exporting state.",
  },
  "/instinct-import": {
    reason: "Learning-state import remains disabled until the opt-in learning lifecycle exists.",
    fallback: "Review the candidate content without importing or promoting it.",
  },
  "/instinct-status": {
    reason: "Learning state is not projected or activated in renderer slice 3.",
    fallback: "Report that no managed learning state is active.",
  },
  "/learn-eval": {
    reason: "Adapted learning/evaluation is planned separately and has no managed state yet.",
    fallback: "Evaluate the supplied material without retaining or self-promoting it.",
  },
  "/learn": {
    reason: "Learning is an explicit opt-in capability that is not active in renderer slice 3.",
    fallback: "Suggest a candidate lesson for human review without persisting it.",
  },
  "/loop-start": {
    reason: "Persistent loop state depends on the later continuity lifecycle.",
    fallback: "Run one bounded iteration in the current conversation.",
  },
  "/loop-status": {
    reason: "Persistent loop state depends on the later continuity lifecycle.",
    fallback: "State that no managed loop is active and summarize current conversational progress.",
  },
  "/plan-canvas": {
    reason: "Plan Canvas requires its separately pinned runtime and on-demand lifecycle.",
    fallback: "Produce a plain-text plan in the current conversation.",
  },
  "/projects": {
    reason: "The upstream project registry is learning state and is not an active AIH owner.",
    fallback: "Inspect the current project only, without reading or writing a registry.",
  },
  "/promote": {
    reason: "Self-promotion is forbidden until reviewed opt-in learning lifecycle exists.",
    fallback: "Prepare a promotion proposal for explicit human review.",
  },
  "/prune": {
    reason: "Learning-state pruning is unavailable because that state is not active.",
    fallback: "Identify stale candidates without deleting or rewriting state.",
  },
  "/resume-session": {
    reason: "Managed cross-session continuity is not implemented in renderer slice 3.",
    fallback: "Ask the user for the required context and continue without reading session state.",
  },
  "/save-session": {
    reason: "Managed cross-session continuity is not implemented in renderer slice 3.",
    fallback: "Return a copyable handoff summary without writing session state.",
  },
  "/sessions": {
    reason: "Managed cross-session continuity is not implemented in renderer slice 3.",
    fallback: "Report that no AIH-managed session inventory is available.",
  },
  "/setup-pm": {
    reason: "Client configuration writes are outside renderer slice 3.",
    fallback: "Detect the package manager from committed project evidence without writing config.",
  },
};

const REVIEWED_ROLE_IDS = [
  "a11y-architect",
  "agent-evaluator",
  "architect",
  "build-error-resolver",
  "chief-of-staff",
  "code-architect",
  "code-explorer",
  "code-reviewer",
  "code-simplifier",
  "comment-analyzer",
  "conversation-analyzer",
  "cpp-build-resolver",
  "cpp-reviewer",
  "csharp-reviewer",
  "dart-build-resolver",
  "database-reviewer",
  "django-build-resolver",
  "django-reviewer",
  "doc-updater",
  "docs-lookup",
  "e2e-runner",
  "fastapi-reviewer",
  "flutter-reviewer",
  "fsharp-reviewer",
  "gan-evaluator",
  "gan-generator",
  "gan-planner",
  "go-build-resolver",
  "go-reviewer",
  "harmonyos-app-resolver",
  "harness-optimizer",
  "healthcare-reviewer",
  "homelab-architect",
  "java-build-resolver",
  "java-reviewer",
  "kotlin-build-resolver",
  "kotlin-reviewer",
  "loop-operator",
  "marketing-agent",
  "mle-reviewer",
  "network-architect",
  "network-config-reviewer",
  "network-troubleshooter",
  "opensource-forker",
  "opensource-packager",
  "opensource-sanitizer",
  "performance-optimizer",
  "php-reviewer",
  "planner",
  "pr-test-analyzer",
  "python-reviewer",
  "pytorch-build-resolver",
  "react-build-resolver",
  "react-reviewer",
  "refactor-cleaner",
  "rust-build-resolver",
  "rust-reviewer",
  "security-reviewer",
  "seo-specialist",
  "silent-failure-hunter",
  "spec-miner",
  "swift-build-resolver",
  "swift-reviewer",
  "tdd-guide",
  "type-design-analyzer",
  "typescript-reviewer",
  "vue-reviewer",
] as const;

const EDITOR_ROLES = new Set([
  "build-error-resolver",
  "code-simplifier",
  "cpp-build-resolver",
  "dart-build-resolver",
  "django-build-resolver",
  "doc-updater",
  "e2e-runner",
  "gan-generator",
  "go-build-resolver",
  "harmonyos-app-resolver",
  "java-build-resolver",
  "kotlin-build-resolver",
  "marketing-agent",
  "opensource-forker",
  "opensource-packager",
  "opensource-sanitizer",
  "performance-optimizer",
  "pytorch-build-resolver",
  "react-build-resolver",
  "refactor-cleaner",
  "rust-build-resolver",
  "swift-build-resolver",
]);

const OPERATOR_ROLES = new Set([
  "code-explorer",
  "gan-evaluator",
  "harness-optimizer",
  "loop-operator",
  "network-troubleshooter",
  "pr-test-analyzer",
  "spec-miner",
  "tdd-guide",
]);

function exactPolicySet(
  actual: readonly string[],
  reviewed: readonly string[],
  label: string,
): void {
  const orderedActual = [...actual].sort().join("\n");
  const orderedReviewed = [...reviewed].sort().join("\n");
  if (orderedActual !== orderedReviewed)
    throw new Error(`${label} changed and requires a new reviewed projection policy`);
}

export function workflowProjectionPolicies(
  workflows: readonly ResolvedEntry[],
): ReadonlyMap<string, WorkflowProjectionPolicy> {
  exactPolicySet(
    workflows.map((workflow) => workflow.id),
    REVIEWED_WORKFLOW_IDS,
    "pinned workflow surface",
  );
  return new Map(
    workflows.map((workflow) => {
      const unavailable = CODEX_UNAVAILABLE[workflow.id];
      return [
        workflow.id,
        {
          claude: {
            transport: workflow.owner === "aih-adaptation" ? "normalized" : "native",
          },
          codex: unavailable
            ? {
                transport: "unavailable",
                unavailableReason: unavailable.reason,
                fallback: unavailable.fallback,
              }
            : { transport: "normalized" },
        },
      ];
    }),
  );
}

export function claudeRolePolicy(
  roles: readonly ResolvedEntry[],
): ReadonlyMap<string, ClaudeRolePolicy> {
  exactPolicySet(
    roles.map((role) => role.id),
    REVIEWED_ROLE_IDS,
    "pinned role surface",
  );
  return new Map(
    roles.map((role) => [
      role.id,
      EDITOR_ROLES.has(role.id) ? "editor" : OPERATOR_ROLES.has(role.id) ? "operator" : "read-only",
    ]),
  );
}

export function claudeRoleTools(policy: ClaudeRolePolicy): string[] {
  if (policy === "editor") return ["Read", "Grep", "Glob", "Bash", "Edit", "Write"];
  if (policy === "operator") return ["Read", "Grep", "Glob", "Bash"];
  return ["Read", "Grep", "Glob"];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeCodexWorkflowBody(body: string, workflowIds: readonly string[]): string {
  const hadMcpSyntax = /\bmcp__[a-z0-9_-]+\b/i.test(body);
  let fenced = false;
  const normalized = body.split("\n").map((sourceLine) => {
    const marker = sourceLine.trimStart().startsWith("```");
    const codeContext = fenced || marker;
    let line = sourceLine;
    line = line.replace(
      /\.claude\/commands\/([a-z0-9-]+)\.md/g,
      ".agents/skills/ecc-workflow-$1/SKILL.md",
    );
    line = line.replace(/\.claude\/skills\//g, ".agents/skills/");
    line = line.replace(/\.claude\/agents\//g, ".codex/agents/");
    line = line.replace(/\.claude\/([A-Za-z0-9_./${}-]*)/g, "<project-artifact-path>/$1");
    line = line.replace(
      /\$ARGUMENTS/g,
      codeContext ? "<workflow-arguments>" : "the supplied workflow arguments",
    );
    line = line.replace(/\bAskUserQuestion\b/g, "Ask the user");
    line = line.replace(/\bsubagent_type\s*:\s*[`"']?([a-z0-9-]+)[`"']?/gi, "$1 role");
    line = line.replace(/\b(?:Codex\s+)?(?:Opus|Sonnet|Haiku)\b/gi, "reviewed Codex model");
    line = line.replace(/\bmodel\s*:\s*[`"']?[a-z0-9._-]+[`"']?/gi, "reviewed model");
    line = line.replace(/\b(?:Agent|Task)(?: tool)?\b/g, "Codex agent delegation");
    line = line.replace(/\bmcp__[a-z0-9_-]+\b/gi, "optional MCP tool");
    line = line.replace(/\bClaude Code\b/g, "Codex").replace(/\bClaude\b/g, "Codex");
    for (const id of [...workflowIds].sort((left, right) => right.length - left.length)) {
      line = line.replace(
        new RegExp(`(^|[^A-Za-z0-9/_-])${escapeRegex(id)}(?=$|[^A-Za-z0-9/_-])`, "g"),
        `$1ecc-workflow-${id.slice(1)}`,
      );
    }
    if (marker) fenced = !fenced;
    return line;
  });
  if (hadMcpSyntax) {
    normalized.push(
      "",
      "## Optional MCP fallback",
      "",
      "Use the named MCP only when it is available in the current client; otherwise use repository evidence or official documentation and state the limitation.",
    );
  }
  return `${normalized.join("\n").trim()}\n`;
}

export function normalizeCodexWorkflowDescription(
  description: string,
  workflowIds: readonly string[],
): string {
  const normalized = normalizeCodexWorkflowBody(description, workflowIds);
  const fallbackBoundary = normalized.indexOf("\n\n## Optional MCP fallback");
  return normalized
    .slice(0, fallbackBoundary < 0 ? undefined : fallbackBoundary)
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCodexRoleBody(id: string, body: string): string {
  let normalized = body
    .replace(/\bClaude Code\b/g, "Codex")
    .replace(/\bClaude\b/g, "Codex")
    .replace(
      /^.*\.claude\/rules\/\*\.md.*$/gm,
      "Repository rules configured for the current client are authoritative; verify their actual discovery rather than assuming injection.",
    )
    .replace(/--exclude='\.claude\/'/g, "--exclude='.claude/' --exclude='.codex/'")
    .replace(
      /`\.claude\/settings\.json`/g,
      "client settings such as `.claude/settings.json` and `.codex/config.toml`",
    )
    .replace(/^\.claude\/settings\.json$/gm, ".claude/settings.json, .codex/config.toml")
    .replace(/\.claude\/skills\//g, ".agents/skills/")
    .replace(/\bmcp__[a-z0-9_-]+\b/gi, "optional client documentation or browser tool");
  if (id === "docs-lookup") {
    normalized = `${normalized.trim()}\n\nIf Context7 is unavailable, use the official documentation fallback and identify the source.\n`;
  } else if (/optional client documentation or browser tool/.test(normalized)) {
    normalized = `${normalized.trim()}\n\nIf the optional integration is unavailable, use a client-native or repository-evidence fallback and state the limitation.\n`;
  }
  return normalized;
}

export function normalizeCodexRoleDescription(id: string, description: string): string {
  return normalizeCodexRoleBody(id, description).replace(/\s+/g, " ").trim();
}
