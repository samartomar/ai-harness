import { lstatSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";
import { assertExactKeysV1, assertRecordV1, failGovernanceDoctorV1 } from "./capability-v1.js";
import { GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1 } from "./repair-eligibility-v1.js";
import {
  assertGovernanceDoctorRepairPreconditionScopeV1,
  GOVERNANCE_DOCTOR_REPAIR_CANON_CONTEXT_RECIPE_V1,
} from "./repair-scope-v1.js";

/**
 * Whether the literal `ai-coding` name is free to create, asked without
 * following anything.
 *
 * ## Why the shipped checks cannot answer this
 *
 * `aih doctor` asks whether the canon is *reachable*, and answers with
 * `existsSync`. That is the right question for a diagnostic and the wrong one
 * for a repair, because `existsSync` returns `false` for at least three
 * different situations and a repair may proceed in only one of them:
 *
 * - the name is genuinely free;
 * - the name is taken by a link that resolves to nothing, which `existsSync`
 *   follows and reports as absent while `mkdir` refuses it as `EEXIST`;
 * - the lookup failed -- no permission, a parent that is not a directory, a link
 *   loop -- and nothing was learned at all.
 *
 * Treating the second and third as absence is how "path lookup failed" becomes
 * "the directory is missing, go create it". So absence is established here
 * rather than inherited: only `ENOENT`, only under a parent already proved to be
 * a real directory, and only while the root is still its own canonical self.
 *
 * ## The three verdicts
 *
 * `unoccupied` is the only verdict a repair may act on. `occupied` means the
 * name is taken by something -- a directory, a file, a live link, a dangling
 * link, a socket -- and this recipe creates rather than replaces, so it stops.
 * `indeterminate` means the question was not answered, and is deliberately a
 * separate verdict from `occupied`: collapsing them would be safe today, but it
 * would let a later reader believe a refusal proved something about the tree
 * when it proved only that the tree could not be read.
 *
 * Every failure mode lands in one of the two refusing verdicts. A permission
 * error, a transient failure, a malformed ancestry, a link at the root, a root
 * that no longer resolves to itself: all `indeterminate`. No branch reports
 * `unoccupied` on the strength of an error.
 *
 * ## What it deliberately is not
 *
 * It is not atomic and does not pretend to be. Three syscalls establish it and a
 * tree can change between any two of them, so a verdict describes the instant it
 * was taken. That is why a consumer re-observes immediately before spending a
 * claim and again at the effect boundary, and why custody re-proves the same
 * facts a third time under the mutation grant: this narrows the window, and
 * custody's own no-clobber sequence is what closes it.
 *
 * The rule is deliberately the same one custody applies -- `ENOENT` alone means
 * absent, every other error is unsafe, a symbolic link is never traversed.
 * Custody owns filesystem mutation and must not be imported by a
 * capability-light probe, so the rule is stated twice and a test pins that the
 * two verdicts agree over the same trees. Two implementations that must not
 * drift are worth one test; a probe that borrowed mutation capability to avoid
 * writing that test would not be.
 */
export type GovernanceDoctorRepairTargetOccupancyStateV1 =
  | "indeterminate"
  | "occupied"
  | "unoccupied";

export interface GovernanceDoctorRepairTargetOccupancyV1 {
  readonly protocol: "GovernanceDoctorRepairTargetOccupancyV1";
  readonly recipeId: "aih.repair.recipe.canon-context-dir-v1";
  readonly rootSha256: string;
  readonly state: GovernanceDoctorRepairTargetOccupancyStateV1;
  readonly targetPath: "ai-coding";
}

const PROTOCOL = "GovernanceDoctorRepairTargetOccupancyV1";

const OCCUPANCY_KEYS = ["protocol", "recipeId", "rootSha256", "state", "targetPath"] as const;

/** Anti-forgery brand: a hand-built look-alike is not an observation. */
const brands = new WeakSet<object>();

type EntryV1 = Stats | "absent" | "unreadable";

/**
 * One no-follow look at one path. `ENOENT` is the only error that means the name
 * is free; every other error means the answer is unknown, and is never quietly
 * turned into one.
 *
 * `throwIfNoEntry: false` is deliberately not used. It suppresses `ENOTDIR` as
 * well as `ENOENT` -- measured, not assumed -- so a path whose parent is a
 * regular file would come back `undefined` and read as absence. That is exactly
 * the conflation this module exists to prevent.
 */
function entryAt(path: string): EntryV1 {
  try {
    return lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
}

function inspect(root: string, rootIdentity: string): GovernanceDoctorRepairTargetOccupancyStateV1 {
  // The root has to be a real directory before `ENOENT` on a child below it
  // carries any meaning: under a file, a link, or an unreadable parent, the
  // child's lookup fails for a reason that is not absence.
  const parent = entryAt(root);
  if (parent === "absent" || parent === "unreadable") return "indeterminate";
  if (parent.isSymbolicLink() || !parent.isDirectory()) return "indeterminate";
  // And it has to still be the root the scope was minted against -- the same
  // object, not merely the same name. A canonical path proves the spelling; a
  // directory renamed away and replaced at that path passes every path-shaped
  // check while being something else entirely, so the identity is compared too.
  try {
    if (realpathSync.native(root) !== root) return "indeterminate";
    const stats = lstatSync(root, { bigint: true });
    if (stats.ino === 0n || `${stats.dev}:${stats.ino}` !== rootIdentity) return "indeterminate";
  } catch {
    return "indeterminate";
  }
  const target = entryAt(join(root, GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1));
  if (target === "unreadable") return "indeterminate";
  return target === "absent" ? "unoccupied" : "occupied";
}

/**
 * Observes the target under one branded scope. The brand is checked before any
 * syscall, so an unbranded scope buys no look at the filesystem, and the record
 * carries the scope's own root digest rather than its path.
 */
export function observeGovernanceDoctorRepairTargetOccupancyV1(
  scope: unknown,
): GovernanceDoctorRepairTargetOccupancyV1 {
  const bound = assertGovernanceDoctorRepairPreconditionScopeV1(scope);
  const record = Object.freeze({
    protocol: PROTOCOL,
    recipeId: GOVERNANCE_DOCTOR_REPAIR_CANON_CONTEXT_RECIPE_V1,
    rootSha256: bound.rootSha256,
    state: inspect(bound.rootRealPath, bound.rootIdentity),
    targetPath: bound.targetPath,
  }) as GovernanceDoctorRepairTargetOccupancyV1;
  brands.add(record);
  return record;
}

/** Accepts only a record this module observed. */
export function assertGovernanceDoctorRepairTargetOccupancyV1(
  value: unknown,
): GovernanceDoctorRepairTargetOccupancyV1 {
  const record = assertRecordV1(value, "repair target occupancy");
  assertExactKeysV1(record, OCCUPANCY_KEYS, "repair target occupancy");
  if (!brands.has(record)) failGovernanceDoctorV1("repair target occupancy is not AIH-owned");
  if (
    record.protocol !== PROTOCOL ||
    record.recipeId !== GOVERNANCE_DOCTOR_REPAIR_CANON_CONTEXT_RECIPE_V1 ||
    record.targetPath !== GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1
  )
    failGovernanceDoctorV1("repair target occupancy is malformed");
  return record as unknown as GovernanceDoctorRepairTargetOccupancyV1;
}
