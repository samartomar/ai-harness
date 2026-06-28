import { type Dirent, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import { type Action, writeText } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { CliArtifact, CliFootprint } from "./cli-footprint.js";

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

/** Recursive file walk (absolute paths) tolerant of Node 20.x. */
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

function copyHeader(src: string): string {
  return `<!-- Migrated into the canon by \`aih adopt --migrate-cli\` from \`${src}\`. -->`;
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
    const content = readIfExists(srcAbs);
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
  for (const fileAbs of walkFiles(srcDirAbs)) {
    const rel = fileAbs.slice(srcDirAbs.length).replace(/\\/g, "/").replace(/^\//, "");
    const content = readIfExists(fileAbs);
    if (content === undefined) continue;
    const canonRel = posix.join(dir, spec.destSub, rel);
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
