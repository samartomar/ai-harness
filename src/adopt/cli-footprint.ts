import { join } from "node:path";
import { SHARED_MARKER } from "../bootstrap-ai/canon.js";
import { safePathExists, safeReadText, safeWalkFiles } from "./source-files.js";

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

/**
 * The team-pollution sort (§13.6). Only `import` is ever a candidate / advisory:
 *  - `wired`    — references the canon (a pointer) → leave alone.
 *  - `personal` — tool-owned but NOT committed (untracked/gitignored) → one dev's
 *                 style; shown for awareness, never nagged, never pulled into canon.
 *  - `kept`     — tool-owned + committed but team-ACKNOWLEDGED as intentional.
 *  - `import`   — tool-owned + committed + un-acknowledged → the only candidate.
 *  - `runtime`  — settings/launch/hooks → tool runtime, not canon.
 */
export type CliDisposition = "wired" | "personal" | "kept" | "import" | "runtime";

export interface CliArtifact {
  /** Tool that owns this location (e.g. "claude", "cursor"). */
  cli: string;
  /** Repo-relative path (posix separators). */
  path: string;
  /** Structural classification (pointer / content / runtime). */
  kind: CliArtifactKind;
  /** The team-pollution sort that decides whether it's an import candidate. */
  disposition: CliDisposition;
  /** Human detail for the footprint panel (counts / pointer-vs-content). */
  detail: string;
}

/** Inputs that drive the idempotency guard — both read-only, both optional. */
export interface FootprintOptions {
  /**
   * Repo-relative paths git considers committed (from `gitCommittedSet`). Absent
   * (not a git repo / undetermined) → content is treated as shared, since we can't
   * prove it's a personal uncommitted file.
   */
  committed?: ReadonlySet<string>;
  /** Team-acknowledged tool-native paths (from `.aih-config.json` adopt.acknowledged). */
  acknowledged?: ReadonlySet<string>;
}

export interface CliFootprint {
  artifacts: CliArtifact[];
  /** Count of `import`-disposition artifacts — the only true import candidates. */
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

/** Internal scan context: the inputs every classifier needs. */
interface Fp {
  root: string;
  contextDir: string;
  committed?: ReadonlySet<string>;
  acknowledged?: ReadonlySet<string>;
}

/** Absolute → repo-relative POSIX path (for the committed-set membership check). */
function toRel(root: string, full: string): string {
  return full.slice(root.length).replace(/\\/g, "/").replace(/^\//, "");
}

/**
 * The team-pollution sort (§13.6) for tool-owned content. `relPaths` are the
 * repo-relative files the artifact covers (one for a file, many for a dir).
 *  - acknowledged          → `kept`
 *  - committed known + none of relPaths committed → `personal` (uncommitted = a dev's own)
 *  - else                  → `import` (the only candidate)
 */
function disposeToolOwned(path: string, relPaths: string[], fp: Fp): CliDisposition {
  if (fp.acknowledged?.has(path)) return "kept";
  if (fp.committed && !relPaths.some((r) => fp.committed?.has(r))) return "personal";
  return "import";
}

/** Classify one rule FILE: pointer when it references the canon, else content. */
function classifyRuleFile(loc: Loc, full: string, fp: Fp): CliArtifact | undefined {
  const text = safeReadText(fp.root, full);
  if (text === undefined) return undefined;
  if (referencesCanon(text, fp.contextDir)) {
    return {
      cli: loc.cli,
      path: loc.rel,
      kind: "pointer",
      disposition: "wired",
      detail: `thin pointer → ${fp.contextDir}/`,
    };
  }
  return {
    cli: loc.cli,
    path: loc.rel,
    kind: "tool-owned-content",
    disposition: disposeToolOwned(loc.rel, [loc.rel], fp),
    detail: `${loc.label}: content with no canon reference`,
  };
}

/** Classify a rule DIR: pointer only if EVERY rule file references the canon. */
function classifyRuleDir(loc: Loc, full: string, fp: Fp): CliArtifact | undefined {
  const files = safeWalkFiles(fp.root, full);
  if (files.length === 0) return undefined;
  const wired = files.filter((f) =>
    referencesCanon(safeReadText(fp.root, f) ?? "", fp.contextDir),
  ).length;
  if (wired === files.length) {
    return {
      cli: loc.cli,
      path: loc.rel,
      kind: "pointer",
      disposition: "wired",
      detail: `${files.length} ${loc.label} → ${fp.contextDir}/`,
    };
  }
  return {
    cli: loc.cli,
    path: loc.rel,
    kind: "tool-owned-content",
    disposition: disposeToolOwned(
      loc.rel,
      files.map((f) => toRel(fp.root, f)),
      fp,
    ),
    detail: `${files.length} ${loc.label} (${wired} reference canon, ${files.length - wired} importable)`,
  };
}

function classifyContentDir(loc: Loc, full: string, fp: Fp): CliArtifact | undefined {
  const files = safeWalkFiles(fp.root, full);
  if (files.length === 0) return undefined;
  return {
    cli: loc.cli,
    path: loc.rel,
    kind: "tool-owned-content",
    disposition: disposeToolOwned(
      loc.rel,
      files.map((f) => toRel(fp.root, f)),
      fp,
    ),
    detail: `${files.length} ${loc.label} (tool-owned)`,
  };
}

function classifyRuntime(loc: Loc, full: string, fp: Fp): CliArtifact | undefined {
  if (!safePathExists(fp.root, full)) return undefined;
  return {
    cli: loc.cli,
    path: loc.rel,
    kind: "runtime-config",
    disposition: "runtime",
    detail: `${loc.label} — tool runtime (left as-is)`,
  };
}

/**
 * Inventory the repo's CLI-native config. Pure / read-only. `contextDir` is the
 * committed one when present (callers pass the same value classify uses). `opts`
 * drives the team-pollution guard (§13.6): without `committed`, content is treated
 * as shared; with it, uncommitted tool-owned content is `personal` (silent) and
 * acknowledged paths are `kept` — so only NEW committed shared content is a candidate.
 */
export function cliFootprint(
  root: string,
  contextDir: string,
  opts: FootprintOptions = {},
): CliFootprint {
  const fp: Fp = { root, contextDir, committed: opts.committed, acknowledged: opts.acknowledged };
  const artifacts: CliArtifact[] = [];
  for (const loc of LOCATIONS) {
    const full = join(root, loc.rel);
    let a: CliArtifact | undefined;
    if (loc.kind === "rule-file") a = classifyRuleFile(loc, full, fp);
    else if (loc.kind === "rule-dir") a = classifyRuleDir(loc, full, fp);
    else if (loc.kind === "content-dir") a = classifyContentDir(loc, full, fp);
    else a = classifyRuntime(loc, full, fp);
    if (a) artifacts.push(a);
  }
  const importCandidates = artifacts.filter((a) => a.disposition === "import").length;
  return { artifacts, importCandidates };
}
