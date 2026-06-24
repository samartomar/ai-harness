import { frontmatter, lines } from "../internals/render.js";

/**
 * Thin IDE adapters — POINTERS, never the rulebook. Each file opens with the
 * exact sentence `This file is not the full rulebook.`, routes the reader to the
 * canonical context dir (`dir` = `ctx.contextDir`), and stays well under 30
 * lines. Different tools read different filenames; they must all agree, so they
 * all defer to one source of truth instead of duplicating it.
 */

export const POINTER_SENTENCE = "This file is not the full rulebook.";

/** Shared pointer body used by the plain-markdown / plain-text adapters. */
function pointerBody(tool: string, dir: string): string[] {
  return [
    POINTER_SENTENCE,
    "",
    `${tool} should load the canonical, tool-agnostic context in \`${dir}/\`.`,
    "",
    `Start at \`${dir}/INDEX.md\`, then load only what the task needs:`,
    `- \`${dir}/architecture.md\` — system shape and boundaries.`,
    `- \`${dir}/conventions.md\` — coding style, naming, testing, commits.`,
    `- \`${dir}/tasks.md\` — active work and decisions.`,
    `- \`${dir}/skills/\` — focused playbooks; load one only when it applies.`,
    "",
    `Edit guidance in \`${dir}/\`, not here — this pointer is generated.`,
  ];
}

/** `CLAUDE.md` — Claude Code's entry file. */
export function claudeAdapter(dir: string): string {
  return lines("# Project context", "", pointerBody("Claude Code", dir));
}

/** `AGENTS.md` — the cross-tool agent convention. */
export function agentsAdapter(dir: string): string {
  return lines("# Agent context", "", pointerBody("Coding agents", dir));
}

/** `.windsurfrules` — Windsurf's plain-text rules file. */
export function windsurfAdapter(dir: string): string {
  return lines(pointerBody("Windsurf", dir));
}

/** `.github/copilot-instructions.md` — GitHub Copilot's repo instructions. */
export function copilotAdapter(dir: string): string {
  return lines("# Copilot instructions", "", pointerBody("GitHub Copilot", dir));
}

/**
 * `.cursor/rules/00-index.mdc` — Cursor's MDC rule. Uses YAML frontmatter
 * (`alwaysApply: true`, `globs: ["**\/*"]`) so the pointer is in scope for every
 * file Cursor touches.
 */
export function cursorAdapter(dir: string): string {
  return lines(
    frontmatter({
      description: `Routes to the canonical context in ${dir}/`,
      globs: ["**/*"],
      alwaysApply: true,
    }),
    "",
    POINTER_SENTENCE,
    "",
    `Load the canonical, tool-agnostic context in \`${dir}/\`, starting at`,
    `\`${dir}/INDEX.md\`. It routes to architecture, conventions, tasks, and`,
    "skills. Edit guidance there, not in this generated pointer.",
  );
}
