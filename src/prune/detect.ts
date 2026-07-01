import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readAihConfig } from "../config/marker.js";
import { bootloadersFor, entry } from "../internals/cli-registry.js";
import { type Cli, SUPPORTED_CLIS } from "../internals/clis.js";
import type { PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { isExternalMcp } from "../mcp/render.js";

/**
 * STALE PER-CLI ARTIFACTS — the read-only detection behind `aih prune`. When a repo
 * was bootstrapped for CLIs [A, B, C] but is now targeted at only [A], the per-CLI
 * files aih wrote for B and C are stale. This finds exactly those, safely, so the
 * preview (and, later, the removal) never touches a still-targeted tool or a file
 * aih doesn't own.
 *
 * Two things make it trustworthy:
 *
 *  1. It diffs against COMMITTED INTENT only — the `.aih-config.json` marker targets
 *     (or an `aih init` orchestrator's threaded {@link PlanContext.targets}). The
 *     report's other target-inference arms (`--cli`, `--detect`, wired-adapters,
 *     default-claude) are heuristics; using a GUESS to decide what to DELETE could
 *     remove a real on-disk CLI's canon. No committed target set → nothing is stale
 *     (prune's own explicit selection is the escape hatch, not inference).
 *
 *  2. It classifies each artifact by DISPOSITION — set by whether aih can prove
 *     ownership of what it would touch (how `bootstrap-ai`/`mcp` write it):
 *       - `file`     — aih writes the WHOLE file and overwrites it every run (the
 *                      per-CLI adapter note, Kiro's steering/hook extras). aih owns
 *                      it outright → `aih prune --apply` MOVES it to `.aih/legacy/`.
 *       - `block`    — aih merges a marker-FENCED block into a co-owned file (a
 *                      bootloader = preamble + `<!-- BEGIN/END ai-canonical:shared -->`
 *                      block). The fence proves ownership → `--apply` SUBTRACTS aih's
 *                      block in place and leaves the rest; the file is never deleted.
 *       - `advisory` — a co-owned file where aih's part CANNOT be identified on disk
 *                      (repo MCP JSON + `.claude/settings.json` hooks: aih's servers /
 *                      hooks are plain sibling keys, indistinguishable from the user's,
 *                      names may collide). Auto-editing risks user data → `--apply`
 *                      only PRINTS what to remove by hand; it never modifies the file.
 *
 * Shared artifacts (AGENTS.md is one bootloader for five CLIs) are pruned only when
 * EVERY declaring CLI is dropped — the diff subtracts the kept set's paths first.
 * Global `~/…` MCP configs are structurally excluded (never repo-scoped). Pure fs
 * reads (existsSync / readdirSync) — no spawn, no network — so it is identical
 * dry-run vs `--verify`.
 */

/** How aih would remove an artifact — see the module header. */
export type PruneDisposition = "file" | "block" | "advisory";

/** Which kind of per-CLI artifact this is (drives the preview grouping + copy). */
export type PruneArtifactKind =
  | "adapter"
  | "bootloader"
  | "mcp"
  | "settings"
  | "kiro-steering"
  | "kiro-hook";

export interface PruneArtifact {
  kind: PruneArtifactKind;
  /** Repo-relative path (POSIX separators) prune would act on. */
  path: string;
  disposition: PruneDisposition;
  /** The dropped CLI(s) this artifact belongs to (a shared bootloader lists all). */
  clis: Cli[];
}

/** Where the authoritative "kept" set came from — committed intent, or none. */
export type KeptSource = "marker" | "ctx" | "none";

export interface StalePruneSet {
  /** The committed target set that is KEPT (empty when there is no committed intent). */
  targeted: Cli[];
  source: KeptSource;
  /** CLIs with a per-CLI adapter on disk but no longer in the committed targets. */
  dropped: Cli[];
  /** The subset of `dropped` that is only there because of `--unrunnable` (still in
   * the committed targets, but no binary on PATH). Empty on every default run. */
  unrunnable: Cli[];
  /** Marker target strings aih does not recognize (after case-normalization). Non-empty
   * FAILS CLOSED: no artifact is treated as stale until the marker is fixed, because a
   * typo'd kept target would otherwise be pruned as if it were dropped. */
  unknownTargets: string[];
  /** The concrete stale artifacts, in canonical (kind, then declared) order. */
  artifacts: PruneArtifact[];
}

const VALID = new Set<string>(SUPPORTED_CLIS);
const isCli = (s: string): s is Cli => VALID.has(s);

/**
 * The committed "kept" target set + its source. Marker targets win (a fresh clone
 * reads the intent the repo was bootstrapped with); an orchestrator's threaded
 * targets are the second authoritative source. Anything else → `none` (no intent
 * to diff, so nothing is treated as stale).
 *
 * Marker entries are case-normalized before validation, and anything STILL
 * unrecognized is returned in `unknown` rather than silently filtered — for a
 * DESTRUCTIVE consumer, "the marker says `Codex` but aih only knows `codex`" must
 * fail closed (a typo'd kept target would otherwise be pruned as dropped).
 */
function keptTargets(ctx: PlanContext): { targeted: Cli[]; source: KeptSource; unknown: string[] } {
  const raw = (readAihConfig(ctx.root)?.targets ?? []).map((t) => t.trim().toLowerCase());
  const marker = raw.filter(isCli);
  const unknown = raw.filter((t) => t.length > 0 && !isCli(t));
  if (marker.length > 0 || unknown.length > 0)
    return { targeted: marker, source: "marker", unknown };
  if (ctx.targets && ctx.targets.length > 0) {
    return { targeted: [...ctx.targets], source: "ctx", unknown: [] };
  }
  return { targeted: [], source: "none", unknown: [] };
}

/**
 * CLIs bootstrapped into THIS repo. aih writes exactly one
 * `<contextDir>/adapters/<cli>.md` per targeted CLI, so the adapter note is the
 * 1:1, shared-bootloader-proof membership signal (codex + opencode both use
 * AGENTS.md — only the adapter disambiguates them). Same predicate the coverage
 * scan's wired-adapter fallback uses.
 */
function onDiskClis(ctx: PlanContext): Cli[] {
  return SUPPORTED_CLIS.filter((c) =>
    existsSync(join(ctx.root, ctx.contextDir, "adapters", `${c}.md`)),
  );
}

/** Repo-relative MCP config path, or undefined when absent or a GLOBAL `~/home` file
 * (global configs are never repo-scoped and so are never pruned). */
function repoMcpPath(cli: Cli): string | undefined {
  const m = entry(cli).mcp;
  if (!m.configPath || isExternalMcp(m.configPath)) return undefined;
  return m.configPath;
}

const settingsPath = (cli: Cli): string | undefined => entry(cli).settings?.configPath;

/** Repo-relative paths a still-targeted CLI depends on — a shared artifact survives
 * while ANY kept CLI needs it (the shared-bootloader rule). */
function keptPaths(targeted: readonly Cli[]): Set<string> {
  const kept = new Set<string>(bootloadersFor(targeted));
  for (const c of targeted) {
    const mcp = repoMcpPath(c);
    if (mcp) kept.add(mcp);
    const set = settingsPath(c);
    if (set) kept.add(set);
  }
  return kept;
}

/**
 * aih-GENERATED Kiro hook files only. aih namespaces every hook it writes with an
 * `aih-` prefix precisely so it never clashes with ECC's or the team's own hooks
 * (src/kiro/content.ts `kiroHooks`), so that prefix is the ownership signal: a bare
 * `*.kiro.hook` glob would flag a user/team hook for removal. Written wholesale by
 * bootstrap-ai → `file` disposition.
 */
function kiroHookFiles(root: string): string[] {
  try {
    return readdirSync(join(root, ".kiro", "hooks"))
      .filter((n) => n.startsWith("aih-") && n.endsWith(".kiro.hook"))
      .sort()
      .map((n) => `.kiro/hooks/${n}`);
  } catch {
    return [];
  }
}

/**
 * The TARGETED CLIs (committed intent) that are wired into this repo but whose binary
 * is not on PATH — `aih prune --unrunnable`'s opt-in input. A CLI is unrunnable only
 * when NONE of its registry binaries resolve (`which`/`where`, the same read-only
 * PATH probe the readiness gate uses — allowlisted by the plan-purity guardrail).
 * Only targeted∩on-disk CLIs are probed: anything else has no artifacts to prune.
 * NEVER called on a default/`--stale` run or by the report ([prune-spec] locked:
 * a PATH problem — new shell, VDI — looks identical to a truly dropped CLI).
 */
export async function unrunnableTargets(ctx: PlanContext): Promise<Cli[]> {
  const { targeted, source } = keptTargets(ctx);
  if (source === "none") return [];
  const wired = new Set<Cli>(onDiskClis(ctx));
  const out: Cli[] = [];
  for (const cli of targeted) {
    if (!wired.has(cli)) continue;
    // FAIL SAFE, not fail open: only a probe that RAN and answered "not found"
    // (clean non-zero exit) is evidence of absence. A spawnError means the probe
    // infrastructure itself broke (`which`/`where` missing or blocked) — that is
    // "unknown", and an unknown CLI must be treated as RUNNABLE, never pruned.
    let runnable = false;
    for (const bin of entry(cli).binaries) {
      const argv = ctx.host.platform === "windows" ? ["where", bin] : ["which", bin];
      const res = await ctx.run(argv);
      if (res.spawnError || (res.code === 0 && res.stdout.trim().length > 0)) {
        runnable = true;
        break;
      }
    }
    if (!runnable) out.push(cli);
  }
  return out;
}

/**
 * Compute the stale prune set for a repo — read-only. Returns an empty `dropped`
 * (and `artifacts`) whenever there is no committed target set to diff against, so a
 * pre-marker repo is never told it has "stale" files it in fact still uses.
 * `treatAsDropped` (prune `--unrunnable` only) removes those CLIs from the kept set
 * before the diff — which also lets a shared bootloader fall out once its LAST kept
 * sharer is treated as dropped. The committed marker itself is never rewritten.
 */
export function stalePruneSet(
  ctx: PlanContext,
  opts: { treatAsDropped?: readonly Cli[] } = {},
): StalePruneSet {
  const { targeted: committed, source, unknown } = keptTargets(ctx);
  if (source === "none") {
    return {
      targeted: committed,
      source,
      dropped: [],
      unrunnable: [],
      unknownTargets: [],
      artifacts: [],
    };
  }
  // FAIL CLOSED on unrecognized marker targets: "Codex"/"codx" may be a typo of a
  // CLI the user means to KEEP — pruning anything under that ambiguity risks
  // deleting a kept CLI's artifacts. Surface the strings; remove nothing.
  if (unknown.length > 0) {
    return {
      targeted: committed,
      source,
      dropped: [],
      unrunnable: [],
      unknownTargets: unknown,
      artifacts: [],
    };
  }

  const treatAsDropped = new Set<Cli>(opts.treatAsDropped ?? []);
  const targeted = committed.filter((c) => !treatAsDropped.has(c));
  const keptSet = new Set<Cli>(targeted);
  const dropped = onDiskClis(ctx).filter((c) => !keptSet.has(c));
  const unrunnable = dropped.filter((c) => treatAsDropped.has(c));
  if (dropped.length === 0) {
    return { targeted, source, dropped, unrunnable, unknownTargets: [], artifacts: [] };
  }

  const kept = keptPaths(targeted);
  const onDisk = (rel: string): boolean => existsSync(join(ctx.root, rel));
  const artifacts: PruneArtifact[] = [];

  // 1. Adapters — 1:1, aih-exclusive (overwritten each bootstrap) → file.
  for (const cli of dropped) {
    artifacts.push({
      kind: "adapter",
      path: `${ctx.contextDir}/adapters/${cli}.md`,
      disposition: "file",
      clis: [cli],
    });
  }

  // 2. Bootloaders — shared-diff: pruned only when EVERY declaring CLI is dropped.
  //    Merged into a possibly hand-edited file → block-subtract, never a raw delete.
  for (const rel of bootloadersFor(dropped)) {
    if (kept.has(rel) || !onDisk(rel)) continue;
    artifacts.push({
      kind: "bootloader",
      path: rel,
      disposition: "block",
      clis: dropped.filter((c) => entry(c).bootloaders.includes(rel)),
    });
  }

  // 3. Repo-scoped MCP configs — shared-diff (global ~/home excluded) → advisory.
  //    aih writes its servers as plain sibling keys (no marker), indistinguishable
  //    from user-added servers, so aih cannot safely subtract them — flag for manual
  //    review instead of auto-editing.
  for (const rel of [...new Set(dropped.map(repoMcpPath).filter((p): p is string => !!p))]) {
    if (kept.has(rel) || !onDisk(rel)) continue;
    artifacts.push({
      kind: "mcp",
      path: rel,
      disposition: "advisory",
      clis: dropped.filter((c) => repoMcpPath(c) === rel),
    });
  }

  // 4. Settings (Claude's .claude/settings.json today) — advisory. aih's hook block
  //    carries no marker (only a command-string heuristic), so auto-subtract is unsafe.
  for (const rel of [...new Set(dropped.map(settingsPath).filter((p): p is string => !!p))]) {
    if (kept.has(rel) || !onDisk(rel)) continue;
    artifacts.push({
      kind: "settings",
      path: rel,
      disposition: "advisory",
      clis: dropped.filter((c) => settingsPath(c) === rel),
    });
  }

  // 5. Kiro-native extras (aih-exclusive files) when Kiro is dropped.
  if (dropped.includes("kiro")) {
    const steering = ".kiro/steering/agent-tools.md";
    if (onDisk(steering)) {
      artifacts.push({
        kind: "kiro-steering",
        path: steering,
        disposition: "file",
        clis: ["kiro"],
      });
    }
    for (const hook of kiroHookFiles(ctx.root)) {
      artifacts.push({ kind: "kiro-hook", path: hook, disposition: "file", clis: ["kiro"] });
    }
  }

  return { targeted, source, dropped, unrunnable, unknownTargets: [], artifacts };
}

/**
 * A one-shot advisory line for the report's CLI-wiring digest, or undefined when
 * nothing is stale. Non-blocking (informational) and mirrors `aih adopt`'s
 * "aih leaves these untouched" voice — prune never removes anything without an
 * explicit run.
 */
export function staleAdvisory(set: StalePruneSet): string | undefined {
  if (set.artifacts.length === 0) return undefined;
  const n = set.artifacts.length;
  return lines(
    "",
    `  STALE — ${n} artifact${n === 1 ? "" : "s"} for ${set.dropped.length} dropped CLI(s) ` +
      `(${set.dropped.join(", ")}) no longer targeted.`,
    "  Preview what aih would prune:  aih prune   (aih leaves these untouched until you apply)",
  );
}
