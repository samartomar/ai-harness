import { join, posix, relative } from "node:path";
import { AihError } from "../errors.js";
import { type Action, writeText } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { CliArtifact, CliFootprint } from "./cli-footprint.js";
import { safeReadText, safeWalkFiles } from "./source-files.js";

/**
 * `aih adopt --migrate-cli` — the opt-in, content-verified migration of CLI-native
 * config INTO the canon (spec §13.4). This is the ONE place aih writes to a
 * tool-native location, so it is deliberately conservative:
 *
 *  - It acts ONLY on `import` candidates (committed + tool-owned + un-acknowledged —
 *    never `personal`, `kept`, `wired`, or `runtime`).
 *  - It COPIES content into the canon first (additive — only ever writes under the
 *    context dir, which aih owns); the copy IS the content-verification.
 *  - It pointer-converts ONLY single, unambiguous RULE FILES (`.cursorrules`,
 *    `.windsurfrules`, `.github/copilot-instructions.md`) — after their content is in
 *    the canon — and the executor backs the original up to `*.aih.bak`. It NEVER
 *    deletes or rewrites a content DIRECTORY (agents/skills/…): those are copied and
 *    the originals left for the user to retire.
 *  - `.claude/memory` (the dev's own notes) and ambiguous tool config (`.codex`,
 *    `.gemini`) are skipped — surfaced, never force-moved.
 *
 * Idempotent: a re-run re-writes byte-identical copies (executor → unchanged) and
 * skips a rule file that is already a pointer.
 */

type MigMode = "rule-file" | "dir" | "skip-memory" | "skip-toolcfg";
interface MigSpec {
  /** Canon sub-path under the context dir the content lands in. */
  destSub: string;
  mode: MigMode;
}

const RULE_DIR_SOURCE_PREFIX: Record<string, string> = {
  ".claude/rules": "from-claude",
  ".cursor/rules": "from-cursor",
  ".kiro/steering": "from-kiro",
  ".windsurf/rules": "from-windsurf",
  ".github/instructions": "from-copilot",
};

/** How each tool-native location migrates into the canon. Keyed by artifact path. */
const MIGRATION: Record<string, MigSpec> = {
  ".cursorrules": { destSub: "rules", mode: "rule-file" },
  ".windsurfrules": { destSub: "rules", mode: "rule-file" },
  ".github/copilot-instructions.md": { destSub: "rules", mode: "rule-file" },
  ".claude/rules": { destSub: "rules", mode: "dir" },
  ".cursor/rules": { destSub: "rules", mode: "dir" },
  ".kiro/steering": { destSub: "rules", mode: "dir" },
  ".windsurf/rules": { destSub: "rules", mode: "dir" },
  ".github/instructions": { destSub: "rules", mode: "dir" },
  ".claude/agents": { destSub: "agents", mode: "dir" },
  ".claude/commands": { destSub: "commands", mode: "dir" },
  ".claude/skills": { destSub: "skills", mode: "dir" },
  ".kiro/specs": { destSub: "specs", mode: "dir" },
  ".github/prompts": { destSub: "prompts", mode: "dir" },
  ".claude/memory": { destSub: "", mode: "skip-memory" },
  ".codex": { destSub: "", mode: "skip-toolcfg" },
  ".gemini": { destSub: "", mode: "skip-toolcfg" },
};

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/** `.cursorrules` → `from-cursorrules.md`; `.github/copilot-instructions.md` → `from-copilot-instructions.md`. */
function ruleFileName(srcPath: string): string {
  const base = baseName(srcPath).replace(/^\./, "");
  const stem = base.endsWith(".md") ? base.slice(0, -3) : base;
  return `from-${stem}.md`;
}

function copyHeader(src: string): string {
  return `<!-- Migrated into the canon by \`aih adopt --migrate-cli\` from \`${src}\`. -->`;
}

function dirDestSub(a: CliArtifact, spec: MigSpec): string {
  const sourcePrefix = RULE_DIR_SOURCE_PREFIX[a.path];
  return sourcePrefix === undefined ? spec.destSub : posix.join(spec.destSub, sourcePrefix);
}

