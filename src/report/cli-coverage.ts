import { existsSync } from "node:fs";
import { join } from "node:path";
import { SHARED_MARKER, sharedCanonicalBlockBody } from "../bootstrap-ai/canon.js";
import { readAihConfig } from "../config/marker.js";
import { detectClisByConfig, homeDir } from "../internals/cli-detect.js";
import { entry } from "../internals/cli-registry.js";
import { type Cli, resolveClis, SUPPORTED_CLIS } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
import { extractManagedBlock } from "../internals/markers.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { isExternalMcp, mcpConfigAbs, tomlServerCount } from "../mcp/render.js";
import { staleAdvisory, stalePruneSet } from "../prune/detect.js";
import { type CliLoadability, loadabilityFor, loadReason } from "./cli-loadability.js";
import { remediationBlock } from "./render.js";

/**
 * PER-CLI WIRING — the truth model behind "AI CLI coverage". The legacy surfaces
 * ask ONE global, Claude-shaped question (`.mcp.json` exists? `CLAUDE.md` exists?)
 * and so lie for every other tool. This scores each TARGETED CLI on its own terms,
 * derived entirely from the single {@link entry} registry (bootloader file(s), MCP
 * config path/key/support level, settings file), so it can never drift from what
 * `aih bootstrap-ai` / `aih mcp` actually write.
 *
 * Four cell states, three of which the legacy boolean conflated:
 *  - `wired`   — the tool's own artifact exists AND carries the expected content;
 *  - `missing` — aih can write it, but it isn't there (a real gap → graded);
 *  - `manual`  — aih intentionally does NOT write it (`fallback` MCP: TOML,
 *                a global path, or a different server shape) — guidance only, so
 *                file existence is not a fair signal → NOT graded;
 *  - `na`      — the tool has no such capability (e.g. settings for non-Claude).
 *
 * Scoring counts only `wired`+`missing` cells across TARGETED rows, so a Kiro-only
 * repo scores 100 when Kiro is wired — never docked for a `.mcp.json`/Claude file
 * it doesn't use. Pure fs reads (existsSync / read) — no spawn, no network.
 */

/** A capability cell's state. `manual`/`na` are excluded from the graded score. */
export type CellState = "wired" | "missing" | "manual" | "na";

export interface CliCell {
  state: CellState;
  /** The file this capability lives in (registry-derived), when one applies. */
  path?: string;
  /** Human one-liner: how it loads / why manual / why n/a. */
  detail: string;
  /** Exact `aih …` command to close a `missing`/`manual` gap, when one applies. */
  fix?: string;
  /** MCP-cell only: is the config repo-committed (portable, team-shared) or a global ~/home file? */
  scope?: "repo" | "global";
  /** MCP-cell only: configured server count (a `~/.codex` global with 16 ≠ a repo `.mcp.json` with 5). */
  count?: number;
}

export interface CliCoverageRow {
  cli: Cli;
  label: string;
  /** True when this CLI is in the resolved target set (graded); else a muted row. */
  targeted: boolean;
  bootloader: CliCell;
  mcp: CliCell;
  settings: CliCell;
  /** Will the (present) bootloader actually load + route to canon? (Phase 1.5) */
  load: CliLoadability;
}

/** Which arm of the target-resolution precedence won — surfaced to the user. */
export type TargetSource = "marker" | "ctx" | "flag" | "detect" | "wired" | "default-claude";

export interface CliCoverageModel {
  /** Targeted rows first (canonical order), then installed-but-untargeted ones. */
  rows: CliCoverageRow[];
  targeted: Cli[];
  targetSource: TargetSource;
  /** % of GRADEABLE (wired|missing) cells across TARGETED rows that are wired. */
  score: number;
  /** Targeted CLIs with NO `missing` cell (manual/na/wired all count as ok). */
  structurallyConfigured: number;
  /** Targeted CLIs that are structurallyConfigured AND proven to load (`loads`). */
  provenLoadable: number;
  totalTargeted: number;
}

