import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import { readIfExists } from "../../../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../../../internals/merge.js";
import { CLAUDE_MCP_KEY } from "./surfaces.js";

/**
 * Claude USER-scope contamination report (D13). Claude loads USER-scope surfaces
 * (`~/.claude/...`) into EVERY project, so a global framework install (a global
 * ECC install, a globally enabled plugin) contaminates all projects. This is the
 * pure, READ-ONLY scan that produces the conflict inventory a binding's doctor
 * consults: it turns the messy user scope into a countable leakage summary plus
 * per-surface detail rows.
 *
 * SCOPE. It reads ONLY under the injected `home` root (never the real `~`, never
 * the project root — a project-scope surface must never appear here). `projectRoot`
 * is part of the D13 report CONTEXT (W7 assembles the final label with both scopes),
 * but this user-scope scan deliberately never reads it.
 *
 * FAIL-OPEN, DELIBERATELY. A contamination report must still render on a broken
 * machine — that is its job. Malformed user-scope JSON (`settings.json`,
 * `~/.mcp.json`) is therefore NOT fatal: the unreadable file is recorded in
 * `warnings` and the scan counts every OTHER surface. This is a scoped exception
 * to fail-closed, justified because the module is read-only diagnostics; the
 * cleanup write paths that consume this report stay strictly fail-closed.
 */

/** The framework a surface is best-effort attributed to (never guessed beyond this vocabulary). */
export type FrameworkAttribution = "ecc" | "superpowers" | "gstack" | "gsd" | "unknown";

/** The countable user-scope surface kinds (one leakage counter each). */
export type ContaminationSurface = "skill" | "agent" | "hook" | "rule" | "plugin" | "mcpServer";

/** One detected user-scope surface row. */
export interface ContaminationEntry {
  surface: ContaminationSurface;
  /** The surface's identifying name (skill/rule dir, agent filename, plugin key, server id, hook event). */
  name: string;
  /** Home-relative POSIX path of the surface (the file/dir, or the JSON file a field lives in). */
  path: string;
  /** Best-effort framework tag; `unknown` when no token matches (never guessed further). */
  attribution: FrameworkAttribution;
  /**
   * For `surface: "hook"` only — the hook command string, so cleanup can target the
   * exact command for removal. Absent for every other surface.
   */
  command?: string;
}

/** The countable leakage summary ("N skills, N agents, N hooks, N rules, ..."). */
export interface ContaminationLeakage {
  skills: number;
  agents: number;
  hooks: number;
  rules: number;
  plugins: number;
  mcpServers: number;
}

export interface ClaudeContaminationReport {
  /** The countable summary — every field is 0 on a clean home. */
  leakage: ContaminationLeakage;
  /** Per-surface detail rows (one per counted surface instance). */
  entries: ContaminationEntry[];
  /** Informational context that is NOT leakage: `skillOverrides` keys from settings. */
  informational: { skillOverrides: string[] };
  /** Named unreadable user-scope files (malformed JSON) — the report still rendered. */
  warnings: string[];
  /** True only when every leakage count is 0. */
  clean: boolean;
  /** The D13 label decision INPUT (final label assembly is W7). */
  verdictInput: "clean" | "contaminated";
}

export interface ClaudeContaminationParams {
  /** The user's home root to scan (tests inject a mkdtemp home; NEVER the real `~`). */
  home: string;
  /** The project root — part of the D13 report context; the user-scope scan never reads it. */
  projectRoot: string;
}

/** The framework tokens matched (in priority order) against a surface's name/path. */
const FRAMEWORK_TOKENS: readonly Exclude<FrameworkAttribution, "unknown">[] = [
  "superpowers",
  "ecc",
  "gstack",
  "gsd",
];

/**
 * Best-effort framework attribution by case-insensitive SUBSTRING match over the
 * joined name/path parts. LIMITS: this is a substring heuristic, not provenance —
 * a surface whose name coincidentally contains a token is mis-tagged, and a
 * framework surface with no token in its name/path stays `unknown`. `unknown` is
 * never upgraded to a guess. Exact upstream names get pinned during W4's real runs.
 */
function attributeFramework(...parts: string[]): FrameworkAttribution {
  const hay = parts.join("/").toLowerCase();
  for (const token of FRAMEWORK_TOKENS) {
    if (hay.includes(token)) return token;
  }
  return "unknown";
}

/** `readdirSync(withFileTypes)` or `[]` when the directory is absent/unreadable. */
function listDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Read + parse a user-scope JSON file; record a warning and return undefined when malformed. */
function readUserJson(
  abs: string,
  label: string,
  warnings: string[],
): Record<string, unknown> | undefined {
  const raw = readIfExists(abs);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = parseJsoncText(raw);
  } catch {
    warnings.push(`unreadable user-scope JSON (skipped): ${label}`);
    return undefined;
  }
  return isPlainObject(parsed) ? parsed : undefined;
}

