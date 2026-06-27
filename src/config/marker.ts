import { join } from "node:path";
import { z } from "zod";
import { readIfExists } from "../internals/fsxn.js";
import { ContextDir } from "./settings.js";

/**
 * The committed bootstrap-intent marker. It records what `aih init` re-derivation
 * otherwise loses across runs: the canonical context dir and the resolved CLI
 * targets. It lives at the repo ROOT (sibling of `.aih-workspace.json`), NOT under
 * the git-ignored `.aih/` output dir — so it survives a clone and a fresh checkout
 * reads the same context-dir/targets the repo was bootstrapped with.
 *
 * Schema shape inspired by @blazity-atlas/ai-harness's `.ai/config.json` (idea
 * only; re-expressed in aih's own zod idiom). aih has exactly one context dir by
 * design, so the `paths`/`pathAliases`/`artifactRoot` map is deliberately dropped.
 */
export const AIH_CONFIG_FILE = ".aih-config.json";

/**
 * Persisted bootstrap intent. `contextDir` reuses the SAME {@link ContextDir}
 * constraints settings enforce; `targets` is the resolved CLI list at bootstrap
 * time (defaulted to `[]` so an older/partial marker still parses).
 */
const AihConfigSchema = z.object({
  schemaVersion: z.literal(1),
  contextDir: ContextDir,
  targets: z.array(z.string()).default([]),
  /**
   * `aih adopt`'s team decisions: CLI-native paths the team has acknowledged as
   * intentionally tool-native (so re-runs stop flagging them as import candidates —
   * the idempotency guard). Optional + committed (shared by the whole team).
   */
  adopt: z.object({ acknowledged: z.array(z.string()).default([]) }).optional(),
});

export type AihConfig = z.infer<typeof AihConfigSchema>;

/**
 * Read the committed bootstrap intent, or `undefined` when the marker is absent,
 * unreadable, or fails validation. Fail-SOFT by design (unlike {@link loadSettings},
 * which is fail-closed): a malformed marker must never break a command — callers
 * fall back to flags/env/default. Mirrors the JSON-read shape of
 * `doctor.ts:workspaceRepos` (`readIfExists` + guarded parse).
 */
export function readAihConfig(root: string): AihConfig | undefined {
  const raw = readIfExists(join(root, AIH_CONFIG_FILE));
  if (raw === undefined) return undefined;
  try {
    return AihConfigSchema.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Build the marker body the bootstrap persists via
 * `writeJson(AIH_CONFIG_FILE, …, { merge: true })`. Non-destructive by
 * construction: the same inputs render byte-identical JSON, and the merge write
 * preserves any extra user keys already on disk.
 */
export function aihConfigJson(contextDir: string, targets: string[]): AihConfig {
  return { schemaVersion: 1, contextDir, targets };
}
