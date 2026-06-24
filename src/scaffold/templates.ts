import { frontmatter, lines } from "../internals/render.js";
import type { RepoStack } from "../profile/scan.js";

/** Auto-populated bullets describing what the profiler actually detected. */
function detectedStackBlock(stack: RepoStack): string[] {
  const out = [
    `- Languages: ${stack.languages.length > 0 ? stack.languages.join(", ") : "none detected"}`,
  ];
  if (stack.frameworks.length > 0) out.push(`- Frameworks: ${stack.frameworks.join(", ")}`);
  if (stack.cloud.length > 0) out.push(`- Cloud: ${stack.cloud.join(", ")}`);
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
    "Canonical, tool-agnostic context for this repository. IDE adapters",
    "(`CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `.windsurfrules`,",
    "`.github/copilot-instructions.md`) are thin pointers back here — edit context",
    "in this directory, never in the adapters.",
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
  return lines(
    "# Conventions",
    "",
    `> Canonical conventions context. Referenced from \`${dir}/INDEX.md\`.`,
    "",
    "## Coding style",
    "",
    `- Language: ${styleLang}`,
    `- Lint: ${stack.lintCommand ? `\`${stack.lintCommand}\`` : "no linter configured — consider adding one"}`,
    "- Prefer small, focused functions and immutable updates; handle errors explicitly.",
    "",
    "## Testing",
    "",
    `- Test command: ${stack.testRunner ? `\`${stack.testRunner}\`` : "none configured in the repo"}`,
    "_Where tests live and the coverage bar — fill in._",
    "",
    "## Naming",
    "",
    "_How files, types, functions, and tests are named._",
    "",
    "## Commits & reviews",
    "",
    "_Commit message format and what a change needs before it merges._",
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
