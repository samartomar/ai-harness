import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SHARED_MARKER } from "../bootstrap-ai/canon.js";
import { readIfExists } from "../internals/fsxn.js";

/**
 * Read-only inventory of config a team already keeps at **CLI-native locations**
 * (`.claude/`, `.cursor/`, `.kiro/`, …) — the second dimension of `aih adopt`
 * (the first being the canonical `ai-coding/` shape in classify.ts). aih does NOT
 * own these formats and, per the owner's hard rule, NEVER auto-modifies them. This
 * module only LOOKS, so the user knows what exists and their AI agent has a map for
 * an opt-in migration. Root bootloaders (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`) are
 * intentionally excluded — those are classify.ts's job; reporting them here too
 * would double-count.
 *
 * Each artifact is classified by READING it (not by path), because a tool-native
 * file is often already a thin pointer to the canon (real example:
 * `ai-os-product/.cursorrules` and syntegris's `.claude/rules/*` bridge files):
 *
 *  - `pointer`            — references the canon (RULE_ROUTER / the context dir /
 *                           the shared marker) → already wired, leave alone.
 *  - `tool-owned-content` — rich content with no canon reference → an *import
 *                           candidate* (syntegris `.claude/agents`, `.claude/memory`).
 *  - `runtime-config`     — settings/launch/hooks → tool runtime, not canon.
 */

export type CliArtifactKind = "pointer" | "tool-owned-content" | "runtime-config";

export interface CliArtifact {
  /** Tool that owns this location (e.g. "claude", "cursor"). */
  cli: string;
  /** Repo-relative path (posix separators). */
  path: string;
  kind: CliArtifactKind;
  /** Human detail for the footprint panel (counts / pointer-vs-content). */
  detail: string;
}

export interface CliFootprint {
  artifacts: CliArtifact[];
  /** Count of `tool-owned-content` artifacts — the import candidates. */
  importCandidates: number;
}

type LocKind = "rule-file" | "rule-dir" | "content-dir" | "runtime";
interface Loc {
  cli: string;
  rel: string;
  kind: LocKind;
  label: string;
}

/**
 * Known tool-native locations. Excludes root bootloaders (handled by classify.ts).
 * `rule-*` entries are read to tell pointer from content; `content-dir`/`runtime`
 * are classified by location type alone.
 */
const LOCATIONS: Loc[] = [
  { cli: "claude", rel: ".claude/agents", kind: "content-dir", label: "agents" },
  { cli: "claude", rel: ".claude/commands", kind: "content-dir", label: "commands" },
  { cli: "claude", rel: ".claude/skills", kind: "content-dir", label: "skills" },
  { cli: "claude", rel: ".claude/rules", kind: "rule-dir", label: "rules" },
  { cli: "claude", rel: ".claude/memory", kind: "content-dir", label: "memory files" },
  { cli: "claude", rel: ".claude/settings.json", kind: "runtime", label: "settings" },
  { cli: "claude", rel: ".claude/settings.local.json", kind: "runtime", label: "local settings" },
  { cli: "claude", rel: ".claude/launch.json", kind: "runtime", label: "launch config" },
  { cli: "cursor", rel: ".cursorrules", kind: "rule-file", label: "cursorrules" },
  { cli: "cursor", rel: ".cursor/rules", kind: "rule-dir", label: "rules" },
  { cli: "kiro", rel: ".kiro/steering", kind: "rule-dir", label: "steering" },
  { cli: "kiro", rel: ".kiro/hooks", kind: "runtime", label: "hooks" },
  { cli: "kiro", rel: ".kiro/specs", kind: "content-dir", label: "specs" },
  { cli: "windsurf", rel: ".windsurfrules", kind: "rule-file", label: "windsurfrules" },
  { cli: "windsurf", rel: ".windsurf/rules", kind: "rule-dir", label: "rules" },
  {
    cli: "copilot",
    rel: ".github/copilot-instructions.md",
    kind: "rule-file",
    label: "copilot instructions",
  },
  { cli: "copilot", rel: ".github/instructions", kind: "rule-dir", label: "instructions" },
  { cli: "copilot", rel: ".github/prompts", kind: "content-dir", label: "prompts" },
  { cli: "codex", rel: ".codex", kind: "content-dir", label: "codex config" },
  { cli: "gemini", rel: ".gemini", kind: "content-dir", label: "gemini config" },
];