/**
 * Flatten Claude's `hooks` map into individual `{ event, command }` commands. Handles
 * the canonical nested shape (`{ Event: [ { matcher, hooks: [ { type, command } ] } ] }`)
 * and tolerates the flatter `{ Event: [ "cmd" ] }` / `{ Event: [ { command } ] }` shapes.
 */
function collectHookCommands(hooks: unknown): { event: string; command: string }[] {
  const out: { event: string; command: string }[] = [];
  if (!isPlainObject(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (typeof group === "string") {
        out.push({ event, command: group });
      } else if (isPlainObject(group) && Array.isArray(group.hooks)) {
        for (const inner of group.hooks) {
          if (typeof inner === "string") out.push({ event, command: inner });
          else if (isPlainObject(inner) && typeof inner.command === "string") {
            out.push({ event, command: inner.command });
          }
        }
      } else if (isPlainObject(group) && typeof group.command === "string") {
        out.push({ event, command: group.command });
      }
    }
  }
  return out;
}

export function claudeContaminationReport(
  params: ClaudeContaminationParams,
): ClaudeContaminationReport {
  const { home } = params;
  const claudeDir = join(home, ".claude");
  const entries: ContaminationEntry[] = [];
  const warnings: string[] = [];
  const skillOverrides: string[] = [];

  // Skills: each immediate subdirectory of ~/.claude/skills/ is ONE skill (nested
  // content is not double-counted).
  for (const dirent of listDir(join(claudeDir, "skills"))) {
    if (!dirent.isDirectory()) continue;
    entries.push({
      surface: "skill",
      name: dirent.name,
      path: `.claude/skills/${dirent.name}`,
      attribution: attributeFramework(dirent.name, `.claude/skills/${dirent.name}`),
    });
  }

  // Agents: each ~/.claude/agents/*.md markdown file.
  for (const dirent of listDir(join(claudeDir, "agents"))) {
    if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
    entries.push({
      surface: "agent",
      name: dirent.name,
      path: `.claude/agents/${dirent.name}`,
      attribution: attributeFramework(dirent.name, `.claude/agents/${dirent.name}`),
    });
  }

  // Rules: each top-level entry (dir or file) under ~/.claude/rules/.
  for (const dirent of listDir(join(claudeDir, "rules"))) {
    entries.push({
      surface: "rule",
      name: dirent.name,
      path: `.claude/rules/${dirent.name}`,
      attribution: attributeFramework(dirent.name, `.claude/rules/${dirent.name}`),
    });
  }

  // settings.json: hooks (per command), enabledPlugins keys, mcpServers keys, and
  // the informational skillOverrides keys.
  const settings = readUserJson(
    join(claudeDir, "settings.json"),
    ".claude/settings.json",
    warnings,
  );
  if (settings !== undefined) {
    for (const { event, command } of collectHookCommands(settings.hooks)) {
      entries.push({
        surface: "hook",
        name: event,
        path: ".claude/settings.json",
        attribution: attributeFramework(event, command),
        command,
      });
    }
    if (isPlainObject(settings.enabledPlugins)) {
      for (const key of Object.keys(settings.enabledPlugins)) {
        entries.push({
          surface: "plugin",
          name: key,
          path: ".claude/settings.json",
          attribution: attributeFramework(key),
        });
      }
    }
    if (isPlainObject(settings[CLAUDE_MCP_KEY])) {
      for (const key of Object.keys(settings[CLAUDE_MCP_KEY] as Record<string, unknown>)) {
        entries.push({
          surface: "mcpServer",
          name: key,
          path: ".claude/settings.json",
          attribution: attributeFramework(key),
        });
      }
    }
    if (isPlainObject(settings.skillOverrides)) {
      skillOverrides.push(...Object.keys(settings.skillOverrides));
    }
  }

  // ~/.mcp.json: user-scope MCP servers.
  const mcp = readUserJson(join(home, ".mcp.json"), ".mcp.json", warnings);
  if (mcp !== undefined && isPlainObject(mcp[CLAUDE_MCP_KEY])) {
    for (const key of Object.keys(mcp[CLAUDE_MCP_KEY] as Record<string, unknown>)) {
      entries.push({
        surface: "mcpServer",
        name: key,
        path: ".mcp.json",
        attribution: attributeFramework(key),
      });
    }
  }

  const leakage: ContaminationLeakage = {
    skills: count(entries, "skill"),
    agents: count(entries, "agent"),
    hooks: count(entries, "hook"),
    rules: count(entries, "rule"),
    plugins: count(entries, "plugin"),
    mcpServers: count(entries, "mcpServer"),
  };
  const clean = Object.values(leakage).every((n) => n === 0);

  return {
    leakage,
    entries,
    informational: { skillOverrides },
    warnings,
    clean,
    verdictInput: clean ? "clean" : "contaminated",
  };
}

function count(entries: readonly ContaminationEntry[], surface: ContaminationSurface): number {
  return entries.reduce((n, e) => (e.surface === surface ? n + 1 : n), 0);
}
