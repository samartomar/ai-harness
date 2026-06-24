import { posix } from "node:path";
import type { Cli } from "../internals/clis.js";
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

/** `GEMINI.md` — Gemini CLI's entry file (also read by Antigravity-class tools). */
export function geminiAdapter(dir: string): string {
  return lines("# Gemini context", "", pointerBody("Gemini", dir));
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

/** One generated adapter file: its repo-relative path, contents, and label. */
export interface ScaffoldAdapter {
  path: string;
  contents: string;
  describe: string;
}

/**
 * The adapter file(s) to write for a set of target CLIs, deduped by path and
 * returned in selection order. Several CLIs (codex, antigravity, opencode, zed,
 * kimi) share the cross-tool `AGENTS.md` standard, so selecting any of them
 * writes `AGENTS.md` exactly once. Default selection (`["claude"]`) yields just
 * `CLAUDE.md` — the harness only drops adapters for the tools the user targets.
 */
export function adaptersForClis(clis: readonly Cli[], dir: string): ScaffoldAdapter[] {
  const byPath = new Map<string, ScaffoldAdapter>();
  const add = (a: ScaffoldAdapter): void => {
    if (!byPath.has(a.path)) byPath.set(a.path, a);
  };
  for (const cli of clis) {
    switch (cli) {
      case "claude":
        add({
          path: "CLAUDE.md",
          contents: claudeAdapter(dir),
          describe: "Claude Code pointer adapter",
        });
        break;
      case "cursor":
        add({
          path: posix.join(".cursor", "rules", "00-index.mdc"),
          contents: cursorAdapter(dir),
          describe: "Cursor MDC pointer adapter",
        });
        break;
      case "windsurf":
        add({
          path: ".windsurfrules",
          contents: windsurfAdapter(dir),
          describe: "Windsurf pointer adapter",
        });
        break;
      case "copilot":
        add({
          path: posix.join(".github", "copilot-instructions.md"),
          contents: copilotAdapter(dir),
          describe: "GitHub Copilot pointer adapter",
        });
        break;
      case "gemini":
        add({
          path: "GEMINI.md",
          contents: geminiAdapter(dir),
          describe: "Gemini CLI pointer adapter",
        });
        break;
      default:
        // codex, antigravity, opencode, zed, kimi — the cross-tool AGENTS.md standard.
        add({
          path: "AGENTS.md",
          contents: agentsAdapter(dir),
          describe: "AGENTS.md pointer adapter (codex/antigravity/opencode/zed/kimi)",
        });
    }
  }
  return [...byPath.values()];
}
