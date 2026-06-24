import { frontmatter, lines } from "../internals/render.js";
import type { RepoStack } from "../profile/scan.js";

/** Auto-populated bullets describing what the profiler actually detected. */
function detectedStackBlock(stack: RepoStack): string[] {
  const out = [
    `- Languages: ${stack.languages.length > 0 ? stack.languages.join(", ") : "none detected"}`,
  ];
  if (stack.frameworks.length > 0) out.push(`- Frameworks: ${stack.frameworks.join(", ")}`);
  if (stack.cloud.length > 0) out.push(`- Cloud: ${stack.cloud.join(", ")}`);
  if (stack.databases.length > 0) out.push(`- Databases: ${stack.databases.join(", ")}`);
  if (stack.deployment.length > 0) out.push(`- Deployment: ${stack.deployment.join(", ")}`);
  if (stack.packageManager) out.push(`- Package manager: ${stack.packageManager}`);
  const cmds: string[] = [];
  if (stack.testRunner) cmds.push(`test \`${stack.testRunner}\``);
  if (stack.buildCommand) cmds.push(`build \`${stack.buildCommand}\``);
  if (stack.lintCommand) cmds.push(`lint \`${stack.lintCommand}\``);
  out.push(`- Commands: ${cmds.length > 0 ? cmds.join(" · ") : "none defined in the repo"}`);
  return out;
}

/** A one-line synthesized overview from the detected facts. */
function overviewLine(stack: RepoStack): string {
  if (stack.description) return stack.description;
  const lang = stack.languages[0] ?? "a multi-language";
  const fw = stack.frameworks.length > 0 ? ` using ${stack.frameworks.join(" + ")}` : "";
  const cloud = stack.cloud.length > 0 ? ` on ${stack.cloud.join("/")}` : "";
  return `A ${lang} project${fw}${cloud}.`;
}

/**
 * Canonical context-dir content. Everything routes through {@link lines} /
 * {@link frontmatter} so golden-file tests stay byte-stable (no dates, no
 * random ordering, single trailing newline). `dir` is the context directory
 * name (`ctx.contextDir`) so every generated path/reference honors the override.
 */

/**
 * Dense routing index — the single entry point an agent loads first. Lists what
 * each context file holds and *when* to load it (progressive disclosure), so a
 * model pulls `architecture.md` only for design work, `conventions.md` only when
 * writing code, etc. Kept ~30 lines on purpose.
 */
export function indexDoc(dir: string): string {
  return lines(
    `# ${dir} — context index`,
    "",
    "Canonical, tool-agnostic context for this repository. The root bootloaders",
    "(`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, …) and `RULE_ROUTER.md` are generated",
    "by `aih bootstrap-ai` and point here — edit context in this directory, never",
    "in the bootloaders.",
    "",
    "> **New / freshly scaffolded?** The files below start as skeletons. An AI agent",
    "> can fill them from the code by following **`SETUP-TASKS.md`** in this directory —",
    "> start there before doing other work.",
    "",
    "## Load order (progressive disclosure)",
    "",
    "Read this index first, then load only the file the task needs:",
    "",
    `- **architecture.md** — system shape, modules, data flow, key boundaries.`,
    "  Load when designing, adding a module, or reasoning about blast radius.",
    `- **conventions.md** — coding style, naming, testing, commit rules.`,
    "  Load before writing or reviewing code.",
    `- **tasks.md** — active workstreams, backlog, and decisions in flight.`,
    "  Load to pick up work or record a decision.",
    `- **skills/** — focused, reusable how-to playbooks (one dir per skill,`,
    "  each with a `SKILL.md`). Load a skill only when its trigger matches.",
    "",
    "Stack-aware engineering rules, agents, and the brainstorm→plan→TDD→review loop",
    "are installed into your agent CLI by `aih ecc` (affaan-m/ECC) and `aih superpowers`",
    "(obra/Superpowers), not stored here — this directory holds repo-specific context.",
    "",
    "## Conventions for this directory",
    "",
    "- Keep each file focused; prefer many small files over one large one.",
    "- One concern per skill; name skills by outcome, not by component.",
    "- This index is the contract: when you add a context file, list it here",
    "  with a one-line *what* and *when to load*.",
  );
}