const VALID = new Set<string>(SUPPORTED_CLIS);

function isWorkspaceRoot(ctx: PlanContext): boolean {
  const raw = readIfExists(join(ctx.root, ".aih-workspace.json"));
  if (raw === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { workspaceType?: unknown }).workspaceType === "multi-repo" &&
      (parsed as { generatedBy?: unknown }).generatedBy === "aih workspace"
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the target CLI set AND where it came from — marker-authoritative, the
 * same precedence `doctor` honors. The committed `.aih-config.json` wins so a
 * fresh clone reports against the tools the repo was bootstrapped for, not the
 * Claude default; `targetSource` lets the report distinguish a real gap from a
 * row that only exists because nothing was targeted (`default-claude`).
 */
export function resolveTargetSet(ctx: PlanContext): { targeted: Cli[]; source: TargetSource } {
  const marker = (readAihConfig(ctx.root)?.targets ?? []).filter((t): t is Cli => VALID.has(t));
  if (marker.length > 0) return { targeted: marker, source: "marker" };
  if (ctx.targets && ctx.targets.length > 0) return { targeted: ctx.targets, source: "ctx" };
  const cli = ctx.options.cli;
  if (typeof cli === "string" && cli.trim().length > 0) {
    return { targeted: resolveClis(ctx.options), source: "flag" };
  }
  if (ctx.options.detect === true) {
    const present = detectClisByConfig(ctx)
      .filter((p) => p.present)
      .map((p) => p.cli);
    if (present.length > 0) return { targeted: present, source: "detect" };
  }
  // No marker/ctx/flag/detect — but the repo may already be wired by the improved
  // install default (`aih bootstrap-ai` with no flags targets every RUNNABLE CLI).
  // Infer that set from the per-CLI adapter notes on disk: aih writes exactly one
  // `<contextDir>/adapters/<cli>.md` per targeted CLI, so it disambiguates tools that
  // SHARE a bootloader (codex and opencode both use AGENTS.md). Pure fs — the scan
  // stays spawn-free — so the report grades every wired CLI instead of the claude default.
  const wired = SUPPORTED_CLIS.filter((c) =>
    existsSync(join(ctx.root, ctx.contextDir, "adapters", `${c}.md`)),
  );
  if (wired.length > 0) return { targeted: wired, source: "wired" };
  return { targeted: ["claude"], source: "default-claude" };
}

function workspaceBootloaderCell(ctx: PlanContext, cli: Cli): CliCell {
  const paths = entry(cli).bootloaders;
  const label = paths.join(" + ");
  const missing = paths.filter((rel) => readIfExists(join(ctx.root, rel)) === undefined);
  if (missing.length > 0) {
    return {
      state: "missing",
      path: label,
      detail: `not found: ${missing.join(", ")}`,
      fix: "aih workspace --apply --git",
    };
  }

  const workspaceDocs = [
    `${ctx.contextDir}/cross-repo-architecture.md`,
    `${ctx.contextDir}/repo-discipline.md`,
  ];
  const missingTargets = workspaceDocs.filter((rel) => !existsSync(join(ctx.root, rel)));
  if (missingTargets.length > 0) {
    return {
      state: "missing",
      path: label,
      detail: `workspace target missing: ${missingTargets.join(", ")}`,
      fix: "aih workspace --apply --git",
    };
  }

  const missingPointers = paths.flatMap((rel) => {
    const text = readIfExists(join(ctx.root, rel)) ?? "";
    return workspaceDocs
      .filter((docPath) => !text.includes(docPath))
      .map((docPath) => `${rel} -> ${docPath}`);
  });
  if (missingPointers.length > 0) {
    return {
      state: "missing",
      path: label,
      detail: `workspace doc pointer missing: ${missingPointers.join(", ")}`,
      fix: "aih workspace --apply --git",
    };
  }

  return {
    state: "wired",
    path: label,
    detail: `auto-loads ${label}; workspace docs reachable`,
  };
}

/** Bootloader cell: every declared bootloader present, in-sync, and routing to the router. */
function bootloaderCell(ctx: PlanContext, cli: Cli): CliCell {
  if (isWorkspaceRoot(ctx)) return workspaceBootloaderCell(ctx, cli);

  const paths = entry(cli).bootloaders;
  const label = paths.join(" + ");
  const sharedBody = sharedCanonicalBlockBody(ctx.contextDir).trim();
  const missing: string[] = [];
  const drifted: string[] = [];
  const noRouter: string[] = [];
  for (const rel of paths) {
    const text = readIfExists(join(ctx.root, rel));
    if (text === undefined) {
      missing.push(rel);
      continue;
    }
    if (extractManagedBlock(text, SHARED_MARKER) !== sharedBody) drifted.push(rel);
    if (!text.includes("RULE_ROUTER.md")) noRouter.push(rel);
  }
  if (missing.length === 0 && drifted.length === 0 && noRouter.length === 0) {
    return { state: "wired", path: label, detail: `auto-loads ${label}; shared block in sync` };
  }
  const why =
    missing.length > 0
      ? `not found: ${missing.join(", ")}`
      : drifted.length > 0
        ? `shared block drifted: ${drifted.join(", ")}`
        : `no RULE_ROUTER pointer: ${noRouter.join(", ")}`;
  return {
    state: "missing",
    path: label,
    detail: why,
    fix: `aih bootstrap-ai --apply --cli ${cli}`,
  };
}

/** Count servers under `key` in an MCP JSON file (0 on parse error / wrong shape). */
function serverCount(raw: string, key: string): number {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return 0;
    const map = (parsed as Record<string, unknown>)[key];
    return typeof map === "object" && map !== null ? Object.keys(map).length : 0;
  } catch {
    return 0;
  }
}

