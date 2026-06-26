/**
 * Per-tool load-group token model for `aih report`.
 *
 * `scanContextBloat` sums EVERY bootloader (CLAUDE.md + AGENTS.md + GEMINI.md +
 * …) — but no single tool loads all of them: Claude loads only CLAUDE.md, Cursor
 * only its `.mdc`, Copilot only its instructions file. The real per-turn cost is
 * the heaviest single tool's bootloader bundle, not the union. This models that.
 *
 * Design lifted from @razroo/isolint's `cost.js groupByTool` (MIT) — but where
 * isolint GUESSES the file→tool map with regexes, aih reads the authoritative map
 * it already writes (`CLI_BOOTLOADERS` in bootstrap-ai/canon.ts), so the worst-case
 * is exact, not estimated. The `ai-coding/**` canon tree is loaded on demand via a
 * pointer (not auto-injected every turn), so it is reported as a separate bucket.
 */

import { CLI_BOOTLOADERS } from "../bootstrap-ai/canon.js";
import { type Cli, SUPPORTED_CLIS } from "../internals/clis.js";
import { type ContextFile, fileFootprint, type ScanOptions, scanContextBloat } from "./bloat.js";

/** One always-loaded-per-turn footprint: the bootloader files a set of tools share. */
export interface LoadGroup {
  /** Tools that load the same bootloader set (e.g. codex+opencode+zed+kimi → AGENTS.md). */
  clis: Cli[];
  /** The group's declared bootloader files (whether or not they exist on disk). */
  bootloaderPaths: string[];
  /** Human label, e.g. "codex, opencode, zed, kimi → AGENTS.md". */
  label: string;
  /** The group's bootloader files that EXIST on disk, sorted by path. */
  files: ContextFile[];
  tokens: number;
  bytes: number;
  /** Present iff ≥1 bootloader file exists. Absent groups are excluded from worst-case. */
  present: boolean;
}

export interface LoadGroupModel {
  /** All groups, sorted: present first, then by tokens desc, then label. */
  groups: LoadGroup[];
  /** The heaviest PRESENT group — the real per-turn worst case. */
  worst: LoadGroup | null;
  /** `worst.tokens`, or 0 when nothing is present. */
  worstTokens: number;
  budgetTokens: number;
  /** worstTokens > budgetTokens — the gate input (NOT the summed total). */
  overBudget: boolean;
  /** Canon tree + non-bootloader files loaded on demand via pointer (informational). */
  onDemandFiles: ContextFile[];
  onDemandTokens: number;
}

/** Group the supported CLIs by their (identical) bootloader file set, in canonical order. */
function groupClis(): Array<{ clis: Cli[]; paths: string[] }> {
  const byKey = new Map<string, Cli[]>();
  for (const cli of SUPPORTED_CLIS) {
    const key = CLI_BOOTLOADERS[cli].join("|");
    const arr = byKey.get(key);
    if (arr) arr.push(cli);
    else byKey.set(key, [cli]);
  }
  return [...byKey.entries()].map(([key, clis]) => ({ clis, paths: key.split("|") }));
}

/**
 * Build the per-tool load-group model: each tool group's existing bootloader
 * footprint, the heaviest present group (worst case), and the on-demand canon
 * bucket. Pure: reads file sizes only (never contents), no network, no spawn.
 */
export function scanLoadGroups(
  root: string,
  contextDir: string,
  budgetTokens: number,
  opts: ScanOptions = {},
): LoadGroupModel {
  const accept = opts.accept ?? (() => true);
  const groups: LoadGroup[] = groupClis().map(({ clis, paths }) => {
    const files = paths
      .filter((p) => accept(p))
      .map((p) => fileFootprint(root, p))
      .filter((f): f is ContextFile => f !== undefined)
      .sort((a, b) => a.path.localeCompare(b.path));
    return {
      clis,
      bootloaderPaths: paths,
      label: `${clis.join(", ")} → ${paths.join(" + ")}`,
      files,
      tokens: files.reduce((n, f) => n + f.tokens, 0),
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      present: files.length > 0,
    };
  });
  groups.sort(
    (a, b) =>
      Number(b.present) - Number(a.present) ||
      b.tokens - a.tokens ||
      a.label.localeCompare(b.label),
  );

  const worst = groups.find((g) => g.present) ?? null;
  const worstTokens = worst?.tokens ?? 0;

  // On-demand = everything the bloat scan sees minus the always-loaded bootloaders
  // (so the canon tree + non-canon Cursor rules show as pointer-loaded, not per-turn).
  const bootloaderSet = new Set<string>(Object.values(CLI_BOOTLOADERS).flat());
  const onDemandFiles = scanContextBloat(root, contextDir, budgetTokens, opts).files.filter(
    (f) => !bootloaderSet.has(f.path),
  );

  return {
    groups,
    worst,
    worstTokens,
    budgetTokens,
    overBudget: worstTokens > budgetTokens,
    onDemandFiles,
    onDemandTokens: onDemandFiles.reduce((n, f) => n + f.tokens, 0),
  };
}