function canonicalActionPath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function assertUniqueWritePaths(actions: readonly Action[]): void {
  const seen = new Map<string, string>();
  for (const action of actions) {
    if (action.kind !== "write") continue;
    const key = canonicalActionPath(action.path.replace(/\\/g, "/"));
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new AihError(
        `adopt --migrate-cli would write multiple migrated sources to ${action.path} (also ${prior})`,
        "AIH_CONFIG",
      );
    }
    seen.set(key, action.path);
  }
}

/** A thin pointer that replaces a migrated single rule file (its content is now in the canon). */
function pointerDoc(dir: string, canonRel: string): string {
  return lines(
    "# Bootloader — pointer",
    "",
    `Active rules live under \`${dir}/\`. This file was migrated by \`aih adopt --migrate-cli\`;`,
    `its content is now canonical in \`${canonRel}\`.`,
    "",
    `Read \`${dir}/RULE_ROUTER.md\` first, then \`${canonRel}\`.`,
  );
}

/** True when a rule file already delegates to the canon (so a re-run skips it). */
function isPointer(text: string, dir: string): boolean {
  return text.includes("RULE_ROUTER") || text.includes(`${dir}/`);
}

/**
 * Build the migration write actions for one import-candidate artifact. Returns the
 * additive canon copies plus, for a single rule file, the pointer-conversion of the
 * original (backed up by the executor). Dirs are copied, originals untouched.
 */
function migrateArtifact(root: string, dir: string, a: CliArtifact): Action[] {
  const spec = MIGRATION[a.path];
  if (!spec || spec.mode === "skip-memory" || spec.mode === "skip-toolcfg") return [];

  if (spec.mode === "rule-file") {
    const srcAbs = join(root, a.path);
    const content = safeReadText(root, srcAbs);
    if (content === undefined) return [];
    if (isPointer(content, dir)) return []; // already migrated — idempotent no-op
    const canonRel = posix.join(dir, spec.destSub, ruleFileName(a.path));
    return [
      writeText(
        canonRel,
        `${copyHeader(a.path)}\n\n${content.trimEnd()}\n`,
        `migrate ${a.path} → canon`,
      ),
      // Replace the original with a thin pointer; the executor backs it up to *.aih.bak.
      writeText(a.path, pointerDoc(dir, canonRel), `pointer-convert ${a.path} (backed up)`),
    ];
  }

  // dir: copy each file into the canon, preserving the sub-path; leave the originals.
  const out: Action[] = [];
  const srcDirAbs = join(root, a.path);
  const destSub = dirDestSub(a, spec);
  for (const fileAbs of safeWalkFiles(root, srcDirAbs)) {
    const rel = relative(srcDirAbs, fileAbs).replace(/\\/g, "/");
    const content = safeReadText(root, fileAbs);
    if (content === undefined) continue;
    const canonRel = posix.join(dir, destSub, rel);
    out.push(
      writeText(
        canonRel,
        `${copyHeader(`${a.path}/${rel}`)}\n\n${content.trimEnd()}\n`,
        `migrate ${a.path}/${rel} → canon`,
      ),
    );
  }
  return out;
}

/**
 * All `--migrate-cli` write actions for a repo. Acts only on `import` candidates;
 * everything else (personal/kept/wired/runtime + memory + tool config) is left
 * untouched by construction. Empty when there is nothing to migrate.
 */
export function migrateCliActions(
  root: string,
  footprint: CliFootprint,
  contextDir: string,
): Action[] {
  const out: Action[] = [];
  for (const a of footprint.artifacts) {
    if (a.disposition !== "import") continue;
    out.push(...migrateArtifact(root, contextDir, a));
  }
  assertUniqueWritePaths(out);
  return out;
}

/** Paths skipped on purpose under `--migrate-cli` (memory + tool config), for the digest note. */
export function migrateSkips(footprint: CliFootprint): string[] {
  const out: string[] = [];
  for (const a of footprint.artifacts) {
    if (a.disposition !== "import") continue;
    const spec = MIGRATION[a.path];
    if (spec && (spec.mode === "skip-memory" || spec.mode === "skip-toolcfg")) out.push(a.path);
  }
  return out;
}