/**
 * MCP cell. Native (aih-written) tools are content-checked: the config file exists
 * AND its server map is non-empty — a `{}` JSON or a server-less TOML is `missing`,
 * not `wired`. The check follows the registry shape: TOML (Codex) counts
 * `[mcp_servers.*]` tables, JSON counts the keys under `configKey`. A `~/home` path
 * is read at its expanded absolute location (the config a global tool actually reads),
 * with the cell annotated `global`. Tools aih still can't render are `manual` (amber,
 * never graded). Pure fs reads.
 */
function mcpCell(ctx: PlanContext, cli: Cli): CliCell {
  const e = entry(cli);
  const m = e.mcp;
  if (m.support === "absent" || !m.configPath || !m.configKey) {
    return { state: "na", detail: `${e.label} exposes no MCP server config` };
  }
  if (m.support !== "native") {
    const repoRelative = !isExternalMcp(m.configPath);
    const annot = repoRelative
      ? existsSync(join(ctx.root, m.configPath))
        ? `${m.configPath} present`
        : `${m.configPath} not found`
      : `global ${m.configPath}`;
    return {
      state: "manual",
      path: m.configPath,
      detail: `manual — ${annot} (${m.configFormat}; aih emits guidance, does not own this shape)`,
      fix: `aih mcp --cli ${cli}`,
    };
  }
  const external = isExternalMcp(m.configPath);
  const abs = external ? mcpConfigAbs(homeDir(ctx), m.configPath) : join(ctx.root, m.configPath);
  const scopeNote = external ? " (global)" : "";
  const scope: "repo" | "global" = external ? "global" : "repo";
  const raw = readIfExists(abs);
  if (raw === undefined) {
    return {
      state: "missing",
      path: m.configPath,
      detail: `${m.configPath}${scopeNote} not found`,
      fix: `aih mcp --apply --cli ${cli}`,
      scope,
      count: 0,
    };
  }
  const n = m.configFormat === "toml" ? tomlServerCount(raw) : serverCount(raw, m.configKey);
  const unit = m.configFormat === "toml" ? "[mcp_servers.*]" : `\`${m.configKey}\``;
  return n > 0
    ? {
        state: "wired",
        path: m.configPath,
        detail: `${n} server(s) under ${unit}${scopeNote}`,
        scope,
        count: n,
      }
    : {
        state: "missing",
        path: m.configPath,
        detail: `present but no servers under ${unit}`,
        fix: `aih mcp --apply --cli ${cli}`,
        scope,
        count: 0,
      };
}

