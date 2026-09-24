import { createHash } from "node:crypto";
import { z } from "zod";
import { FRAMEWORK_IDS_V1, type FrameworkIdV1 } from "../framework-plugin/contract-v1.js";
import {
  type FrameworkHookEnvironmentPlansV1,
  validateFrameworkHookEnvironmentV1,
} from "../framework-plugin/hook-environment.js";
import { isPlainObject } from "../internals/merge.js";
import { type Action, type PlanContext, remove, writeJson } from "../internals/plan.js";
import { withExpectedContents } from "../mcp/managed-projection.js";
import { parseDestinationSettings } from "./hook-registrar-native.js";
import {
  type GuardedRead,
  HOOK_REGISTRAR_DESTINATION,
  readDestination,
  readGuardedFile,
} from "./hook-registrar-read.js";
import { OrgPolicyError } from "./schema.js";

/**
 * Framework hook controls projected into Claude's settings environment.
 *
 * Each framework plugin's hook-control plan names the environment keys it
 * owns and the values it wants set (ECC: `ECC_HOOK_PROFILE`,
 * `ECC_DISABLED_HOOKS`). Core writes exactly those keys, through the hook
 * registrar's guarded destination write, and records them in one receipt so a
 * later projection can update or revoke them — and refuses when an owned key
 * drifted or a key it would take over already exists without a receipt.
 */

export type { FrameworkHookEnvironmentPlansV1 as FrameworkHookEnvironmentPlans };

export const FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH =
  ".aih/org-policy-framework-hook-controls-receipt.json";
export const FRAMEWORK_HOOK_CONTROLS_RECEIPT_FORMAT =
  "aih-org-policy-framework-hook-controls-receipt";
/** The ECC-only receipt Core 0.6 wrote for `governance.eccHookControls`. */
export const LEGACY_ECC_HOOK_CONTROLS_RECEIPT_PATH =
  ".aih/org-policy-ecc-hook-controls-receipt.json";
const MAX_RECEIPT_BYTES = 64 * 1024;

/** The settings-environment change the registrar applies with its destination write. */
export interface HookEnvPatch {
  readonly set: Readonly<Record<string, string>>;
  readonly remove: readonly string[];
}

export interface FrameworkHookControlsProjectionPlan {
  /** The one guarded settings snapshot validated by this lifecycle. */
  destinationRead?: GuardedRead;
  envPatch?: HookEnvPatch;
  standaloneSettingsAction?: Action;
  receiptActions: Action[];
}

interface OwnedEnvironment {
  keys: string[];
  set: Record<string, string>;
}

export interface FrameworkHookControlsReceipt {
  format: typeof FRAMEWORK_HOOK_CONTROLS_RECEIPT_FORMAT;
  version: 1;
  destination: typeof HOOK_REGISTRAR_DESTINATION;
  frameworks: Partial<Record<FrameworkIdV1, OwnedEnvironment>>;
}

const OwnedEnvironmentSchema = z
  .object({
    keys: z.array(z.string()).min(1).max(8),
    set: z.record(z.string(), z.string()),
  })
  .strict();

