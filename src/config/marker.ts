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
import {
  isLegacyGstackId,
  LEGACY_GSTACK_MIGRATION_DIAGNOSTIC,
} from "../internals/legacy-config.js";
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
const AihConfigPostureSchema = z.enum(["vibe", "enterprise"]);
const KiroHookRuntimeSchema = z.enum(["ide1-cli3", "cli2"]);
const ManagedMcpProjectionExpectedSchema = z
  .object({
    allowManagedMcpServersOnly: z.literal(true),
    allowedMcpServers: z.array(z.object({ serverCommand: z.array(z.string()) }).strict()),
  })
  .strict();
const OFFSET_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;

function daysInGregorianMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isOffsetTimestamp(value: string): boolean {
  const match = OFFSET_TIMESTAMP.exec(value);
  if (match === null) return false;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInGregorianMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const DecisionBindingSchema = z
  .object({
    candidate: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
      .regex(/^decision-/),
    issuer: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    /** SHA-256 digest of the canonical GovernanceDecisionV1 artifact. */
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    expiresAt: z
      .string()
      .regex(OFFSET_TIMESTAMP)
      .refine(isOffsetTimestamp, "must be an offset-qualified ISO-8601 timestamp"),
  })
  .strict();
const DecisionBindingsSchema = z
  .array(DecisionBindingSchema)
  .max(64)
  .refine(
    (items) =>
      items.every(
        (item, index) =>
          index === 0 || ordinalCompare(items[index - 1]?.candidate ?? "", item.candidate) < 0,
      ),
    "decision bindings must be sorted and unique by candidate",
  );
const ManagedMcpProjectionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(["active", "revoked"]),
    expected: ManagedMcpProjectionExpectedSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const KiroMcpServerEntrySchema = z
  .object({
    type: z.literal("stdio"),
    command: z.string().min(1).max(512),
    args: z.array(z.string().max(2048)).max(128),
    description: z.string().min(1).max(4096),
    classification: z.enum(["local", "third-party-hosted"]),
    egress: z.enum(["none", "local-only", "vendor-incumbent", "third-party"]),
    credentials: z.enum(["none", "oauth", "token"]),
    supplyChain: z.enum(["pinned", "hosted-remote", "unpinned"]),
    env: z.record(z.string().min(1).max(120), z.string().max(4096)).optional(),
    skillsProvider: z
      .object({
        provider: z.enum([
          "SkillProvider",
          "SkillsProvider",
          "SkillsDirectoryProvider",
          "ClaudeSkillsProvider",
          "skills",
        ]),
        serverVersion: z.string().max(120).optional(),
        manifestSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        hotReload: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
const KiroMcpProjectionExpectedSchema = z
  .object({
    mcpServers: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,119}$/), KiroMcpServerEntrySchema),
  })
  .strict();
const KiroMcpProjectionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(["active", "revoked"]),
    expected: KiroMcpProjectionExpectedSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const ManagedMcpProjectionV2Schema = ManagedMcpProjectionV1Schema.extend({
  schemaVersion: z.literal(2),
  decisions: DecisionBindingsSchema,
});
const KiroMcpProjectionV2Schema = KiroMcpProjectionV1Schema.extend({
  schemaVersion: z.literal(2),
  decisions: DecisionBindingsSchema,
});
const ManagedMcpProjectionOwnershipSchema = z.discriminatedUnion("schemaVersion", [
  ManagedMcpProjectionV1Schema,
  ManagedMcpProjectionV2Schema,
]);
const KiroMcpProjectionOwnershipSchema = z.discriminatedUnion("schemaVersion", [
  KiroMcpProjectionV1Schema,
  KiroMcpProjectionV2Schema,
]);
export type ManagedMcpProjectionOwnership = z.infer<typeof ManagedMcpProjectionOwnershipSchema>;
export type ActiveManagedMcpProjectionOwnership = ManagedMcpProjectionOwnership & {
  state: "active";
};
export type KiroMcpProjectionOwnership = z.infer<typeof KiroMcpProjectionOwnershipSchema>;
export type ActiveKiroMcpProjectionOwnership = KiroMcpProjectionOwnership & { state: "active" };
export type McpProjectionDecisionBinding = z.infer<typeof DecisionBindingSchema>;
export type McpProjectionDecisionBindings = readonly McpProjectionDecisionBinding[];

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(ordinalCompare)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("MCP projection ownership must be JSON-serializable");
  return encoded;
}

function managedMcpProjectionSha256(
  state: ManagedMcpProjectionOwnership["state"],
  expected: ManagedMcpProjectionOwnership["expected"],
  decisions?: McpProjectionDecisionBindings,
): string {
  const payload =
    decisions === undefined
      ? JSON.stringify({ state, expected })
      : stableJson({
          format: "aih-mcp-projection-ownership",
          surface: "claude-managed-mcp",
          schemaVersion: 2,
          state,
          expected,
          decisions,
        });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function kiroMcpProjectionSha256(
  state: KiroMcpProjectionOwnership["state"],
  expected: KiroMcpProjectionOwnership["expected"],
  decisions?: McpProjectionDecisionBindings,
): string {
  const payload =
    decisions === undefined
      ? JSON.stringify({ state, expected })
      : stableJson({
          format: "aih-mcp-projection-ownership",
          surface: "kiro-workspace-mcp",
          schemaVersion: 2,
          state,
          expected,
          decisions,
        });
  return createHash("sha256").update(payload, "utf8").digest("hex");
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
  /** Explicit Kiro hook capability; binary detection alone cannot distinguish CLI 2 from CLI 3. */
  kiroHookRuntime: KiroHookRuntimeSchema.optional(),
  /**
   * Provenance for the two Claude managed-MCP settings. Missing provenance means
   * legacy or operator-owned values are never treated as removable by aih.
   */
  managedMcpProjection: ManagedMcpProjectionOwnershipSchema.optional(),
  /** Provenance for AIH-owned Kiro workspace MCP server entries, never an enforcement control. */
  kiroMcpProjection: KiroMcpProjectionOwnershipSchema.optional(),
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
    rejectRemovedBindingConfiguration(root);
  } catch (err) {
    if (err instanceof SettingsError) throw err;
  }
  const diagnostic = readAihConfigDiagnostic(root);
  return diagnostic.present && !diagnostic.invalid ? diagnostic.config : undefined;
}

/**
 * The marker reader remains fail-soft for older optional fields, except a removed
 * framework identifier is a governance boundary: ignoring it could make a stale
 * binding look unbound and invite an unsafe replacement.
 */
function rejectRemovedBindingConfiguration(root: string): void {
  const raw = readIfExists(join(root, AIH_CONFIG_FILE));
  if (raw === undefined) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== "object") return;
  const binding = (parsed as { binding?: unknown }).binding;
  if (binding === null || typeof binding !== "object") return;
  const framework = (binding as { framework?: unknown }).framework;
  if (framework === null || typeof framework !== "object") return;
  if (isLegacyGstackId((framework as { id?: unknown }).id)) {
    throw new SettingsError(LEGACY_GSTACK_MIGRATION_DIAGNOSTIC);
  }
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
  if (isLegacyGstackId(baseline)) {
    throw new SettingsError(LEGACY_GSTACK_MIGRATION_DIAGNOSTIC);
  }
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
  if (posture === "team") {
    throw new SettingsError(
      `invalid posture in ${AIH_CONFIG_FILE}: team posture was removed; replace team with vibe or enterprise (the administrator chooses)`,
    );
  }
  if (result.success) return result.data;
  throw new SettingsError(`invalid posture in ${AIH_CONFIG_FILE}: expected vibe or enterprise`);
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
  kiroHookRuntime?: z.infer<typeof KiroHookRuntimeSchema>,
): AihConfig {
  const body: AihConfig = { schemaVersion: 1, contextDir, targets };
  if (baseline !== DEFAULT_BASELINE_SOURCE_ID) body.baseline = baseline;
  if (kiroHookRuntime !== undefined) body.kiroHookRuntime = kiroHookRuntime;
  return body;
}

