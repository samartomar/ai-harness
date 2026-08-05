/**
 * The only compatibility retained for a removed framework: reject its persisted
 * identifier with a stable migration diagnostic. It is deliberately not a
 * supported-framework registry or translation layer.
 */
export const LEGACY_GSTACK_ID = "gstack";

export const LEGACY_GSTACK_MIGRATION_DIAGNOSTIC =
  'unsupported legacy configuration "gstack"; migrate to a supported framework before continuing';

export function isLegacyGstackId(value: unknown): value is typeof LEGACY_GSTACK_ID {
  return value === LEGACY_GSTACK_ID;
}