/** Settings cell: only tools with a registry `settings` profile are gradeable. */
function settingsCell(ctx: PlanContext, cli: Cli): CliCell {
  const e = entry(cli);
  const s = e.settings;
  if (!s) return { state: "na", detail: `${e.label} has no aih-managed settings file` };
  if (isWorkspaceRoot(ctx)) {
    return {
      state: "na",
      detail: `${e.label} workspace parent uses the bridge repo; child repos own per-repo settings`,
    };
  }
  if (!s.writable) {
    return { state: "manual", path: s.configPath, detail: `manual — ${s.configPath}` };
  }
  return existsSync(join(ctx.root, s.configPath))
    ? { state: "wired", path: s.configPath, detail: `${s.configPath} present` }
    : {
        state: "missing",
        path: s.configPath,
        detail: `${s.configPath} not found`,
        fix: "aih bootstrap --apply",
      };
}

function buildRow(ctx: PlanContext, cli: Cli, targeted: boolean): CliCoverageRow {
  return {
    cli,
    label: entry(cli).label,
    targeted,
    bootloader: bootloaderCell(ctx, cli),
    mcp: mcpCell(ctx, cli),
    settings: settingsCell(ctx, cli),
    load: loadabilityFor(ctx, cli),
  };
}

const cellsOf = (r: CliCoverageRow): CliCell[] => [r.bootloader, r.mcp, r.settings];

/**
 * Build the per-CLI coverage model: targeted rows first (canonical order), then
 * any installed-but-not-targeted CLIs as muted rows (so nothing on the machine is
 * hidden). Identical dry-run vs `--verify` — pure fs reads, no spawn/network.
 */
export function scanCliCoverage(ctx: PlanContext): CliCoverageModel {
  const { targeted, source } = resolveTargetSet(ctx);
  const targetedSet = new Set<Cli>(targeted);
  const installed = new Set<Cli>(
    detectClisByConfig(ctx)
      .filter((p) => p.present)
      .map((p) => p.cli),
  );
  const rows = [
    ...SUPPORTED_CLIS.filter((c) => targetedSet.has(c)).map((c) => buildRow(ctx, c, true)),
    ...SUPPORTED_CLIS.filter((c) => installed.has(c) && !targetedSet.has(c)).map((c) =>
      buildRow(ctx, c, false),
    ),
  ];
  const targetedRows = rows.filter((r) => r.targeted);
  const gradeable = targetedRows
    .flatMap(cellsOf)
    .filter((c) => c.state === "wired" || c.state === "missing");
  const wired = gradeable.filter((c) => c.state === "wired").length;
  const score = gradeable.length === 0 ? 0 : Math.round((wired / gradeable.length) * 100);
  const structurallyConfigured = targetedRows.filter((r) =>
    cellsOf(r).every((c) => c.state !== "missing"),
  ).length;
  // Proven loadable = configured AND the bootloader is proven to load (D8): an
  // `unverified` load never counts toward this stricter number.
  const provenLoadable = targetedRows.filter(
    (r) => cellsOf(r).every((c) => c.state !== "missing") && r.load.verdict === "loads",
  ).length;
  return {
    rows,
    targeted,
    targetSource: source,
    score,
    structurallyConfigured,
    provenLoadable,
    totalTargeted: targeted.length,
  };
}

// ---- rendering ------------------------------------------------------------