export function managedMcpProjectionOwnership(
  expected: ManagedMcpProjectionOwnership["expected"],
  decisions?: McpProjectionDecisionBindings,
): ManagedMcpProjectionOwnership {
  const state = "active";
  if (decisions !== undefined) {
    const parsedDecisions = DecisionBindingsSchema.parse(decisions);
    return {
      schemaVersion: 2,
      state,
      expected,
      decisions: parsedDecisions,
      sha256: managedMcpProjectionSha256(state, expected, parsedDecisions),
    };
  }
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
  const parsed = ManagedMcpProjectionOwnershipSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.sha256 ===
      managedMcpProjectionSha256(
        parsed.data.state,
        parsed.data.expected,
        parsed.data.schemaVersion === 2 ? parsed.data.decisions : undefined,
      )
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
    sha256: managedMcpProjectionSha256(
      state,
      ownership.expected,
      ownership.schemaVersion === 2 ? ownership.decisions : undefined,
    ),
  };
}

export function kiroMcpProjectionOwnership(
  expected: KiroMcpProjectionOwnership["expected"],
  decisions?: McpProjectionDecisionBindings,
): KiroMcpProjectionOwnership {
  const state = "active";
  if (decisions !== undefined) {
    const parsedDecisions = DecisionBindingsSchema.parse(decisions);
    return {
      schemaVersion: 2,
      state,
      expected,
      decisions: parsedDecisions,
      sha256: kiroMcpProjectionSha256(state, expected, parsedDecisions),
    };
  }
  return {
    schemaVersion: 1,
    state,
    expected,
    sha256: kiroMcpProjectionSha256(state, expected),
  };
}

export function isKiroMcpProjectionOwnership(
  value: KiroMcpProjectionOwnership | undefined,
): value is KiroMcpProjectionOwnership {
  const parsed = KiroMcpProjectionOwnershipSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.sha256 ===
      kiroMcpProjectionSha256(
        parsed.data.state,
        parsed.data.expected,
        parsed.data.schemaVersion === 2 ? parsed.data.decisions : undefined,
      )
  );
}

export function isActiveKiroMcpProjectionOwnership(
  value: KiroMcpProjectionOwnership | undefined,
): value is ActiveKiroMcpProjectionOwnership {
  return isKiroMcpProjectionOwnership(value) && value.state === "active";
}

export function revokedKiroMcpProjectionOwnership(
  ownership: KiroMcpProjectionOwnership,
): KiroMcpProjectionOwnership {
  const state = "revoked";
  return {
    ...ownership,
    state,
    sha256: kiroMcpProjectionSha256(
      state,
      ownership.expected,
      ownership.schemaVersion === 2 ? ownership.decisions : undefined,
    ),
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

/** Merge-safe marker update for Kiro workspace-MCP provenance. */
export function kiroMcpProjectionConfigJsonFromRaw(
  raw: string | undefined,
  contextDir: string,
  targets: string[],
  ownership: KiroMcpProjectionOwnership,
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
    if (parsed.success) return { kiroMcpProjection: ownership };
    throw new SettingsError(
      `cannot record Kiro workspace-MCP provenance: ${AIH_CONFIG_FILE} is malformed; repair it before applying the projection`,
    );
  }
  return { schemaVersion: 1, contextDir, targets, kiroMcpProjection: ownership };
}
