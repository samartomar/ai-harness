import { join } from "node:path";
import { AIH_CONFIG_FILE } from "../config/marker.js";
import { SettingsError } from "../errors.js";
import { readIfExists } from "../internals/fsxn.js";
import type { OrgPolicy } from "../org-policy/schema.js";
import type {
  FrameworkHookControlRequestV1,
  FrameworkHookDisableRequestV1,
  FrameworkIdV1,
} from "./contract-v1.js";
import {
  type FrameworkHookControlEntry,
  type FrameworkHookControls,
  FrameworkHookControlsSchema,
} from "./hook-controls-schema.js";

/**
 * The user's hook-control list, `frameworkHookControls` in the project's
 * `.aih-config.json`. A present list is a control value and fails closed: a
 * malformed one is refused, never read as "no controls".
 */
export function readUserFrameworkHookControlsV1(root: string): FrameworkHookControls | undefined {
  const raw = readIfExists(join(root, AIH_CONFIG_FILE));
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SettingsError(
      `invalid frameworkHookControls in ${AIH_CONFIG_FILE}: marker is not valid JSON`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsError(
      `invalid frameworkHookControls in ${AIH_CONFIG_FILE}: marker must be an object`,
    );
  }
  const value = (parsed as { frameworkHookControls?: unknown }).frameworkHookControls;
  if (value === undefined) return undefined;
  const result = FrameworkHookControlsSchema.safeParse(value);
  if (result.success) return result.data;
  throw new SettingsError(
    `invalid frameworkHookControls in ${AIH_CONFIG_FILE}: ${result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"} — ${issue.message}`)
      .join("; ")}`,
  );
}

/**
 * Merge the two authorities for one framework. Enterprise disables come first
 * and keep enterprise authority; the user list only adds disables. A user
 * profile applies only where enterprise sets none: a different user profile
 * than the enterprise one is refused, not silently overridden.
 */
export function mergeFrameworkHookControlRequestV1(
  enterprise: FrameworkHookControlEntry | undefined,
  user: FrameworkHookControlEntry | undefined,
  frameworkId: FrameworkIdV1 = "ecc",
): FrameworkHookControlRequestV1 {
  if (
    enterprise?.profile !== undefined &&
    user?.profile !== undefined &&
    user.profile !== enterprise.profile
  ) {
    throw new SettingsError(
      `enterprise policy sets the ${frameworkId} hook profile ${enterprise.profile}; the user list may only add disables, so its profile ${user.profile} is refused`,
    );
  }
  const disabled: FrameworkHookDisableRequestV1[] = (enterprise?.disabledHookIds ?? []).map(
    (hookId) => ({ hookId, authority: "enterprise" }),
  );
  const enterpriseIds = new Set(enterprise?.disabledHookIds ?? []);
  for (const hookId of user?.disabledHookIds ?? []) {
    if (!enterpriseIds.has(hookId)) disabled.push({ hookId, authority: "user" });
  }
  const profile =
    enterprise?.profile !== undefined
      ? { id: enterprise.profile, authority: "enterprise" as const }
      : user?.profile !== undefined
        ? { id: user.profile, authority: "user" as const }
        : undefined;
  return { disabled, ...(profile === undefined ? {} : { profile }) };
}

/** Both authorities' entries for one framework. */
export function frameworkHookControlEntriesV1(
  frameworkId: FrameworkIdV1,
  policy: OrgPolicy | undefined,
  root: string,
): {
  readonly enterprise?: FrameworkHookControlEntry;
  readonly user?: FrameworkHookControlEntry;
} {
  const enterprise = policy?.governance?.frameworkHookControls?.[frameworkId];
  const user = readUserFrameworkHookControlsV1(root)?.[frameworkId];
  return {
    ...(enterprise === undefined ? {} : { enterprise }),
    ...(user === undefined ? {} : { user }),
  };
}

/** The merged hook-control request Core's policy view carries for one framework. */
export function frameworkHookControlRequestV1(
  frameworkId: FrameworkIdV1,
  policy: OrgPolicy | undefined,
  root: string,
): FrameworkHookControlRequestV1 {
  const { enterprise, user } = frameworkHookControlEntriesV1(frameworkId, policy, root);
  return mergeFrameworkHookControlRequestV1(enterprise, user, frameworkId);
}