const ReceiptSchema = z
  .object({
    format: z.literal(FRAMEWORK_HOOK_CONTROLS_RECEIPT_FORMAT),
    version: z.literal(1),
    destination: z.literal(HOOK_REGISTRAR_DESTINATION),
    frameworks: z
      .object({
        ecc: OwnedEnvironmentSchema.optional(),
        superpowers: OwnedEnvironmentSchema.optional(),
      })
      .strict(),
  })
  .strict();

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseReceipt(raw: string): FrameworkHookControlsReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OrgPolicyError(
      `${FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH} is malformed; refusing framework hook-control ownership`,
    );
  }
  const parsed = ReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrgPolicyError(
      `${FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH} is not an AIH framework hook-control receipt: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  const receipt = parsed.data as FrameworkHookControlsReceipt;
  // Owned keys obey the same boundary as a plugin's plan: a receipt cannot
  // hand a framework a key outside its own prefix.
  for (const frameworkId of FRAMEWORK_IDS_V1) {
    const owned = receipt.frameworks[frameworkId];
    if (owned === undefined) continue;
    try {
      validateFrameworkHookEnvironmentV1(frameworkId, { host: "claude", ...owned });
    } catch (error) {
      throw new OrgPolicyError(
        `${FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH} is not an AIH framework hook-control receipt: ${(error as Error).message}`,
      );
    }
  }
  return receipt;
}

export function readFrameworkHookControlsReceipt(
  root: string,
): { receipt: FrameworkHookControlsReceipt; raw: string } | undefined {
  const read = readGuardedFile(root, FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH, {
    maxBytes: MAX_RECEIPT_BYTES,
  });
  if (read.state === "unreadable") {
    throw new OrgPolicyError(`refusing framework hook-control receipt: ${read.reason}`);
  }
  if (read.state === "absent") return undefined;
  return { receipt: parseReceipt(read.contents), raw: read.contents };
}

function refuseLegacyReceipt(root: string): void {
  const legacy = readGuardedFile(root, LEGACY_ECC_HOOK_CONTROLS_RECEIPT_PATH, {
    maxBytes: MAX_RECEIPT_BYTES,
  });
  if (legacy.state === "absent") return;
  if (legacy.state === "unreadable") {
    throw new OrgPolicyError(`refusing framework hook-control projection: ${legacy.reason}`);
  }
  throw new OrgPolicyError(
    `refusing framework hook-control projection: ${LEGACY_ECC_HOOK_CONTROLS_RECEIPT_PATH} is from the removed governance.eccHookControls. ` +
      `Move the controls to governance.frameworkHookControls.ecc (schemaVersion 3, minimumCoreVersion 0.7.0), ` +
      `then remove ECC_HOOK_PROFILE and ECC_DISABLED_HOOKS from ${HOOK_REGISTRAR_DESTINATION} env and delete that receipt before projecting`,
  );
}

function destinationEnv(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  const parsed = parseDestinationSettings(raw);
  if (!isPlainObject(parsed)) {
    throw new OrgPolicyError(`${HOOK_REGISTRAR_DESTINATION} is not a JSON object`);
  }
  const env = parsed.env;
  if (env === undefined) return {};
  if (!isPlainObject(env)) {
    throw new OrgPolicyError(`${HOOK_REGISTRAR_DESTINATION}.env is not an object`);
  }
  return env;
}

function ownedEnvironmentMatches(env: Record<string, unknown>, owned: OwnedEnvironment): boolean {
  return owned.keys.every((key) =>
    Object.hasOwn(owned.set, key) ? env[key] === owned.set[key] : !Object.hasOwn(env, key),
  );
}

export function hookSettingsAction(raw: string | undefined, patch: HookEnvPatch): Action {
  const setKeys = Object.keys(patch.set);
  const json = setKeys.length === 0 ? {} : { env: patch.set };
  return withExpectedContents(
    writeJson(
      HOOK_REGISTRAR_DESTINATION,
      json,
      "project framework hook controls through Claude settings environment keys",
      {
        merge: true,
        ...(setKeys.length === 0 ? {} : { replaceJsonChildKeys: { env: setKeys } }),
        ...(patch.remove.length === 0 ? {} : { removeJsonKeys: { env: [...patch.remove] } }),
      },
    ),
    raw,
  );
}

function receiptFor(plans: FrameworkHookEnvironmentPlansV1): FrameworkHookControlsReceipt {
  const frameworks: Partial<Record<FrameworkIdV1, OwnedEnvironment>> = {};
  for (const frameworkId of FRAMEWORK_IDS_V1) {
    const planned = plans.get(frameworkId);
    if (planned === undefined) continue;
    frameworks[frameworkId] = { keys: [...planned.keys], set: { ...planned.set } };
  }
  return {
    format: FRAMEWORK_HOOK_CONTROLS_RECEIPT_FORMAT,
    version: 1,
    destination: HOOK_REGISTRAR_DESTINATION,
    frameworks,
  };
}

/**
 * Plan the settings-environment change and receipt for the frameworks' plans.
 * `plans` holds, per framework, the validated environment its plugin's plan
 * owns; a framework absent from `plans` owns nothing, so keys its receipt
 * entry owned are removed.
 */
export function planFrameworkHookControlsProjection(
  ctx: PlanContext,
  plans: FrameworkHookEnvironmentPlansV1,
): FrameworkHookControlsProjectionPlan {
  refuseLegacyReceipt(ctx.root);
  const validated = new Map(
    [...plans].map(([frameworkId, planned]) => [
      frameworkId,
      validateFrameworkHookEnvironmentV1(frameworkId, planned),
    ]),
  );
  const receiptRead = readFrameworkHookControlsReceipt(ctx.root);
  // Nothing requested and nothing owned: this lifecycle is not responsible for
  // the destination, so unrelated Claude settings are neither read nor judged.
  if (validated.size === 0 && receiptRead === undefined) {
    return { receiptActions: [] };
  }
  const destinationRead = readDestination(ctx.root);
  if (destinationRead.state === "unreadable") {
    throw new OrgPolicyError(
      `refusing framework hook-control projection: ${destinationRead.reason}`,
    );
  }
  const raw = destinationRead.state === "present" ? destinationRead.contents : undefined;
  const env = destinationEnv(raw);

  const ownedKeys = new Set<string>();
  for (const owned of Object.values(receiptRead?.receipt.frameworks ?? {})) {
    if (owned === undefined) continue;
    if (!ownedEnvironmentMatches(env, owned)) {
      throw new OrgPolicyError(
        `refusing framework hook-control projection: ${HOOK_REGISTRAR_DESTINATION} env no longer matches ${FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH}`,
      );
    }
    for (const key of owned.keys) ownedKeys.add(key);
  }

  const set: Record<string, string> = {};
  const planKeys = new Set<string>();
  for (const planned of validated.values()) {
    for (const key of planned.keys) {
      planKeys.add(key);
      if (!ownedKeys.has(key) && Object.hasOwn(env, key)) {
        throw new OrgPolicyError(
          `refusing framework hook-control projection: ${HOOK_REGISTRAR_DESTINATION}.env.${key} already exists without an AIH receipt`,
        );
      }
    }
    Object.assign(set, planned.set);
  }
  const envPatch: HookEnvPatch = {
    set,
    remove: [...new Set([...ownedKeys, ...planKeys])].filter((key) => !Object.hasOwn(set, key)),
  };

  if (validated.size === 0) {
    return {
      destinationRead,
      envPatch,
      standaloneSettingsAction: hookSettingsAction(raw, envPatch),
      receiptActions: [
        remove(
          FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH,
          "remove the completed framework hook-control receipt",
          { expect: { sha256: sha256((receiptRead as { raw: string }).raw) } },
        ),
      ],
    };
  }

  const next = receiptFor(validated);
  const unchanged =
    receiptRead !== undefined && JSON.stringify(receiptRead.receipt) === JSON.stringify(next);
  return {
    destinationRead,
    envPatch,
    ...(unchanged ? {} : { standaloneSettingsAction: hookSettingsAction(raw, envPatch) }),
    receiptActions: unchanged
      ? []
      : [
          withExpectedContents(
            writeJson(
              FRAMEWORK_HOOK_CONTROLS_RECEIPT_PATH,
              next,
              "record framework hook-control environment ownership",
            ),
            receiptRead?.raw,
          ),
        ],
  };
}
