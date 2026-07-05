import { join } from "node:path";
import { z } from "zod";
import { SettingsError } from "../errors.js";
import {
  type BaselineSourceId,
  BaselineSourceIdSchema,
  baselineSourceIds,
  DEFAULT_BASELINE_SOURCE_ID,
  isBaselineSourceId,
} from "../internals/baseline-sources.js";
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
export const AihConfigSchema = z.object({
  schemaVersion: z.literal(1),
  contextDir: ContextDir,
  targets: z.array(z.string()).default([]),
  baseline: BaselineSourceIdSchema.optional().catch(undefined),
  posture: z.enum(["vibe", "team", "enterprise"]).optional(),
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
 * Strictly read only the persisted baseline choice. The full marker reader is
 * intentionally fail-soft for old/partial markers, but `baseline` controls canon
 * semantics; when present and invalid, commands must fail closed rather than
 * silently falling back to the default.
 */
export function readAihConfigBaseline(root: string): BaselineSourceId | undefined {
  const raw = readIfExists(join(root, AIH_CONFIG_FILE));
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || !("baseline" in parsed)) {
    return undefined;
  }
  const baseline = (parsed as { baseline?: unknown }).baseline;
  if (baseline === undefined) return undefined;
  if (isBaselineSourceId(baseline)) return baseline;
  throw new SettingsError(
    `invalid baseline in ${AIH_CONFIG_FILE}: expected one of ${baselineSourceIds().join("|")}`,
  );
}

/**
 * Build the marker body the bootstrap persists via
 * `writeJson(AIH_CONFIG_FILE, …, { merge: true })`. Non-destructive by
 * construction: the same inputs render byte-identical JSON, and the merge write
 * preserves any extra user keys already on disk.
 */
export function aihConfigJson(
  contextDir: string,
  targets: string[],
  baseline: BaselineSourceId = DEFAULT_BASELINE_SOURCE_ID,
): AihConfig {
  const body: AihConfig = { schemaVersion: 1, contextDir, targets };
  if (baseline !== DEFAULT_BASELINE_SOURCE_ID) body.baseline = baseline;
  return body;
}
