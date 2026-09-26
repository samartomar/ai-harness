import { AihError } from "../errors.js";
import type { FrameworkHookEnvironmentPatchV1, FrameworkIdV1 } from "./contract-v1.js";

/** Per framework, the Claude settings environment its hook-control plan owns. */
export type FrameworkHookEnvironmentPlansV1 = ReadonlyMap<
  FrameworkIdV1,
  FrameworkHookEnvironmentPatchV1
>;

const MAX_KEYS = 8;
const MAX_VALUE_LENGTH = 4096;

/** The environment-name prefix a framework's hook controls may own, e.g. `ECC_`. */
export function frameworkHookEnvironmentPrefixV1(frameworkId: FrameworkIdV1): string {
  return `${frameworkId.toUpperCase()}_`;
}

function refuse(frameworkId: FrameworkIdV1, problem: string): never {
  throw new AihError(
    `the ${frameworkId} framework plugin returned an unusable hook-control plan: ${problem}`,
    "AIH_FRAMEWORK_PLUGIN",
  );
}

/**
 * Validate a plugin's environment patch at the boundary. A framework may own
 * only keys under its own prefix — never `PATH`, `NODE_OPTIONS` or another
 * framework's keys — and set only keys it owns, to bounded printable values.
 */
export function validateFrameworkHookEnvironmentV1(
  frameworkId: FrameworkIdV1,
  environment: unknown,
): FrameworkHookEnvironmentPatchV1 {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    refuse(frameworkId, "environment is not an object");
  }
  const { host, keys, set, ...rest } = environment as Record<string, unknown>;
  if (Object.keys(rest).length > 0) refuse(frameworkId, `unknown field ${Object.keys(rest)[0]}`);
  if (host !== "claude") refuse(frameworkId, "only the Claude settings environment is supported");
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS) {
    refuse(frameworkId, `keys must list 1 to ${MAX_KEYS} names`);
  }
  const prefix = frameworkHookEnvironmentPrefixV1(frameworkId);
  const pattern = new RegExp(`^${prefix}[A-Z0-9_]{1,60}$`);
  for (const key of keys) {
    if (typeof key !== "string" || !pattern.test(key)) {
      refuse(frameworkId, `${String(key).slice(0, 64)} is not an ${prefix} key`);
    }
  }
  if (new Set(keys).size !== keys.length) refuse(frameworkId, "keys repeat");
  if (typeof set !== "object" || set === null || Array.isArray(set)) {
    refuse(frameworkId, "set is not an object");
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(set)) {
    if (!keys.includes(key))
      refuse(frameworkId, `set names ${key.slice(0, 64)}, which it does not own`);
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_VALUE_LENGTH ||
      !/^[\x20-\x7e]+$/.test(value)
    ) {
      refuse(frameworkId, `the value of ${key} is not a bounded printable string`);
    }
    values[key] = value;
  }
  return Object.freeze({
    host: "claude",
    keys: Object.freeze([...(keys as string[])]),
    set: Object.freeze(values),
  });
}