/**
 * Architecture context — the "Detected stack" / "Overview" / "Entry points"
 * blocks are auto-populated from the profiler so the file is useful immediately;
 * the prose sections remain author-fill prompts.
 */
export function architectureDoc(dir: string, stack: RepoStack): string {
  const entryPoints =
    stack.entryPoints.length > 0
      ? stack.entryPoints.map((e) => `- \`${e}\``)
      : ["_None detected — list the main entry points (handlers, CLI, server)._"];
  const externalDeps: string[] = [];
  for (const c of stack.cloud) externalDeps.push(`- ${c} (cloud provider / SDK detected).`);
  for (const f of stack.frameworks) externalDeps.push(`- ${f}.`);
  if (externalDeps.length === 0)
    externalDeps.push("_Services, datastores, and third-party APIs this system relies on._");
  const invariants =
    stack.frameworks.includes("Serverless Framework") || stack.deployment.includes("AWS SAM")
      ? [
          "- Lambda handlers must be stateless — no local disk/session persistence between invocations.",
          "- Resource names (tables/buckets) come from environment/config, never hardcoded ARNs.",
        ]
      : ["_Rules that must hold (security, performance, compliance) and why._"];
  return lines(
    "# Architecture",
    "",
    `> Canonical architecture context. Referenced from \`${dir}/INDEX.md\`.`,
    "> The detected blocks are auto-populated by `aih`; expand the prose sections.",
    "",
    "## Overview",
    "",
    overviewLine(stack),
    "",
    "_Expand: what this system does and its shape in two or three sentences._",
    "",
    "## Detected stack",
    "",
    detectedStackBlock(stack),
    "",
    "## Entry points",
    "",
    entryPoints,
    "",
    "## Modules",
    "",
    "_The major modules/packages and the responsibility of each._",
    "",
    "## External dependencies",
    "",
    externalDeps,
    "",
    "## Constraints & invariants",
    "",
    invariants,
  );
}

/**
 * Conventions context — coding-style / testing lines are seeded from the detected
 * language, linter, and test command; naming/commit sections stay author-fill.
 */
