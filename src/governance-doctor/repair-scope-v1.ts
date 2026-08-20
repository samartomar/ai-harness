import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { failGovernanceDoctorV1, governanceDoctorSha256V1 } from "./capability-v1.js";
import { governanceDoctorOperationalPlanContextV1 } from "./operational-v1.js";
import { GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1 } from "./repair-eligibility-v1.js";

/**
 * The trusted scope one repair precondition may be observed against.
 *
 * A resolved absolute path is a *format*, not an authority. A module that
 * accepts one has no way to know whether its caller established that root or
 * merely spelled it, so the string cannot be the thing that authorizes a live
 * filesystem observation. This record exists so the observation takes a binding
 * instead: it is minted only from a branded operational context, and it carries
 * the root, its digest, the one recipe it scopes, and that recipe's literal
 * target.
 *
 * ## What the brand does and does not establish
 *
 * The mint takes no path -- it reads the root out of the context, so there is no
 * parameter to redirect it through. Be exact about what that buys. The brand
 * proves the context passed through this package's own operational-context
 * constructor, which is to say that no config file, command option, environment
 * variable, JSON parse, or transported byte string is one. It does not prove
 * *who* built it: any in-package module could construct a context around a root
 * of its choosing, exactly as it could construct any other value this package
 * builds. `command-v1.ts` is the single production caller and builds it from the
 * CLI's own resolved context. A future consumer that reads the brand as proof of
 * provenance would be trusting more than this establishes.
 *
 * ## The two facts the mint does enforce
 *
 * The run's resolved context directory must be exactly {@link
 * GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1}. `--context-dir`,
 * `AIH_CONTEXT_DIR`, and a committed marker can each move a repository's canon
 * elsewhere, and this recipe's target is the literal `ai-coding` and nothing
 * else. A run pointed at a different directory would otherwise mint a scope
 * whose target has nothing to do with the canon that run is grading -- the probe
 * would find `ai-coding` absent and call it eligible while the repository's real
 * canon sits present and healthy under another name. This is checked first, so
 * such a run buys no filesystem call either. It is the same rule the repair
 * eligibility mint applies to a resolved directory, and like that one it says
 * nothing about the marker: proving a marker was read is the command boundary's
 * job, not a brand's.
 *
 * The root must be absolute and must be its own native canonical form, because a
 * spelling that merely reaches the checkout (a symlink, a case variant on a
 * case-insensitive volume, a trailing separator) would scope a repair to a path
 * the rest of the foundation would digest differently. Canonicality is
 * established at mint time; a scope is not a lease, so a consumer that will act
 * on one must revalidate against the live tree immediately before the effect.
 *
 * The precondition module deliberately cannot mint this. It consumes the brand
 * and refuses everything else, so an untrusted scope cannot enter a live probe
 * even when the probe's own output is branded -- a brand on the result never
 * repairs an unauthorized input.
 */
export const GOVERNANCE_DOCTOR_REPAIR_CANON_CONTEXT_RECIPE_V1 =
  "aih.repair.recipe.canon-context-dir-v1";

const PROTOCOL = "GovernanceDoctorRepairPreconditionScopeV1";
const SCOPE_DOMAIN = "aih.governance-doctor-repair-precondition-scope-v1";

export interface GovernanceDoctorRepairPreconditionScopeV1 {
  readonly protocol: "GovernanceDoctorRepairPreconditionScopeV1";
  readonly recipeId: "aih.repair.recipe.canon-context-dir-v1";
  /**
   * The filesystem identity of the root at mint time, as `dev:ino`. A canonical
   * path is not an identity: rename the directory away and create a fresh one at
   * the same path, and every path-shaped check still passes while the object
   * underneath is a different one. Consumers that re-observe the tree compare
   * this, so a run cannot silently continue against a replacement.
   *
   * The rule is custody's, including its refusal of an unusable inode.
   */
  readonly rootIdentity: string;
  readonly rootRealPath: string;
  readonly rootSha256: string;
  readonly targetPath: "ai-coding";
}

const brands = new WeakSet<object>();

/**
 * Mints the scope from the operational context this run already branded. It
 * accepts no root, no target, and no recipe: all three are code-owned, and the
 * first is read from the context rather than from a caller.
 */
export function mintGovernanceDoctorRepairPreconditionScopeV1(
  context: unknown,
): GovernanceDoctorRepairPreconditionScopeV1 {
  const ctx = governanceDoctorOperationalPlanContextV1(context);
  // Before the root is touched: a run whose canon lives elsewhere has no
  // business scoping a repair whose target is the literal `ai-coding`.
  if (ctx.contextDir !== GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1)
    failGovernanceDoctorV1("repair precondition scope requires the canonical context directory");
  const root = ctx.root;
  if (typeof root !== "string" || root.length === 0 || !isAbsolute(root))
    failGovernanceDoctorV1("repair precondition scope requires an absolute repository root");
  let canonical: string;
  try {
    canonical = realpathSync.native(root);
  } catch {
    return failGovernanceDoctorV1("repair precondition scope root cannot be resolved");
  }
  if (canonical !== root)
    failGovernanceDoctorV1("repair precondition scope root is not its own canonical form");
  let identity: string;
  try {
    const stats = lstatSync(canonical, { bigint: true });
    // A link or a non-directory is not a checkout root, and an inode of zero is
    // not an identity -- the platform is telling us it cannot distinguish this
    // object from another. Both refuse rather than bind to something unprovable.
    if (stats.isSymbolicLink() || !stats.isDirectory() || stats.ino === 0n)
      return failGovernanceDoctorV1("repair precondition scope root has no usable identity");
    identity = `${stats.dev}:${stats.ino}`;
  } catch {
    return failGovernanceDoctorV1("repair precondition scope root has no usable identity");
  }
  const record = Object.freeze({
    protocol: PROTOCOL,
    recipeId: GOVERNANCE_DOCTOR_REPAIR_CANON_CONTEXT_RECIPE_V1,
    rootIdentity: identity,
    rootRealPath: canonical,
    rootSha256: governanceDoctorSha256V1(SCOPE_DOMAIN, {
      contextDir: GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
      root: canonical,
    }),
    targetPath: GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
  }) as GovernanceDoctorRepairPreconditionScopeV1;
  brands.add(record);
  return record;
}

/**
 * Accepts only a minted scope. The brand is checked before anything reads it, so
 * a plain object, a string, a proxy, an accessor-bearing look-alike, a spread
 * copy, or a record reconstructed from these fields is refused before any
 * filesystem call is made on its behalf.
 */
export function assertGovernanceDoctorRepairPreconditionScopeV1(
  value: unknown,
): GovernanceDoctorRepairPreconditionScopeV1 {
  if (typeof value !== "object" || value === null || !brands.has(value))
    failGovernanceDoctorV1("repair precondition scope is not AIH-owned");
  const record = value as GovernanceDoctorRepairPreconditionScopeV1;
  if (
    record.protocol !== PROTOCOL ||
    record.recipeId !== GOVERNANCE_DOCTOR_REPAIR_CANON_CONTEXT_RECIPE_V1 ||
    record.targetPath !== GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1
  )
    failGovernanceDoctorV1("repair precondition scope is malformed");
  return record;
}