/** Does this file delegate to the canon (so it's a pointer, not content)? */
function referencesCanon(text: string, contextDir: string): boolean {
  return (
    text.includes("RULE_ROUTER") || text.includes(`${contextDir}/`) || text.includes(SHARED_MARKER)
  );
}

/** Recursive file walk that tolerates Node 20.x (no reliance on Dirent.parentPath). */
function walkFiles(dir: string): string[] {
  let ents: Dirent[];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of ents) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Classify one rule FILE: pointer when it references the canon, else content. */
function classifyRuleFile(loc: Loc, full: string, contextDir: string): CliArtifact | undefined {
  if (!isFile(full)) return undefined;
  const text = readIfExists(full) ?? "";
  return referencesCanon(text, contextDir)
    ? { cli: loc.cli, path: loc.rel, kind: "pointer", detail: `thin pointer → ${contextDir}/` }
    : {
        cli: loc.cli,
        path: loc.rel,
        kind: "tool-owned-content",
        detail: `${loc.label}: content with no canon reference`,
      };
}

/** Classify a rule DIR: pointer only if EVERY rule file references the canon. */
function classifyRuleDir(loc: Loc, full: string, contextDir: string): CliArtifact | undefined {
  if (!existsSync(full)) return undefined;
  const files = walkFiles(full);
  if (files.length === 0) return undefined;
  const wired = files.filter((f) => referencesCanon(readIfExists(f) ?? "", contextDir)).length;
  if (wired === files.length) {
    return {
      cli: loc.cli,
      path: loc.rel,
      kind: "pointer",
      detail: `${files.length} ${loc.label} → ${contextDir}/`,
    };
  }
  return {
    cli: loc.cli,
    path: loc.rel,
    kind: "tool-owned-content",
    detail: `${files.length} ${loc.label} (${wired} reference canon, ${files.length - wired} importable)`,
  };
}

function classifyContentDir(loc: Loc, full: string): CliArtifact | undefined {
  if (!existsSync(full)) return undefined;
  const count = walkFiles(full).length;
  if (count === 0) return undefined;
  return {
    cli: loc.cli,
    path: loc.rel,
    kind: "tool-owned-content",
    detail: `${count} ${loc.label} (tool-owned)`,
  };
}

function classifyRuntime(loc: Loc, full: string): CliArtifact | undefined {
  if (!isFile(full) && !existsSync(full)) return undefined;
  return {
    cli: loc.cli,
    path: loc.rel,
    kind: "runtime-config",
    detail: `${loc.label} — tool runtime (left as-is)`,
  };
}

/**
 * Inventory the repo's CLI-native config. Pure / read-only. `contextDir` is the
 * committed one when present (callers pass the same value classify uses).
 */
export function cliFootprint(root: string, contextDir: string): CliFootprint {
  const artifacts: CliArtifact[] = [];
  for (const loc of LOCATIONS) {
    const full = join(root, loc.rel);
    let a: CliArtifact | undefined;
    if (loc.kind === "rule-file") a = classifyRuleFile(loc, full, contextDir);
    else if (loc.kind === "rule-dir") a = classifyRuleDir(loc, full, contextDir);
    else if (loc.kind === "content-dir") a = classifyContentDir(loc, full);
    else a = classifyRuntime(loc, full);
    if (a) artifacts.push(a);
  }
  const importCandidates = artifacts.filter((a) => a.kind === "tool-owned-content").length;
  return { artifacts, importCandidates };
}