export function conventionsDoc(dir: string, stack: RepoStack): string {
  const isTs = stack.hasTypeScript;
  const isNode = stack.languages.some((l) => l.endsWith("/Node.js"));
  const styleLang = isNode
    ? isTs
      ? "TypeScript (Node.js) — explicit types on exports, no `any`."
      : "JavaScript (Node.js) — plain JS, no TypeScript syntax; JSDoc where it helps."
    : stack.languages.join(", ") || "see repo";
  const naming = isNode
    ? "`camelCase` functions/variables, `PascalCase` types/components, `UPPER_SNAKE_CASE` constants."
    : "match the language's idiom and the nearest peer file; be consistent across the module.";
  return lines(
    "# Conventions",
    "",
    `> Canonical conventions for this repo. Referenced from \`${dir}/INDEX.md\`.`,
    "> Load before writing or reviewing code.",
    "",
    "## Coding style",
    "",
    `- Language: ${styleLang}`,
    `- Lint: ${stack.lintCommand ? `\`${stack.lintCommand}\` — run it before committing` : "no linter configured — consider adding one"}`,
    "- Small, focused functions; immutable updates over mutation; handle errors explicitly — no silent catches.",
    "- Match the nearest peer file (naming, structure, imports) over personal preference.",
    "- No secrets in source, config, or fixtures; read them from the environment.",
    "",
    "## Testing",
    "",
    `- Test command: ${stack.testRunner ? `\`${stack.testRunner}\`` : "none configured in the repo — add one and record it here"}`,
    "- New behavior ships with a test; when a test fails, fix the implementation, not the test.",
    "- Cover the boundaries: invalid input, empty and edge cases, error paths.",
    "",
    "## Naming",
    "",
    `- ${naming}`,
    "",
    "## Commits & review",
    "",
    "- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).",
    "- A change merges when tests/lint/types are green, the diff is surgical, and the risk is stated.",
  );
}

/**
 * The agent-executable completion playbook. The harness lays down skeletons; this
 * tells an AI agent exactly how to FILL them from the code — so the harness
 * self-completes instead of waiting on a human. Stack-aware (entry points,
 * commands, frameworks come from the profiler) and evidence-first.
 */
export function setupTasksDoc(dir: string, stack: RepoStack): string {
  const entry =
    stack.entryPoints.length > 0
      ? stack.entryPoints.map((e) => `\`${e}\``).join(", ")
      : "the main handlers / CLI / server entry";
  const lang = stack.languages[0] ?? "the repo language";
  const fw = stack.frameworks.length > 0 ? stack.frameworks.join(", ") : "any framework in use";
  return lines(
    "# Harness setup tasks — run these as an AI agent",
    "",
    "The harness scaffolded this repo but left the project-specific content as",
    "skeletons. Complete them by **reading the code** — ground every statement in",
    "repo evidence (files, tests, configs). Never invent. Do them in order, then",
    "delete the placeholder `_italics_` you replace.",
    "",
    `## 1. Map the architecture → \`${dir}/architecture.md\``,
    "",
    `- Start from the entry points (${entry}) and trace the main flow(s).`,
    "- Fill: Overview (what it does + shape in 3–5 sentences), Modules (each",
    "  package/dir and its responsibility — cite paths), Data flow, and",
    "  Constraints & invariants (what must hold, and why).",
    "",
    `## 2. Capture conventions → \`${dir}/conventions.md\``,
    "",
    "- Read 5–10 representative files; extract the REAL conventions this repo uses",
    `  (naming, error handling, module layout, test style for ${lang}) — not generic advice.`,
    stack.testRunner
      ? `- The test command is \`${stack.testRunner}\`${stack.lintCommand ? ` and lint is \`${stack.lintCommand}\`` : ""}; record how/where tests live.`
      : "- No test command is configured — note that, and what testing the repo does have.",
    "- Fill the Naming and Commits sections from what the code/history actually does.",
    "",
    `## 3. Enhance guardrails → \`${dir}/project-guardrails.md\``,
    "",
    "Generic gitleaks/pre-commit can't know this repo. From the code, add:",
    `- Security-sensitive paths in THIS repo (auth, payments, PII, ${fw} entry points) — list them.`,
    "- Framework/language footguns to avoid (inferred from the stack + the code).",
    "- The quality gate that must pass before a change is done.",
    '- Repo-specific "never do X" rules you can justify from the code.',
    "",
    `## 4. (Workspace only) Cross-repo map → \`${dir}/cross-repo-architecture.md\``,
    "",
    "- If this is a workspace root, map each repo's responsibility and the cross-repo",
    "  feature table (UI ↔ backend ↔ contract). Read each child repo's canon first.",
    "",
    "## When done",
    "",
    "- Run `aih doctor` to verify, and `aih bootstrap-ai --verify` to confirm the",
    "  canon is in sync. Keep this file as a checklist, or delete it once filled.",
  );
}

