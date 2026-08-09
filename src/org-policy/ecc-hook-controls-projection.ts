import { createHash } from "node:crypto";
import { isPlainObject } from "../internals/merge.js";
import { type Action, type PlanContext, remove, writeJson } from "../internals/plan.js";
import { withExpectedContents } from "../mcp/managed-projection.js";
import type { EccHookControlsSelection } from "./ecc-hook-controls.js";
import {
  ECC_HOOK_CONTROLS_RECEIPT_PATH,
  type EccHookControlsReceipt,
  eccHookControlsReceipt,
  readEccHookControlsReceipt,
} from "./ecc-hook-controls-receipt.js";
import { parseDestinationSettings } from "./hook-registrar-native.js";
import {
  type GuardedRead,
  HOOK_REGISTRAR_DESTINATION,
  readDestination,
} from "./hook-registrar-read.js";
import { OrgPolicyError } from "./schema.js";

export type EccHookEnvKey = "ECC_HOOK_PROFILE" | "ECC_DISABLED_HOOKS";

export interface EccHookEnvPatch {
  set: Readonly<Partial<Record<EccHookEnvKey, string>>>;
  remove: readonly EccHookEnvKey[];
}

export interface EccHookControlsProjectionPlan {
  /** The one guarded settings snapshot validated by this lifecycle. */
  destinationRead?: GuardedRead;
  envPatch?: EccHookEnvPatch;
  standaloneSettingsAction?: Action;
  receiptActions: Action[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function desiredEccHookEnvironment(
  receipt: EccHookControlsReceipt,
): Readonly<Partial<Record<EccHookEnvKey, string>>> {
  return {
    ECC_HOOK_PROFILE: receipt.profile,
    ...(receipt.disabledIds.length === 0
      ? {}
      : { ECC_DISABLED_HOOKS: receipt.disabledIds.join(",") }),
  };
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

function ownedEnvironmentMatches(
  env: Record<string, unknown>,
  receipt: EccHookControlsReceipt,
): boolean {
  const expected = desiredEccHookEnvironment(receipt);
  if (env.ECC_HOOK_PROFILE !== expected.ECC_HOOK_PROFILE) return false;
  if (expected.ECC_DISABLED_HOOKS === undefined) {
    return !Object.hasOwn(env, "ECC_DISABLED_HOOKS");
  }
  return env.ECC_DISABLED_HOOKS === expected.ECC_DISABLED_HOOKS;
}

function patchForReceipt(receipt: EccHookControlsReceipt): EccHookEnvPatch {
  const set = desiredEccHookEnvironment(receipt);
  return {
    set,
    remove: set.ECC_DISABLED_HOOKS === undefined ? (["ECC_DISABLED_HOOKS"] as const) : [],
  };
}

function revokePatch(): EccHookEnvPatch {
  return {
    set: {},
    remove: ["ECC_HOOK_PROFILE", "ECC_DISABLED_HOOKS"],
  };
}

export function eccHookSettingsAction(raw: string | undefined, patch: EccHookEnvPatch): Action {
  const setKeys = Object.keys(patch.set) as EccHookEnvKey[];
  const json = setKeys.length === 0 ? {} : { env: patch.set };
  return withExpectedContents(
    writeJson(
      HOOK_REGISTRAR_DESTINATION,
      json,
      "project ECC-owned hook controls through Claude settings environment keys",
      {
        merge: true,
        ...(setKeys.length === 0 ? {} : { replaceJsonChildKeys: { env: setKeys } }),
        ...(patch.remove.length === 0 ? {} : { removeJsonKeys: { env: patch.remove } }),
      },
    ),
    raw,
  );
}

function receiptWriteAction(
  receipt: EccHookControlsReceipt,
  existingRaw: string | undefined,
): Action {
  return withExpectedContents(
    writeJson(
      ECC_HOOK_CONTROLS_RECEIPT_PATH,
      receipt,
      "record ECC hook-control environment ownership",
    ),
    existingRaw,
  );
}

export function planEccHookControlsProjection(
  ctx: PlanContext,
  selection: EccHookControlsSelection | undefined,
): EccHookControlsProjectionPlan {
  const receiptRead = readEccHookControlsReceipt(ctx.root);
  // A policy that never selected ECC hook controls owns nothing here. Do not
  // inspect or reject unrelated Claude settings unless a selection or receipt
  // makes this lifecycle responsible for the destination.
  if (selection === undefined && receiptRead === undefined) {
    return { receiptActions: [] };
  }
  const destinationRead = readDestination(ctx.root);
  if (destinationRead.state === "unreadable") {
    throw new OrgPolicyError(`refusing ECC hook-control projection: ${destinationRead.reason}`);
  }
  const raw = destinationRead.state === "present" ? destinationRead.contents : undefined;
  const env = destinationEnv(raw);

  if (receiptRead !== undefined && !ownedEnvironmentMatches(env, receiptRead.receipt)) {
    throw new OrgPolicyError(
      `refusing ECC hook-control projection: ${HOOK_REGISTRAR_DESTINATION} env no longer matches ${ECC_HOOK_CONTROLS_RECEIPT_PATH}`,
    );
  }

  if (selection === undefined) {
    if (receiptRead === undefined) return { receiptActions: [] };
    const envPatch = revokePatch();
    return {
      destinationRead,
      envPatch,
      standaloneSettingsAction: eccHookSettingsAction(raw, envPatch),
      receiptActions: [
        remove(ECC_HOOK_CONTROLS_RECEIPT_PATH, "remove the completed ECC hook-control receipt", {
          expect: { sha256: sha256(receiptRead.raw) },
        }),
      ],
    };
  }

  const nextReceipt = eccHookControlsReceipt(selection);
  if (receiptRead === undefined) {
    const collision = (["ECC_HOOK_PROFILE", "ECC_DISABLED_HOOKS"] as const).find((key) =>
      Object.hasOwn(env, key),
    );
    if (collision !== undefined) {
      throw new OrgPolicyError(
        `refusing ECC hook-control projection: ${HOOK_REGISTRAR_DESTINATION}.env.${collision} already exists without an AIH receipt`,
      );
    }
  }
  const envPatch = patchForReceipt(nextReceipt);
  const unchanged =
    receiptRead !== undefined &&
    JSON.stringify(receiptRead.receipt) === JSON.stringify(nextReceipt);
  return {
    destinationRead,
    envPatch,
    ...(unchanged ? {} : { standaloneSettingsAction: eccHookSettingsAction(raw, envPatch) }),
    receiptActions: unchanged ? [] : [receiptWriteAction(nextReceipt, receiptRead?.raw)],
  };
}
