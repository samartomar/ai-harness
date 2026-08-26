/**
 * Stable module boundary for the distributable policy-bundle contract. The
 * schema lives beside OrgPolicySchema so the active policy reader and the
 * standalone bundle validator cannot drift or form a circular dependency.
 */
export {
  type PolicyBundle,
  type PolicyBundleParse,
  PolicyBundleSchema,
  type PolicyRing,
  parsePolicyBundle,
} from "./schema.js";