/** Framework / stack-specific guardrails auto-derived from the detected stack. */
function frameworkGuardrails(stack: RepoStack): string[] {
  const fw = new Set(stack.frameworks);
  const out: string[] = [];
  if (
    fw.has("Serverless Framework") ||
    stack.deployment.includes("AWS SAM") ||
    stack.deployment.includes("AWS CDK")
  ) {
    out.push("- Lambda handlers stay stateless — no local disk/session between invocations.");
    out.push("- Resource names/ARNs come from env/config, never hardcoded; IAM least-privilege.");
  }
  if (fw.has("Express") || fw.has("Fastify") || fw.has("Koa") || fw.has("NestJS")) {
    out.push(
      "- Validate and sanitize every request input at the boundary; parameterize all queries.",
    );
    out.push("- Set security headers; never build SQL/paths by concatenating user input.");
  }
  if (
    fw.has("React") ||
    fw.has("Next.js") ||
    fw.has("Vue") ||
    fw.has("Svelte") ||
    fw.has("Angular")
  ) {
    out.push("- Escape user content; no `dangerouslySetInnerHTML` / `v-html` without sanitizing.");
    out.push("- Keep secrets server-side; never ship API keys in the client bundle.");
  }
  if (stack.databases.length > 0) {
    out.push(
      `- ${stack.databases.join("/")}: parameterized queries only; least-privilege credentials from env.`,
    );
  }
  if (stack.cloud.length > 0) {
    out.push(
      `- ${stack.cloud.join("/")}: no hardcoded credentials — use roles/managed identity; encrypt at rest.`,
    );
  }
  return out;
}

/**
 * A write-once project-guardrails seed. aih fills the detected facts AND derives
 * framework/stack-specific guardrails; the agent fleshes out the rest per
 * `SETUP-TASKS.md`. Write-once so the agent's work is never overwritten on a re-run.
 */
export function projectGuardrailsDoc(dir: string, stack: RepoStack): string {
  const fwGuards = frameworkGuardrails(stack);
  const gate = [stack.lintCommand, stack.testRunner].filter(Boolean) as string[];
  return lines(
    "# Project guardrails",
    "",
    `> Repo-specific guardrails. Seeded by aih from the detected stack; an agent`,
    `> fleshes this out per \`${dir}/SETUP-TASKS.md\`. WRITE-ONCE — aih won't overwrite it.`,
    "",
    "## Detected stack",
    "",
    detectedStackBlock(stack),
    "",
    "## Quality gate",
    "",
    gate.length > 0
      ? `- \`${gate.join(" && ")}\` must pass before a change is considered done.`
      : "- _No lint/test command detected — add one and record it here._",
    "",
    "## Security-sensitive paths",
    "",
    "_List the dirs/files that handle auth, secrets, payments, or PII. Changes here",
    "get extra review; never log or hardcode secrets in them._",
    "",
    "## Framework / language guardrails",
    "",
    ...(fwGuards.length > 0
      ? [...fwGuards, "", "_Add any others you infer from the code._"]
      : ["_Stack-specific rules and footguns to avoid (fill from the code)._"]),
    "",
    "## Never do",
    "",
    '_Repo-specific hard "no"s, justified from the code or team conventions._',
  );
}

/** Tasks skeleton — section headers an author fills in per repo. */
export function tasksDoc(dir: string): string {
  return lines(
    "# Tasks",
    "",
    `> Active work and decisions. Referenced from \`${dir}/INDEX.md\`.`,
    "",
    "## In progress",
    "",
    "_Workstreams currently being worked on._",
    "",
    "## Backlog",
    "",
    "_Next up, roughly ordered._",
    "",
    "## Decisions",
    "",
    "_Notable decisions and their rationale, newest first._",
  );
}

/**
 * The INDEX/SKILL pattern in miniature: YAML frontmatter ({@link frontmatter})
 * giving the skill a `name` + `description` (the trigger), then a few numbered
 * steps. Real skills replace this; its job is to show the shape.
 */
export function exampleSkillDoc(): string {
  return lines(
    frontmatter({
      name: "example-skill",
      description:
        "Replace with a one-line trigger: what task this skill is for and when to load it.",
    }),
    "",
    "# Example skill",
    "",
    "A skill is a focused, reusable playbook. Keep it to one outcome and make the",
    "`description` above a precise trigger so an agent loads it only when relevant.",
    "",
    "## Steps",
    "",
    "1. State the goal and the preconditions that must hold before starting.",
    "2. Do the work as concrete, ordered actions (commands, edits, checks).",
    "3. Verify the outcome and note how to roll back if it went wrong.",
  );
}