const GLYPH: Record<CellState, string> = { wired: "✓", missing: "✗", manual: "◐", na: "—" };
const LOAD_GLYPH: Record<CliLoadability["verdict"], string> = {
  loads: "✓",
  wontLoad: "✗",
  unverified: "—",
};

const SOURCE_LABEL: Record<TargetSource, string> = {
  marker: ".aih-config.json",
  ctx: "init orchestrator",
  flag: "--cli flag",
  detect: "--detect",
  wired: "wired adapters on disk (no marker)",
  "default-claude": "default (claude — none targeted)",
};

function rowLine(r: CliCoverageRow): string {
  const overall = cellsOf(r).some((c) => c.state === "missing") ? "✗" : "✓";
  const lead = r.targeted ? overall : "·";
  return `  ${lead} ${r.cli.padEnd(12)} boot ${GLYPH[r.bootloader.state]}  mcp ${GLYPH[r.mcp.state]}  set ${GLYPH[r.settings.state]}  loads ${LOAD_GLYPH[r.load.verdict]}`;
}

/** Per-targeted-CLI remediation: missing cells AND any won't-load verdict, as
 * `{command, label}` pairs so {@link remediationBlock} can print copy-pasteable lines. */
function gapsFor(r: CliCoverageRow): Array<{ command: string; label: string }> {
  const out: Array<{ command: string; label: string }> = cellsOf(r)
    .filter((c) => c.state === "missing" && c.fix !== undefined)
    .map((c) => ({ command: c.fix as string, label: r.cli as string }));
  if (r.load.verdict === "wontLoad" && r.load.fix) {
    out.push({ command: r.load.fix, label: `${r.cli} won't load — ${loadReason(r.load)}` });
  }
  return out;
}

/** Terminal/markdown body: a compact per-CLI matrix + a remediation list. */
export function renderCliCoverage(model: CliCoverageModel): string {
  const targeted = model.rows.filter((r) => r.targeted);
  const other = model.rows.filter((r) => !r.targeted);
  const fixes = targeted.flatMap(gapsFor);
  return lines(
    "Per-CLI wiring for the tools this repo targets — a present file is not proof",
    "the CLI loads it; the loads column proves activation + the router chain resolve.",
    `Target source: ${SOURCE_LABEL[model.targetSource]}.`,
    "",
    "  legend: ✓ wired  ✗ missing  ◐ manual (guidance only)  — n/a   ·   cols: boot · mcp · set · loads",
    "",
    `  TARGETED — ${model.structurallyConfigured}/${model.totalTargeted} configured, ${model.provenLoadable}/${model.totalTargeted} proven loadable`,
    ...targeted.map(rowLine),
    ...(other.length > 0 ? ["", "  ALSO INSTALLED (not targeted)", ...other.map(rowLine)] : []),
    "",
    ...(fixes.length > 0
      ? remediationBlock("  To close the gaps — copy any line:", fixes)
      : ["  All targeted tools configured and proven loadable."]),
  );
}

/**
 * The "AI CLI wiring" digest — per-CLI bootloader/MCP/settings truth, scoped to
 * the targeted set. The stable `AI CLI wiring` describe prefix routes it to the
 * dashboard matrix panel. Always returns a digest (never undefined): a repo with
 * no marker still has a `default-claude` target to report against.
 */
export function cliCoverageDigest(ctx: PlanContext): DigestAction {
  const model = scanCliCoverage(ctx);
  // A repo can carry per-CLI artifacts for a tool it no longer targets (dropped from
  // the marker). Surface that as a non-blocking advisory beneath the matrix, pointing
  // at `aih prune` — computed read-only from the committed target set (never a guess).
  const stale = stalePruneSet(ctx);
  const advisory = staleAdvisory(stale);
  const body = advisory ? `${renderCliCoverage(model)}\n${advisory}` : renderCliCoverage(model);
  return digest(
    `AI CLI wiring — ${model.structurallyConfigured} of ${model.totalTargeted} configured, ${model.provenLoadable} loadable`,
    body,
    { ...model, stale },
  );
}
