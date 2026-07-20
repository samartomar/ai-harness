import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { type BindingDeclaration, BindingDeclarationSchema } from "../binding/schema.js";
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
const AihConfigPostureSchema = z.enum(["vibe", "team", "enterprise"]);
const ManagedMcpProjectionExpectedSchema = z
  .object({
    allowManagedMcpServersOnly: z.literal(true),
    allowedMcpServers: z.array(z.object({ serverCommand: z.array(z.string()) }).strict()),
  })
  .strict();
const ManagedMcpProjectionOwnershipSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(["active", "revoked"]),
    expected: ManagedMcpProjectionExpectedSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type ManagedMcpProjectionOwnership = z.infer<typeof ManagedMcpProjectionOwnershipSchema>;
export type ActiveManagedMcpProjectionOwnership = ManagedMcpProjectionOwnership & {
  state: "active";
};

function managedMcpProjectionSha256(
  state: ManagedMcpProjectionOwnership["state"],
  expected: ManagedMcpProjectionOwnership["expected"],
): string {
  return createHash("sha256").update(JSON.stringify({ state, expected }), "utf8").digest("hex");
}

/**
 * Persisted bootstrap intent. `contextDir` reuses the SAME {@link ContextDir}
 * constraints settings enforce; `targets` is the resolved CLI list at bootstrap
 * time (defaulted to `[]` so an older/partial marker still parses).
 */
export const AihConfigSchema = z.object({
  schemaVersion: z.literal(1),
  contextDir: ContextDir,
  targets: z.array(z.string()).default([]),
  baseline: BaselineSourceIdSchema.optional(),
  posture: AihConfigPostureSchema.optional(),
  /**
   * Provenance for the two Claude managed-MCP settings. Missing provenance means
   * legacy or operator-owned values are never treated as removable by aih.
   */
  managedMcpProjection: ManagedMcpProjectionOwnershipSchema.optional(),
  /**
   * `aih adopt`'s team decisions: CLI-native paths the team has acknowledged as
   * intentionally tool-native (so re-runs stop flagging them as import candidates —
   * the idempotency guard). Optional + committed (shared by the whole team).
   */
  adopt: z.object({ acknowledged: z.array(z.string()).default([]) }).optional(),
  /**
   * Project Framework Binding declaration (D7 committed authority, D8 one
   * framework). A SINGLE object, never an array; its subtree is strict, so a
   * smuggled second framework is rejected rather than stripped even though this
   * surrounding marker schema is otherwise lenient. See `../binding/schema.ts`.
   */
  binding: BindingDeclarationSchema.optional(),
});

export type AihConfig = z.infer<typeof AihConfigSchema>;
export type { BindingDeclaration };

export type AihConfigReadDiagnostic =
  | { invalid: false; present: false }
  | { invalid: true; present: true }
  | { config: AihConfig; invalid: false; present: true };

/**
 * Read the committed bootstrap intent, or `undefined` when the marker is absent,
 * unreadable, or fails validation. Fail-SOFT by design for old/partial markers
 * (unlike {@link loadSettings}, which is fail-closed): callers fall back to
 * flags/env/default. The exception is `baseline`: a present invalid baseline is
 * a governance control value and fails closed with a clear error.
 */
export function readAihConfig(root: string): AihConfig | undefined {
  try {
    readAihConfigBaseline(root);
    readAihConfigPosture(root);
  } catch (err) {
    if (err instanceof SettingsError) throw err;
  }
  const diagnostic = readAihConfigDiagnostic(root);
  return diagnostic.present && !diagnostic.invalid ? diagnostic.config : undefined;
}

/**
 * Read the marker with enough state for advisory surfaces to distinguish "absent"
 * from "present but invalid" without changing the fail-soft public reader.
 */
export function readAihConfigDiagnostic(root: string): AihConfigReadDiagnostic {
  try {
    const raw = readIfExists(join(root, AIH_CONFIG_FILE));
    if (raw === undefined) return { invalid: false, present: false };
    return { config: AihConfigSchema.parse(JSON.parse(raw)), invalid: false, present: true };
  } catch {
    return { invalid: true, present: true };
  }
}

/**
 * Strictly read only the persisted baseline choice. Most marker fields are
 * fail-soft for old/partial markers, but `baseline` controls canon semantics;
 * when present and invalid, commands must fail closed rather than silently
 * falling back to the default.
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

export function readAihConfigPosture(
  root: string,
): z.infer<typeof AihConfigPostureSchema> | undefined {
  const raw = readIfExists(join(root, AIH_CONFIG_FILE));
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || !("posture" in parsed)) {
    return undefined;
  }
  const posture = (parsed as { posture?: unknown }).posture;
  if (posture === undefined) return undefined;
  const result = AihConfigPostureSchema.safeParse(posture);
  if (result.success) return result.data;
  throw new SettingsError(
    `invalid posture in ${AIH_CONFIG_FILE}: expected vibe, team, or enterprise`,
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

export function managedMcpProjectionOwnership(
  expected: ManagedMcpProjectionOwnership["expected"],
): ManagedMcpProjectionOwnership {
  const state = "active";
  return {
    schemaVersion: 1,
    state,
    expected,
    sha256: managedMcpProjectionSha256(state, expected),
  };
}

export function isManagedMcpProjectionOwnership(
  value: ManagedMcpProjectionOwnership | undefined,
): value is ManagedMcpProjectionOwnership {
  return (
    value !== undefined && value.sha256 === managedMcpProjectionSha256(value.state, value.expected)
  );
}

export function isActiveManagedMcpProjectionOwnership(
  value: ManagedMcpProjectionOwnership | undefined,
): value is ActiveManagedMcpProjectionOwnership {
  return isManagedMcpProjectionOwnership(value) && value.state === "active";
}

export function revokedManagedMcpProjectionOwnership(
  ownership: ManagedMcpProjectionOwnership,
): ManagedMcpProjectionOwnership {
  const state = "revoked";
  return {
    ...ownership,
    state,
    sha256: managedMcpProjectionSha256(state, ownership.expected),
  };
}

/**
 * Build a merge-safe marker update for managed-MCP provenance. A malformed
 * existing marker is never repaired or used as ownership evidence.
 */
export function managedMcpProjectionConfigJson(
  root: string,
  contextDir: string,
  targets: string[],
  ownership: ManagedMcpProjectionOwnership,
): Record<string, unknown> {
  return managedMcpProjectionConfigJsonFromRaw(
    readIfExists(join(root, AIH_CONFIG_FILE)),
    contextDir,
    targets,
    ownership,
  );
}

/**
 * Render the managed-MCP ownership update from the exact marker bytes observed
 * while planning, so callers can bind the write to that same snapshot.
 */
export function managedMcpProjectionConfigJsonFromRaw(
  raw: string | undefined,
  contextDir: string,
  targets: string[],
  ownership: ManagedMcpProjectionOwnership,
): Record<string, unknown> {
  if (raw !== undefined) {
    const parsed = AihConfigSchema.safeParse(
      (() => {
        try {
          return JSON.parse(raw);
        } catch {
          return undefined;
        }
      })(),
    );
    if (parsed.success) return { managedMcpProjection: ownership };
    throw new SettingsError(
      `cannot record Claude managed-MCP provenance: ${AIH_CONFIG_FILE} is malformed; repair it before applying the restriction`,
    );
  }
  return {
    schemaVersion: 1,
    contextDir,
    targets,
    managedMcpProjection: ownership,
  };
}
