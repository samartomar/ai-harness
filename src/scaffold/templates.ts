import { frontmatter, lines } from "../internals/render.js";

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

/** Architecture skeleton — section headers an author fills in per repo. */
export function architectureDoc(dir: string): string {
  return lines(
    "# Architecture",
    "",
    `> Canonical architecture context. Referenced from \`${dir}/INDEX.md\`.`,
    "",
    "## Overview",
    "",
    "_What this system does and the shape of it in two or three sentences._",
    "",
    "## Modules",
    "",
    "_The major modules/packages and the responsibility of each._",
    "",
    "## Data flow",
    "",
    "_How a request / job moves through the system; the important boundaries._",
    "",
    "## External dependencies",
    "",
    "_Services, datastores, and third-party APIs this system relies on._",
    "",
    "## Constraints & invariants",
    "",
    "_Rules that must hold (security, performance, compliance) and why._",
  );
}

/** Conventions skeleton — section headers an author fills in per repo. */
export function conventionsDoc(dir: string): string {
  return lines(
    "# Conventions",
    "",
    `> Canonical conventions context. Referenced from \`${dir}/INDEX.md\`.`,
    "",
    "## Coding style",
    "",
    "_Formatter, linter, import ordering, and the idioms this repo prefers._",
    "",
    "## Naming",
    "",
    "_How files, types, functions, and tests are named._",
    "",
    "## Testing",
    "",
    "_Test framework, where tests live, and the coverage bar._",
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
